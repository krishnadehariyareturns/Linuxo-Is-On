'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/lib/forensic-logger/core/config');
const {
    createWebhookTransport,
    categoryFor,
    resolveCategory,
    backoffDelay,
    extractRetryAfterMs,
} = require('../src/lib/forensic-logger/core/webhookTransport');

function testConfig(overrides = {}) {
    return loadConfig({
        webhook: {
            enabled: true, // Transport tests explicitly opt into delivery.
            batchSize: 10,
            flushIntervalMs: 100_000,
            retryLimit: 2,
            retryBaseMs: 1,
            retryCapMs: 5,
            maxQueueSize: 5,
            highWaterMark: 3,
            circuitBreakerThreshold: 2,
            circuitBreakerCooldownMs: 30,
            categories: {
                logs: 'https://example.com/logs',
                errors: 'https://example.com/errors',
                security: 'https://example.com/security',
                performance: '',
                debug: '',
            },
            ...overrides,
        },
    });
}

function record(level, event, extra = {}) {
    return { level, event, timestamp: new Date().toISOString(), message: 'test', ...extra };
}

function httpError(status, message = `HTTP ${status}`) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function netError(code, message = code) {
    const err = new Error(message);
    err.code = code;
    return err;
}

test('categoryFor and resolveCategory route and fall back accurately', () => {
    assert.equal(categoryFor(record('info', 'COMMAND_END')), 'logs');
    assert.equal(categoryFor(record('error', 'COMMAND_ERROR')), 'errors');
    assert.equal(categoryFor(record('fatal', 'BOT_CRASH')), 'errors');
    assert.equal(categoryFor(record('warn', 'COMMAND_PERMISSION_DENIED')), 'security');
    assert.equal(categoryFor(record('warn', 'SLOW_COMMAND')), 'performance');
    assert.equal(categoryFor(record('debug', 'CACHE_HIT')), 'debug');

    const fallbackCfg = testConfig({ categories: { logs: 'https://example.com/logs', errors: '', security: '', performance: '', debug: '' } });
    assert.equal(resolveCategory(record('error', 'COMMAND_ERROR'), fallbackCfg), 'logs');

    const emptyCfg = testConfig({ categories: { logs: '', errors: '', security: '', performance: '', debug: '' } });
    assert.equal(resolveCategory(record('info', 'COMMAND_END'), emptyCfg), null);
});

test('route(), batchSize gating, and component chunking work properly', async () => {
    const config = testConfig({ batchSize: 5, maxQueueSize: 100 });
    const calls = [];
    const transport = createWebhookTransport({
        config,
        sendFn: async (cat, payload) => { calls.push({ cat, count: payload.components.length }); },
    });

    assert.equal(transport.route(record('debug', 'COMMAND_START'), {}), null);

    for (let i = 0; i < 3; i++) transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs');
    assert.equal(calls.length, 0);

    for (let i = 0; i < 2; i++) transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].count, 5);

    calls.length = 0;
    for (let i = 0; i < 23; i++) transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs', { force: true });
    assert.deepEqual(calls.map((c) => c.count), [5, 5, 5, 5, 3]);
});

test('fails fast with zero retries on permanent 4xx errors (400, 401, 403, 404) without opening circuit breaker', async () => {
    for (const status of [400, 401, 403, 404]) {
        const config = testConfig({ retryLimit: 3, circuitBreakerThreshold: 1 });
        let attempts = 0;
        const failed = [];
        const logs = [];
        const transport = createWebhookTransport({
            config,
            sendFn: async () => {
                attempts++;
                throw httpError(status, `Client error ${status}`);
            },
            onDeliveryFailure: (cat, recs) => failed.push({ cat, recs }),
            onInternalLog: (level, message, data) => logs.push({ level, message, data }),
        });

        transport.route(record('info', 'COMMAND_END', { tag: status }), {});
        await transport.flush('logs', { force: true });

        assert.equal(attempts, 1, `HTTP ${status} must not be retried`);
        assert.equal(failed.length, 1, `HTTP ${status} must invoke onDeliveryFailure`);
        assert.equal(transport.getStats().logs.circuitOpen, false, `HTTP ${status} must not trip circuit breaker`);
        assert.ok(logs.some((l) => l.level === 'error' && l.message.includes('not retrying')));
    }
});

test('retries transient 429, 5xx, and network errors and recovers when a retry succeeds', async () => {
    const transientFactories = [
        () => httpError(429, 'Too Many Requests'),
        () => httpError(500, 'Internal Server Error'),
        () => httpError(503, 'Service Unavailable'),
        () => netError('ECONNRESET', 'socket hang up'),
        () => netError('ETIMEDOUT', 'timed out'),
    ];

    for (const makeErr of transientFactories) {
        const config = testConfig({ retryLimit: 3 });
        let attempts = 0;
        const transport = createWebhookTransport({
            config,
            sendFn: async () => {
                attempts++;
                if (attempts < 3) throw makeErr();
            },
        });

        transport.route(record('info', 'COMMAND_END'), {});
        await transport.flush('logs', { force: true });

        assert.equal(attempts, 3);
        assert.equal(transport.getStats().logs.queued, 0);
        assert.equal(transport.getStats().logs.circuitOpen, false);
    }
});

test('exhausting transient retries invokes onDeliveryFailure and opens the circuit breaker', async () => {
    const config = testConfig({ retryLimit: 1, circuitBreakerThreshold: 2, circuitBreakerCooldownMs: 30 });
    let attempts = 0;
    const failed = [];
    const transport = createWebhookTransport({
        config,
        sendFn: async () => {
            attempts++;
            throw httpError(503, 'upstream down');
        },
        onDeliveryFailure: (category, records) => failed.push({ category, records }),
    });

    transport.route(record('info', 'COMMAND_END', { guildId: 'g1' }), {});
    await transport.flush('logs', { force: true }); // 1 initial + 1 retry = 2 attempts, consecutiveFailures = 1
    assert.equal(attempts, 2);
    assert.equal(transport.getStats().logs.circuitOpen, false);

    transport.route(record('info', 'COMMAND_END', { guildId: 'g2' }), {});
    await transport.flush('logs', { force: true }); // +2 attempts = 4, consecutiveFailures = 2 -> circuit opens
    assert.equal(attempts, 4);
    assert.equal(failed.length, 2);
    assert.equal(failed[0].records[0].guildId, 'g1');
    assert.equal(transport.getStats().logs.circuitOpen, true);

    // Non-forced flush skips sendFn while circuit is open.
    transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs');
    assert.equal(attempts, 4);
});

test('circuit closes again after a successful send once cooldown has elapsed', async () => {
    const config = testConfig({ retryLimit: 0, circuitBreakerThreshold: 1, circuitBreakerCooldownMs: 20 });
    let shouldFail = true;
    const transport = createWebhookTransport({
        config,
        sendFn: async () => { if (shouldFail) throw netError('ECONNRESET'); },
    });

    transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs', { force: true });
    assert.equal(transport.getStats().logs.circuitOpen, true);

    shouldFail = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs', { force: true });
    assert.equal(transport.getStats().logs.circuitOpen, false);
});

test('respects Discord retryAfter rate-limit hints', async () => {
    const config = testConfig({ retryLimit: 2 });
    const internalLogs = [];
    let attempts = 0;
    const transport = createWebhookTransport({
        config,
        sendFn: async () => {
            attempts++;
            if (attempts === 1) {
                const err = httpError(429, 'rate limited');
                err.retryAfter = 5;
                throw err;
            }
        },
        onInternalLog: (level, message, data) => internalLogs.push({ level, message, data }),
    });

    transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs', { force: true });

    const retryLog = internalLogs.find((l) => l.message.includes('retrying'));
    assert.ok(retryLog);
    assert.equal(retryLog.data.rateLimited, true);
    assert.equal(retryLog.data.delayMs, 5);
});

test('backpressure drops oldest entries and flushAll force-drains all categories', async () => {
    const bpConfig = testConfig({ maxQueueSize: 3 });
    const bpTransport = createWebhookTransport({ config: bpConfig, sendFn: async () => {} });
    for (let i = 0; i < 6; i++) bpTransport.route(record('info', 'COMMAND_END', { i }), {});
    assert.equal(bpTransport.getStats().logs.queued, 3);
    assert.equal(bpTransport.getStats().logs.dropped, 3);

    const drainConfig = testConfig({ batchSize: 100, flushIntervalMs: 100_000 });
    const sent = [];
    const drainTransport = createWebhookTransport({ config: drainConfig, sendFn: async (cat) => { sent.push(cat); } });
    drainTransport.route(record('info', 'COMMAND_END'), {});
    drainTransport.route(record('error', 'COMMAND_ERROR'), {});
    drainTransport.route(record('warn', 'COMMAND_PERMISSION_DENIED'), {});
    await drainTransport.flushAll({ timeoutMs: 2000 });
    assert.ok(sent.includes('logs') && sent.includes('errors') && sent.includes('security'));
});

test('deletes expired webhook messages and keeps retryable failures in the retention index', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linuxo-webhook-retention-'));
    const filePath = path.join(dir, 'retention.json');
    const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(filePath, JSON.stringify([{ category: 'logs', id: 'expired-1', createdAt: old }, { category: 'logs', id: 'expired-2', createdAt: old }]));
    const config = loadConfig({ retention: { enabled: true, days: 14, file: filePath } });
    const attempts = [];
    const transport = createWebhookTransport({
        config,
        sendFn: async () => {},
        deleteMessageFn: async (category, id) => { attempts.push(id); if (id === 'expired-2') throw new Error('temporary outage'); },
    });
    const result = await transport.cleanupExpiredMessages();
    assert.equal(result.deleted, 1);
    assert.equal(result.pending, 1);
    assert.deepEqual(attempts, ['expired-1', 'expired-2']);
    const remaining = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepEqual(remaining.map((entry) => entry.id), ['expired-2']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('backoffDelay and extractRetryAfterMs handle common shapes', () => {
    const opts = { retryBaseMs: 100, retryCapMs: 1000 };
    assert.ok(backoffDelay(1, opts) >= 100 && backoffDelay(1, opts) <= 120);
    assert.ok(backoffDelay(2, opts) >= 200 && backoffDelay(2, opts) <= 240);
    assert.ok(backoffDelay(5, opts) <= 1200);

    assert.equal(extractRetryAfterMs({ retryAfter: 1500 }), 1500);
    assert.equal(extractRetryAfterMs({ retry_after: 2 }), 2000);
    assert.equal(extractRetryAfterMs({ rawError: { retry_after: 3 } }), 3000);
    assert.equal(extractRetryAfterMs({ data: { retry_after: 0.5 } }), 500);
    assert.equal(extractRetryAfterMs({}), null);
});
