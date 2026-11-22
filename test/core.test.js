'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const loggerPkg = require('../src/lib/forensic-logger');
const { createLogger } = require('../src/lib/forensic-logger/core/core');
const { Events } = require('../src/lib/forensic-logger/core/eventNames');
const { buildLogComponent } = require('../src/lib/forensic-logger/core/components');

function fakeComponent(record) {
    return { __fake: true, record };
}

function makeLogger(overrides = {}) {
    const sent = [];
    const logger = createLogger({
        console: false,
        webhook: {
            enabled: true,
            flushIntervalMs: 0,
            batchSize: 1,
            retryLimit: 0,
            categories: {
                logs: 'https://example.com/logs',
                errors: 'https://example.com/errors',
                security: 'https://example.com/security',
                performance: 'https://example.com/performance',
                debug: 'https://example.com/debug',
            },
        },
        sendFn: async (category, payload) => { sent.push({ category, payload }); },
        buildComponentFn: fakeComponent,
        ...overrides,
    });
    return { logger, sent };
}

function recordsIn(sent) {
    return sent.flatMap((s) => s.payload.components.map((component) => ({ category: s.category, ...component.record })));
}

test('logger package exposes no investigate, forensics, or AI summarizer surfaces', () => {
    assert.equal(loggerPkg.investigateCommand, undefined);
    assert.equal(loggerPkg.ForensicsStore, undefined);
    assert.equal(loggerPkg.semanticSignature, undefined);
    assert.equal(loggerPkg.summarizeRootCause, undefined);
    assert.equal(loggerPkg.buildPrompt, undefined);
    assert.equal(loggerPkg.callOpenRouter, undefined);

    const { logger } = makeLogger({ webhook: { enabled: false } });
    assert.equal(logger.forensics, undefined);
    assert.equal(logger.investigate, undefined);
    assert.equal(logger.getTimeline, undefined);
    assert.equal(logger.getTrends, undefined);
    assert.equal(logger.filterLogs, undefined);
    assert.equal(logger.searchLogs, undefined);
    assert.equal(logger.getInteractionTimeline, undefined);
    assert.equal(logger.enableDebugMode, undefined);
    logger.stopBackgroundTasks();
});

test('two logger instances preserve independent botVersion metadata only', async () => {
    const a = makeLogger({ botVersion: '1.0.0', shardId: 0 });
    const b = makeLogger({ botVersion: '2.0.0', shardId: 3 });

    a.logger.info('EVENT_A', a.logger.fromInteraction(null, { guildId: 'g-a' }));
    b.logger.info('EVENT_B', b.logger.fromInteraction(null, { guildId: 'g-b' }));
    await a.logger.flushAll({ timeoutMs: 1000 });
    await b.logger.flushAll({ timeoutMs: 1000 });

    const [recA] = recordsIn(a.sent);
    const [recB] = recordsIn(b.sent);
    assert.equal(recA.botVersion, '1.0.0');
    assert.equal(recA.shardId, undefined);
    assert.equal(recB.botVersion, '2.0.0');
    assert.equal(recB.shardId, undefined);
    assert.equal(recA.traceId, undefined);
    assert.equal(recA.requestId, undefined);

    await a.logger.close();
    await b.logger.close();
});

test('the global level floor suppresses lower-severity calls before anything else happens', async () => {
    const { logger, sent } = makeLogger({ level: 'warn' });
    logger.debug('SOME_DEBUG_EVENT', {});
    logger.info('SOME_INFO_EVENT', {});
    logger.warn('SOME_WARN_EVENT', {});
    await logger.flushAll({ timeoutMs: 1000 });

    const events = recordsIn(sent).map((r) => r.event);
    assert.ok(!events.includes('SOME_DEBUG_EVENT'));
    assert.ok(!events.includes('SOME_INFO_EVENT'));
    assert.ok(events.includes('SOME_WARN_EVENT'));
    await logger.close();
});

test('redaction scrubs sensitive keys and embedded string secrets before reaching webhooks', async () => {
    const { logger, sent } = makeLogger();
    const fakeHook = `https://discord.com/api/webhooks/123456789012345678/${'a'.repeat(40)}`;
    logger.info('LOGIN_ATTEMPT', {
        token: 'hidden-value',
        author: 'alice',
        guildId: 'g1',
    }, {
        message: `Webhook failed at ${fakeHook} for interaction 987654321098765432`,
    });
    await logger.flushAll({ timeoutMs: 1000 });

    const [record] = recordsIn(sent);
    assert.equal(record.token, '[REDACTED]');
    assert.equal(record.author, 'alice');
    assert.equal(record.guildId, undefined, 'unneeded identity fields are omitted entirely');
    assert.ok(!record.message.includes(fakeHook));
    assert.ok(record.message.includes('[REDACTED]'));
    assert.ok(!record.message.includes('987654321098765432'));
    await logger.close();
});

test('runtime redaction cannot be disabled by mutating logger config', async () => {
    const { logger, sent } = makeLogger({ redaction: { enabled: false } });
    logger.config.redaction.enabled = false;
    logger.info('PRIVACY_CHECK', { token: 'never-log-this', userId: 'user-secret' });
    await logger.flushAll({ timeoutMs: 1000 });

    const [record] = recordsIn(sent);
    assert.equal(record.token, '[REDACTED]');
    assert.equal(record.userId, undefined);
    await logger.close();
});

test('command() returns the handler result and records success stats without log IDs', async () => {
    const { logger } = makeLogger();
    const result = await logger.command('startup', { guildId: 'g1' }, async () => 'ok');
    assert.equal(result, 'ok');

    const snap = logger.getStatsSnapshot();
    assert.equal(snap.totalExecuted, 1);
    assert.equal(snap.totalSucceeded, 1);
    assert.equal(snap.slowestCommand.traceId, undefined);
    await logger.close();
});

test('command() re-throws the exact original error and records failure stats', async () => {
    const { logger } = makeLogger();
    const originalErr = new Error('boom');

    await assert.rejects(
        logger.command('startup', {}, async () => { throw originalErr; }),
        (err) => err === originalErr,
    );

    const snap = logger.getStatsSnapshot();
    assert.equal(snap.totalFailed, 1);
    await logger.close();
});

test('command() emits COMMAND_START then COMMAND_END on success, in order', async () => {
    const { logger, sent } = makeLogger();
    await logger.command('startup', {}, async () => {});
    await logger.flushAll({ timeoutMs: 1000 });

    const events = recordsIn(sent).map((r) => r.event);
    assert.deepEqual(events, [Events.COMMAND_START, Events.COMMAND_END]);
    await logger.close();
});

test('command() emits COMMAND_START then COMMAND_ERROR on failure, in order', async () => {
    const { logger, sent } = makeLogger();
    await assert.rejects(logger.command('startup', {}, async () => { throw new Error('x'); }));
    await logger.flushAll({ timeoutMs: 1000 });

    const events = recordsIn(sent).map((r) => r.event);
    assert.deepEqual(events, [Events.COMMAND_START, Events.COMMAND_ERROR]);
    await logger.close();
});

test('a command exceeding the slow threshold escalates to warn and emits SLOW_COMMAND to performance', async () => {
    const { logger, sent } = makeLogger({ performance: { warnCommandMs: 1, slowCommandMs: 1 } });
    await logger.command('backup', {}, async () => new Promise((resolve) => setTimeout(resolve, 15)));
    await logger.flushAll({ timeoutMs: 1000 });

    const records = recordsIn(sent);
    const slow = records.find((r) => r.event === Events.SLOW_COMMAND);
    const end = records.find((r) => r.event === Events.COMMAND_END);
    assert.ok(slow, 'expected a SLOW_COMMAND record');
    assert.equal(slow.category, 'performance');
    assert.equal(end.level, 'warn');
    await logger.close();
});

test('a fast command stays at info level with no SLOW_COMMAND event', async () => {
    const { logger, sent } = makeLogger({ performance: { warnCommandMs: 5000, slowCommandMs: 10000 } });
    await logger.command('startup', {}, async () => {});
    await logger.flushAll({ timeoutMs: 1000 });

    const records = recordsIn(sent);
    assert.ok(!records.some((r) => r.event === Events.SLOW_COMMAND));
    assert.equal(records.find((r) => r.event === Events.COMMAND_END).level, 'info');
    await logger.close();
});

test('button() wraps a component handler with its own lifecycle events', async () => {
    const { logger, sent } = makeLogger();
    const result = await logger.button('confirm_btn', {}, async () => 'handled');
    assert.equal(result, 'handled');
    await logger.flushAll({ timeoutMs: 1000 });

    const events = recordsIn(sent).map((r) => r.event);
    assert.deepEqual(events, [Events.BUTTON_START, Events.BUTTON_END]);
    await logger.close();
});

test('task() failures reach the configured errors webhook', async () => {
    const { logger, sent } = makeLogger({
        webhook: {
            categories: {
                logs: '',
                errors: 'https://example.com/errors',
                security: '',
                performance: '',
                debug: '',
            },
        },
    });
    const originalError = new Error('database unavailable');

    await assert.rejects(
        logger.task({
            event: Events.DATABASE_QUERY,
            errorEvent: Events.DATABASE_ERROR,
            context: {},
            handler: async () => { throw originalError; },
        }),
        (err) => err === originalError,
    );

    await logger.flushAll({ timeoutMs: 1000 });
    const failure = recordsIn(sent).find((record) => record.event === Events.DATABASE_ERROR);
    assert.ok(failure, 'expected task failure to be delivered to the errors webhook');
    assert.equal(failure.category, 'errors');
    assert.equal(failure.level, 'error');
    await logger.close();
});

test('contextFor(interaction) exposes a mutable metrics object that flows into COMMAND_END', async () => {
    const { logger, sent } = makeLogger();
    const fakeInteraction = {};

    await logger.command('stats', { interaction: fakeInteraction }, async () => {
        const ctx = logger.contextFor(fakeInteraction);
        assert.ok(ctx);
        ctx.metrics.apiCalls = 3;
        ctx.metrics.cache = 'HIT';
    });

    assert.equal(logger.contextFor(fakeInteraction), undefined);

    await logger.flushAll({ timeoutMs: 1000 });
    const end = recordsIn(sent).find((r) => r.event === Events.COMMAND_END);
    assert.equal(end.apiCalls, 3);
    assert.equal(end.cacheStatus, 'HIT');
    await logger.close();
});

test('error dedup avoids guild-specific tracking and suppresses repeated command errors globally', async () => {
    const { logger, sent } = makeLogger({ dedup: { windowMs: 60_000 } });
    const err = new Error('recurring failure');

    logger.error('COMMAND_ERROR', { command: 'startup', guildId: 'guild-a' }, err);
    logger.error('COMMAND_ERROR', { command: 'startup', guildId: 'guild-a' }, err);
    logger.error('COMMAND_ERROR', { command: 'startup', guildId: 'guild-b' }, err);
    await logger.flushAll({ timeoutMs: 1000 });

    const errorRecords = recordsIn(sent).filter((r) => r.category === 'errors');
    assert.equal(errorRecords.length, 1, 'the same command error is deduplicated without guild identity');
    assert.ok(!JSON.stringify(errorRecords).includes('guild-a'));
    assert.ok(!JSON.stringify(errorRecords).includes('guild-b'));
    await logger.close();
});

test('logger.error accepts a bare Error as the 3rd positional argument', async () => {
    const { logger, sent } = makeLogger();
    logger.error(Events.COMMAND_ERROR, { command: 'startup' }, new Error('boom'));
    await logger.flushAll({ timeoutMs: 1000 });

    const [record] = recordsIn(sent);
    assert.equal(record.error.name, 'Error');
    assert.equal(record.error.message, 'boom');
    await logger.close();
});

test('an internal logging failure never throws out to the caller', async () => {
    const { logger } = makeLogger({ buildComponentFn: () => { throw new Error('component builder exploded'); } });
    assert.doesNotThrow(() => logger.info('SOME_EVENT', {}));
    await logger.close();
});

test('reportStartup and reportShutdown produce clean reports without traceId', async () => {
    const { logger } = makeLogger({ webhook: { enabled: false } });
    logger.registerHealthCheck('TestCheck', async () => ({ ok: false, detail: 'unavailable' }));

    const startupReport = await logger.reportStartup({
        client: {},
        commandsLoaded: 1,
        eventsLoaded: 5,
        webhooksConfigured: 0,
        startupDurationMs: 100,
    });
    assert.ok(startupReport.text.includes('BOT STARTUP DIAGNOSTICS'));
    assert.equal(startupReport.health, 'DEGRADED');
    assert.equal(startupReport.traceId, undefined);

    await logger.command('startup', {}, async () => {});
    const shutdownReport = await logger.reportShutdown({ shutdownDurationMs: 50 });
    assert.ok(shutdownReport.text.includes('Commands executed : 1'));
    assert.equal(shutdownReport.traceId, undefined);
    await logger.close();
});

test('close() drains and closes the JSON log file stream with final shutdown records intact', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linuxo-log-'));
    const logFile = path.join(tmpDir, 'bot.jsonl');

    try {
        const logger = createLogger({
            console: false,
            file: logFile,
            webhook: { enabled: false },
            botVersion: '0.2.0',
        });

        logger.info(Events.BOT_SHUTDOWN, { signal: 'SIGTERM' });
        await logger.reportShutdown({ shutdownDurationMs: 42 });
        await logger.close({ timeoutMs: 2000 });

        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert.equal(lines.length, 2);
        assert.equal(lines[0].event, Events.BOT_SHUTDOWN);
        assert.equal(lines[1].event, 'BOT_SHUTDOWN_REPORT');
        assert.equal(lines[1].shutdownDurationMs, 42);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildLogComponent omits identity fields, traceId, and requestId', () => {
    const container = buildLogComponent({
        level: 'info',
        event: 'COMMAND_END',
        status: 'success',
        command: 'startup',
        durationMs: 25,
        guildId: '999888777',
        userId: '111222333',
        botVersion: '0.2.0',
        timestamp: '2026-11-18T00:00:00.000Z',
        traceId: 'should-not-appear',
        requestId: 'req-should-not-appear',
    });
    const serialized = JSON.stringify(container.toJSON());
    assert.ok(!serialized.includes('investigate'));
    assert.ok(!serialized.includes('investigation'));
    assert.ok(!serialized.includes('Trace ID'));
    assert.ok(!serialized.includes('should-not-appear'));
    assert.ok(!serialized.includes('req:'));
    assert.ok(!serialized.includes('999888777'));
    assert.ok(!serialized.includes('111222333'));
});
