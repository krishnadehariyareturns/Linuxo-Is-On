'use strict';

const path = require('node:path');

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
    if (!isPlainObject(override)) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) {
        out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
    }
    return out;
}

function envBool(value, fallback) {
    if (value === undefined || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function envInt(value, fallback, { min = 0 } = {}) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < min) return fallback;
    return n;
}

/**
 * Builds the logger's configuration. Reads sane defaults from environment
 * variables (see .env.example) and layers any explicit `overrides` object
 * passed at logger-creation time on top — so a developer can tune behavior
 * in code without needing a new env var for every knob.
 */
function loadConfig(overrides = {}) {
    const env = process.env;
    const environment = env.NODE_ENV || 'development';
    const isProd = environment === 'production';

    const defaults = {
        environment,
        level: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
        botVersion: env.npm_package_version || '0.0.0',

        console: envBool(env.LOG_CONSOLE, true),
        // false = pretty/boxed output (dev-friendly); true = single-line JSON
        // on stdout (machine-friendly, good for container log scraping).
        json: envBool(env.LOG_JSON, isProd),
        // Optional path to also append every record as a JSON line to disk,
        // independent of the console format above.
        file: env.LOG_FILE || null,

        webhook: {
            enabled: envBool(env.LOG_WEBHOOK_ENABLED, true),
            batchSize: envInt(env.LOG_WEBHOOK_BATCH_SIZE, 10, { min: 1 }),
            flushIntervalMs: envInt(env.LOG_WEBHOOK_FLUSH_MS, 1000, { min: 0 }),
            retryLimit: envInt(env.LOG_WEBHOOK_RETRY_LIMIT, 5, { min: 0 }),
            retryBaseMs: envInt(env.LOG_WEBHOOK_RETRY_BASE_MS, 500, { min: 1 }),
            retryCapMs: envInt(env.LOG_WEBHOOK_RETRY_CAP_MS, 30_000, { min: 1 }),
            maxQueueSize: envInt(env.LOG_WEBHOOK_MAX_QUEUE, 500, { min: 1 }),
            highWaterMark: envInt(env.LOG_WEBHOOK_HIGH_WATER, 200, { min: 1 }),
            circuitBreakerThreshold: envInt(env.LOG_WEBHOOK_CIRCUIT_THRESHOLD, 5, { min: 1 }),
            circuitBreakerCooldownMs: envInt(env.LOG_WEBHOOK_CIRCUIT_COOLDOWN_MS, 30_000, { min: 1 }),
            categories: {
                logs: env.LOG_WEBHOOK_LOGS || '',
                errors: env.LOG_WEBHOOK_ERRORS || '',
                security: env.LOG_WEBHOOK_SECURITY || '',
                performance: env.LOG_WEBHOOK_PERFORMANCE || '',
                debug: env.LOG_WEBHOOK_DEBUG || '',
            },
            // Each category's own floor, independent of the global `level`.
            minLevels: {
                logs: 'info',
                errors: 'error',
                security: 'warn',
                performance: 'warn',
                debug: 'trace',
            },
        },

        performance: {
            slowCommandMs: envInt(env.LOG_SLOW_COMMAND_MS, 1000, { min: 1 }),
            warnCommandMs: envInt(env.LOG_WARN_COMMAND_MS, 500, { min: 1 }),
            includeMemory: envBool(env.LOG_INCLUDE_MEMORY, true),
            memorySampleIntervalMs: envInt(env.LOG_MEMORY_SAMPLE_MS, 5 * 60_000, { min: 1000 }),
            // 0 disables the periodic rollup summary.
            summaryIntervalMs: envInt(env.LOG_SUMMARY_INTERVAL_MS, 0, { min: 0 }),
            // Per-command overrides, e.g. { backup: { warnMs: 5000, slowMs: 15000 } }
            perCommandThresholds: {},
        },

        redaction: {
            enabled: envBool(env.LOG_REDACTION_ENABLED, true),
            extraKeys: [],
            maxStringLength: envInt(env.LOG_MAX_STRING_LENGTH, 500, { min: 0 }),
            maxStackLength: envInt(env.LOG_MAX_STACK_LENGTH, 4096, { min: 0 }),
        },

        retention: {
            enabled: envBool(env.LOG_RETENTION_ENABLED, true),
            days: envInt(env.LOG_RETENTION_DAYS, 14, { min: 1 }),
            file: env.LOG_RETENTION_FILE || path.join(process.cwd(), 'data', 'log-retention.json'),
        },

        dedup: {
            windowMs: envInt(env.LOG_DEDUP_WINDOW_MS, 60_000, { min: 0 }),
            maxEntries: envInt(env.LOG_DEDUP_MAX_ENTRIES, 1000, { min: 1 }),
        },

        statsWindowSize: envInt(env.LOG_STATS_WINDOW_SIZE, 500, { min: 1 }),
        statsMaxCommands: envInt(env.LOG_STATS_MAX_COMMANDS, 200, { min: 1 }),
    };

    return deepMerge(defaults, overrides);
}

/** Per-command duration thresholds, falling back to the global defaults. */
function thresholdsFor(config, command) {
    const override = config.performance.perCommandThresholds?.[command];
    return {
        warnMs: override?.warnMs ?? config.performance.warnCommandMs,
        slowMs: override?.slowMs ?? config.performance.slowCommandMs,
    };
}

module.exports = { loadConfig, deepMerge, thresholdsFor };
