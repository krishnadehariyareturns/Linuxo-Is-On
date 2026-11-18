'use strict';

const { SECURITY_EVENTS, PERFORMANCE_EVENTS } = require('./eventNames');
const { isEnabled } = require('./levels');
const { isRetryable, extractHttpStatus } = require('./errors');
const { scrubString } = require('./redact');
const { createRetentionStore } = require('./retention');

const CATEGORIES = ['logs', 'errors', 'security', 'performance', 'debug'];

// If a record's primary category has no webhook URL configured, try the
// next one in its chain before giving up on Discord delivery entirely.
// `debug` and `logs` don't fall back further — debug being unconfigured is
// usually intentional (verbose/dev-only), and `logs` is already the base.
const FALLBACK_CHAIN = {
    errors: ['errors', 'logs'],
    security: ['security', 'logs'],
    performance: ['performance', 'logs'],
    debug: ['debug'],
    logs: ['logs'],
};

// Discord allows up to 40 total components per Components v2 message, and each
// log container nests up to 3 sub-components, so 5 containers stays safely under.
const DISCORD_COMPONENTS_PER_MESSAGE = 5;

// Discord's IS_COMPONENTS_V2 message flag (1 << 15 = 32768).
const IS_COMPONENTS_V2 = 1 << 15;

function categoryFor(record) {
    if (SECURITY_EVENTS.has(record.event)) return 'security';
    if (PERFORMANCE_EVENTS.has(record.event)) return 'performance';
    if (record.level === 'error' || record.level === 'fatal') return 'errors';
    if (record.level === 'debug' || record.level === 'trace') return 'debug';
    return 'logs';
}

function resolveCategory(record, config) {
    const primary = record.category || categoryFor(record);
    const chain = FALLBACK_CHAIN[primary] || [primary];
    for (const cat of chain) {
        if (config.webhook.categories[cat]) return cat;
    }
    return null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt, { retryBaseMs, retryCapMs }) {
    const exp = Math.min(retryCapMs, retryBaseMs * 2 ** (attempt - 1));
    const jitter = Math.random() * exp * 0.2;
    return Math.round(exp + jitter);
}

/**
 * Defensive extraction of a Discord-provided retry_after (ms), if present.
 * `.retryAfter` is @discordjs/rest's own convenience field and is already
 * milliseconds; `retry_after` (snake_case, possibly nested under a raw
 * error body) is Discord's raw API field and is always in seconds.
 */
function extractRetryAfterMs(err) {
    if (typeof err?.retryAfter === 'number' && Number.isFinite(err.retryAfter) && err.retryAfter >= 0) {
        return err.retryAfter;
    }
    const secondsCandidates = [err?.retry_after, err?.rawError?.retry_after, err?.data?.retry_after];
    for (const c of secondsCandidates) {
        if (typeof c === 'number' && Number.isFinite(c) && c >= 0) return Math.round(c * 1000);
    }
    return null;
}

/**
 * Classify whether a failed webhook send should be retried.
 * Retries explicit rate-limit responses (retryAfter/retry_after), retryable HTTP
 * statuses (408, 425, 429, 5xx), and transient network/socket/timeout failures.
 * Fails fast on permanent 4xx client errors (400, 401, 403, 404, etc.) and
 * non-transient errors.
 */
function shouldRetryDelivery(err) {
    const httpStatus = extractHttpStatus(err);
    const retryAfterMs = extractRetryAfterMs(err);
    if (retryAfterMs !== null) {
        // Explicit rate-limit hint is retryable unless paired with a non-429 permanent 4xx.
        if (httpStatus === undefined || httpStatus === 429 || isRetryable(err, httpStatus)) {
            return { retryable: true, httpStatus, retryAfterMs };
        }
    }
    return {
        retryable: isRetryable(err, httpStatus),
        httpStatus,
        retryAfterMs: null,
    };
}

function safeErrorMessage(err) {
    return err?.message ? scrubString(String(err.message)) : 'unknown error';
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

/**
 * Default production sendFn: lazily creates one discord.js WebhookClient per
 * configured category and posts Components v2 containers through it.
 */
function createDefaultSender(config) {
    const clients = new Map();

    function clientFor(category) {
        if (clients.has(category)) return clients.get(category);
        const url = config.webhook.categories[category];
        if (!url) return null;
        // eslint-disable-next-line global-require
        const { WebhookClient } = require('discord.js');
        const client = new WebhookClient({ url });
        clients.set(category, client);
        return client;
    }

    async function send(category, payload) {
        const client = clientFor(category);
        if (!client) throw new Error(`No webhook URL configured for category "${category}"`);
        return client.send({ ...payload, wait: true });
    }

    async function deleteMessage(category, messageId) {
        const client = clientFor(category);
        if (!client) throw new Error('No webhook URL configured for category ' + category);
        return client.deleteMessage(messageId);
    }

    function destroy() {
        for (const client of clients.values()) {
            try {
                client.destroy?.();
            } catch {
                /* ignore cleanup error */
            }
        }
        clients.clear();
    }

    return { send, deleteMessage, destroy };
}

/**
 * @param {object} opts
 * @param {object} opts.config - full logger config (see config.js)
 * @param {function} [opts.sendFn] - async (category, {components, flags}) => void. Defaults to a real discord.js WebhookClient sender. Inject a fake for tests.
 * @param {function} [opts.onInternalLog] - (level, message, data) => void. Console-only transport diagnostics.
 * @param {function} [opts.onDeliveryFailure] - (category, records) => void. Called when delivery permanently fails or exhausts retries.
 * @param {function} [opts.deleteMessageFn] - Test seam for deleting an expired webhook message.
 */
function createWebhookTransport({ config, sendFn, onInternalLog, onDeliveryFailure, deleteMessageFn } = {}) {
    const defaultSender = sendFn ? null : createDefaultSender(config);
    const send = sendFn || defaultSender.send;
    const retention = config.retention?.enabled
        ? createRetentionStore({ filePath: config.retention.file, retentionDays: config.retention.days })
        : null;
    const log = onInternalLog || (() => {});
    const deliveryFailure = onDeliveryFailure || (() => {});

    const state = {};
    for (const cat of CATEGORIES) {
        state[cat] = {
            queue: [],
            consecutiveFailures: 0,
            circuitOpenUntil: 0,
            droppedCount: 0,
            highWaterWarned: false,
            lastBackpressureWarnAt: 0,
        };
    }

    function isCircuitOpen(cat) {
        return state[cat].circuitOpenUntil > Date.now();
    }

    /** Route one record (+ its prebuilt Components v2 container) into the right category's queue. */
    function route(record, component) {
        if (!config.webhook.enabled) return null;
        const category = resolveCategory(record, config);
        if (!category) return null;
        if (!isEnabled(config.webhook.minLevels[category], record.level)) return null;

        enqueue(category, { component, record, addedAt: Date.now() });
        return category;
    }

    function enqueue(category, job) {
        const s = state[category];
        s.queue.push(job);

        if (s.queue.length > config.webhook.maxQueueSize) {
            s.queue.shift();
            s.droppedCount++;
            const now = Date.now();
            if (now - s.lastBackpressureWarnAt > 10_000) {
                s.lastBackpressureWarnAt = now;
                log('warn', `webhook queue for "${category}" exceeded maxQueueSize; dropping oldest entries`, {
                    category,
                    maxQueueSize: config.webhook.maxQueueSize,
                    droppedCount: s.droppedCount,
                });
            }
        }

        if (s.queue.length >= config.webhook.highWaterMark && !s.highWaterWarned) {
            s.highWaterWarned = true;
            log('warn', `webhook queue for "${category}" crossed high-water mark`, {
                category,
                queued: s.queue.length,
                highWaterMark: config.webhook.highWaterMark,
            });
        } else if (s.queue.length < config.webhook.highWaterMark / 2) {
            s.highWaterWarned = false;
        }
    }

    /**
     * Attempt delivery of one chunk with transient-only retry + backoff.
     * Permanent 4xx and non-retryable failures fail fast without retrying or
     * tripping the transient-outage circuit breaker.
     */
    async function sendChunkWithRetry(category, jobs) {
        const s = state[category];
        const maxRetries = config.webhook.retryLimit;
        let attempt = 0;

        while (attempt <= maxRetries) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const sent = await send(category, { components: jobs.map((j) => j.component), flags: IS_COMPONENTS_V2 });
                if (retention && sent?.id) retention.add(category, sent.id);
                s.consecutiveFailures = 0;
                if (s.circuitOpenUntil) {
                    s.circuitOpenUntil = 0;
                    log('info', `webhook circuit closed for "${category}"`, { category });
                }
                log('debug', `delivered ${jobs.length} record(s) to "${category}"`, { category, count: jobs.length });
                return { ok: true };
            } catch (err) {
                const { retryable, httpStatus, retryAfterMs } = shouldRetryDelivery(err);
                const errMessage = safeErrorMessage(err);

                if (!retryable) {
                    log('error', `webhook send to "${category}" failed with permanent/non-retryable error; not retrying`, {
                        category,
                        httpStatus,
                        code: err?.code,
                        error: errMessage,
                    });
                    deliveryFailure(category, jobs.map((j) => j.record));
                    return { ok: false, permanent: true };
                }

                attempt++;
                const isLast = attempt > maxRetries;
                if (!isLast) {
                    const delay = retryAfterMs ?? backoffDelay(attempt, config.webhook);
                    log('warn', `webhook send to "${category}" failed transiently, retrying`, {
                        category,
                        attempt,
                        maxAttempts: maxRetries,
                        delayMs: delay,
                        httpStatus,
                        code: err?.code,
                        rateLimited: retryAfterMs !== null || httpStatus === 429,
                        error: errMessage,
                    });
                    // eslint-disable-next-line no-await-in-loop
                    await sleep(delay);
                    continue;
                }

                s.consecutiveFailures++;
                log('error', `webhook send to "${category}" failed after ${maxRetries} retries`, {
                    category,
                    httpStatus,
                    code: err?.code,
                    error: errMessage,
                    consecutiveFailures: s.consecutiveFailures,
                });

                if (s.consecutiveFailures >= config.webhook.circuitBreakerThreshold && !isCircuitOpen(category)) {
                    s.circuitOpenUntil = Date.now() + config.webhook.circuitBreakerCooldownMs;
                    log('error', `webhook circuit opened for "${category}" after repeated transient failures`, {
                        category,
                        cooldownMs: config.webhook.circuitBreakerCooldownMs,
                    });
                }

                deliveryFailure(category, jobs.map((j) => j.record));
                return { ok: false, permanent: false };
            }
        }
        return { ok: false, permanent: false };
    }

    const inFlight = new Set();

    /** Flush one category. `force` bypasses the batch-size/interval/circuit gating (used at shutdown). */
    async function flush(category, { force = false } = {}) {
        const s = state[category];
        if (!s.queue.length) return;
        if (isCircuitOpen(category) && !force) return;

        const oldestAge = Date.now() - s.queue[0].addedAt;
        const dueByTime = oldestAge >= config.webhook.flushIntervalMs;
        const dueBySize = s.queue.length >= config.webhook.batchSize;
        if (!force && !dueByTime && !dueBySize) return;

        const takeCount = force ? s.queue.length : config.webhook.batchSize;
        const batch = s.queue.splice(0, takeCount);

        const task = (async () => {
            for (const jobs of chunk(batch, DISCORD_COMPONENTS_PER_MESSAGE)) {
                // eslint-disable-next-line no-await-in-loop
                await sendChunkWithRetry(category, jobs);
            }
        })();
        inFlight.add(task);
        try {
            await task;
        } finally {
            inFlight.delete(task);
        }
    }

    let lastRetentionSweep = 0;
    async function cleanupExpiredMessages() {
        if (!retention) return { deleted: 0, pending: 0 };
        let deleted = 0;
        for (const entry of retention.dueEntries()) {
            try {
                if (deleteMessageFn) await deleteMessageFn(entry.category, entry.id);
                else if (defaultSender) await defaultSender.deleteMessage(entry.category, entry.id);
                else break;
                retention.remove(entry);
                deleted++;
            } catch (err) {
                const code = err?.code ?? err?.rawError?.code;
                if (code === 10008) { retention.remove(entry); deleted++; }
                else log('warn', 'could not delete an expired webhook log message; will retry later', { category: entry.category, code, error: safeErrorMessage(err) });
            }
        }
        return { deleted, pending: retention.dueEntries().length };
    }

    /** Called on an interval by core.js to drive normal batching and retention. */
    async function tick() {
        await Promise.all(CATEGORIES.map((cat) => flush(cat)));
        if (retention && Date.now() - lastRetentionSweep >= 60 * 60 * 1000) {
            lastRetentionSweep = Date.now();
            await cleanupExpiredMessages();
        }
    }

    /** Best-effort drain of everything queued and in-flight, bounded by timeoutMs. */
    async function flushAll({ timeoutMs = 5000 } = {}) {
        let timer = null;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs);
            timer.unref?.();
        });
        const drain = (async () => {
            await Promise.all(CATEGORIES.map((cat) => flush(cat, { force: true })));
            if (inFlight.size > 0) {
                await Promise.allSettled([...inFlight]);
            }
            return 'done';
        })();
        try {
            return await Promise.race([drain, timeout]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    function destroy() {
        defaultSender?.destroy();
    }

    function getStats() {
        const out = {};
        for (const cat of CATEGORIES) {
            const s = state[cat];
            out[cat] = {
                queued: s.queue.length,
                circuitOpen: isCircuitOpen(cat),
                consecutiveFailures: s.consecutiveFailures,
                dropped: s.droppedCount,
                configured: Boolean(config.webhook.categories[cat]),
            };
        }
        return out;
    }

    return { route, tick, flush, flushAll, cleanupExpiredMessages, destroy, getStats, CATEGORIES };
}

module.exports = {
    createWebhookTransport,
    categoryFor,
    resolveCategory,
    backoffDelay,
    extractRetryAfterMs,
    shouldRetryDelivery,
    CATEGORIES,
};
