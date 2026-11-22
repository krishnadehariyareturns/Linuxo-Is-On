'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, InteractionContextType, MessageFlags } = require('discord.js');

const startup = require('../src/commands/startup');
const {
    loadCommands,
    handleInteractionCreate,
    createGracefulShutdown,
} = require('../src/index');
const { createLogger } = require('../src/lib/forensic-logger');

function makeSilentLogger(overrides = {}) {
    const records = [];
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
        buildComponentFn: (record) => ({ record }),
        sendFn: async (category, payload) => {
            for (const c of payload.components) {
                records.push({ category, ...(c.record || {}) });
            }
        },
        ...overrides,
    });
    return { logger, records };
}

test('loadCommands loads only /startup and restricts it to guilds', async () => {
    const { logger } = makeSilentLogger({ webhook: { enabled: false } });
    const client = { commands: new Collection(), buttons: new Collection() };

    const count = loadCommands(client, logger);
    assert.equal(count, 1);
    assert.deepEqual([...client.commands.keys()], ['startup']);
    assert.equal(client.commands.has('investigate'), false);

    const json = startup.data.toJSON();
    assert.deepEqual(json.contexts, [InteractionContextType.Guild]);
    await logger.close();
});

test('/startup delete button allows only verified original invoker and fails closed otherwise', async () => {
    const deleteHandler = startup.buttons[startup.DELETE_BUTTON_ID];

    // 1. Original invoker in same guild -> deferUpdate + delete
    let deferred = false;
    let deleted = false;
    await deleteHandler({
        guildId: 'guild-1',
        user: { id: 'user-owner' },
        message: {
            guildId: 'guild-1',
            interactionMetadata: { id: 'int-1', user: { id: 'user-owner' } },
            delete: async () => { deleted = true; },
        },
        deferUpdate: async () => { deferred = true; },
        reply: async () => { throw new Error('should not reply on authorized delete'); },
    });
    assert.equal(deferred, true);
    assert.equal(deleted, true);

    // 2. Different user -> denied with MessageFlags.Ephemeral, never deleted
    const deniedReplies = [];
    let wrongDelete = false;
    await deleteHandler({
        guildId: 'guild-1',
        user: { id: 'user-intruder' },
        message: {
            guildId: 'guild-1',
            interactionMetadata: { id: 'int-1', user: { id: 'user-owner' } },
            delete: async () => { wrongDelete = true; },
        },
        deferUpdate: async () => { wrongDelete = true; },
        reply: async (payload) => { deniedReplies.push(payload); },
    });
    assert.equal(wrongDelete, false);
    assert.equal(deniedReplies.length, 1);
    assert.equal(deniedReplies[0].flags, MessageFlags.Ephemeral);
    assert.equal(deniedReplies[0].ephemeral, undefined);

    // 3. Missing interactionMetadata -> fails closed!
    const missingMetaReplies = [];
    let missingMetaDeleted = false;
    await deleteHandler({
        guildId: 'guild-1',
        user: { id: 'user-anyone' },
        message: {
            guildId: 'guild-1',
            interactionMetadata: undefined,
            delete: async () => { missingMetaDeleted = true; },
        },
        deferUpdate: async () => { missingMetaDeleted = true; },
        reply: async (payload) => { missingMetaReplies.push(payload); },
    });
    assert.equal(missingMetaDeleted, false);
    assert.equal(missingMetaReplies.length, 1);
    assert.equal(missingMetaReplies[0].flags, MessageFlags.Ephemeral);

    // 4. Cross-guild mismatch -> fails closed even if user ID matches!
    const crossGuildReplies = [];
    let crossGuildDeleted = false;
    await deleteHandler({
        guildId: 'guild-2',
        user: { id: 'user-owner' },
        message: {
            guildId: 'guild-1',
            interactionMetadata: { id: 'int-1', user: { id: 'user-owner' } },
            delete: async () => { crossGuildDeleted = true; },
        },
        deferUpdate: async () => { crossGuildDeleted = true; },
        reply: async (payload) => { crossGuildReplies.push(payload); },
    });
    assert.equal(crossGuildDeleted, false);
    assert.equal(crossGuildReplies.length, 1);
    assert.equal(crossGuildReplies[0].flags, MessageFlags.Ephemeral);

    // 5. Already-deleted message (Discord code 10008) is handled gracefully
    await assert.doesNotReject(deleteHandler({
        guildId: 'guild-1',
        user: { id: 'user-owner' },
        message: {
            guildId: 'guild-1',
            interactionMetadata: { id: 'int-2', user: { id: 'user-owner' } },
            delete: async () => {
                const err = new Error('Unknown Message');
                err.code = 10008;
                throw err;
            },
        },
        deferUpdate: async () => {},
        reply: async () => {},
    }));
});

test('/startup renders with local asset, omits third-party CDN, degrades cleanly when missing, and isolates guild timers', async () => {
    startup.stopAllTimers();

    // Bundled local logo works and never embeds Cloudinary
    const defaultMedia = startup.resolvePanelMedia({ bannerUrl: '' });
    assert.equal(defaultMedia.mediaUrl, 'attachment://linuxo-text-logo.png');
    assert.ok(defaultMedia.file);

    const panelWithMedia = JSON.stringify(startup.buildPanel({ uptime: 65_000, ws: { ping: 42 } }, { mediaUrl: defaultMedia.mediaUrl }).toJSON());
    assert.ok(!panelWithMedia.includes('cloudinary'));
    assert.ok(panelWithMedia.includes('attachment://linuxo-text-logo.png'));
    assert.ok(panelWithMedia.includes('1m 5s'));
    assert.ok(panelWithMedia.includes('42ms'));

    // Missing local asset falls back cleanly to media-free panel
    const missingMedia = startup.resolvePanelMedia({ bannerUrl: '', logoPath: '/nonexistent/path/logo.png' });
    assert.equal(missingMedia.mediaUrl, null);
    assert.equal(missingMedia.file, null);

    const panelWithoutMedia = startup.buildPanel({ uptime: 5_000, ws: { ping: -1 } }, { mediaUrl: null }).toJSON();
    assert.ok(JSON.stringify(panelWithoutMedia).includes('calculating...'));
    assert.ok(!panelWithoutMedia.components.some((c) => c.type === 12), 'no broken MediaGallery when media is unavailable');

    // Execute in two different guilds and verify per-guild timer cleanup & shutdown cleanup
    const makeFakeStartupInteraction = (id, guildId) => ({
        id,
        guildId,
        client: { uptime: 10_000, ws: { ping: 20 } },
        replied: false,
        deferred: false,
        reply: async function reply() { this.replied = true; },
        editReply: async () => {},
    });

    await startup.execute(makeFakeStartupInteraction('int-g1', 'guild-a'), {
        refreshMs: 60_000,
        media: { bannerUrl: '', logoPath: '/nonexistent/logo.png' },
    });
    await startup.execute(makeFakeStartupInteraction('int-g2', 'guild-b'), {
        refreshMs: 60_000,
        media: { bannerUrl: '', logoPath: '/nonexistent/logo.png' },
    });

    assert.equal(startup.getActiveTimerCount(), 2);
    assert.equal(startup.stopGuildTimers('guild-a'), 1);
    assert.equal(startup.getActiveTimerCount(), 1, 'guild-b timer unaffected when guild-a is removed');
    assert.equal(startup.stopAllTimers(), 1);
    assert.equal(startup.getActiveTimerCount(), 0);

    // Fallback to media-free panel if initial reply rejects when uploading media
    let replyCalls = 0;
    let lastPayload = null;
    await startup.execute({
        id: 'int-fallback',
        guildId: 'guild-fallback',
        client: { uptime: 1000, ws: { ping: 15 } },
        replied: false,
        deferred: false,
        reply: async function reply(payload) {
            replyCalls++;
            if (replyCalls === 1) throw new Error('upload failed');
            this.replied = true;
            lastPayload = payload;
        },
        editReply: async () => {},
    }, { refreshMs: 60_000 });
    assert.equal(replyCalls, 2);
    assert.equal(lastPayload.files, undefined);
    startup.stopAllTimers();

    // Verify unref'd interval allows a real Node child process to exit immediately
    const started = Date.now();
    const out = execFileSync(process.execPath, [
        '-e',
        `const s = require('./src/commands/startup');
         s.execute({
           id: 'unref-check', guildId: 'g1', client: { uptime: 1000, ws: { ping: 10 } },
           replied: false, deferred: false, reply: async () => {}, editReply: async () => {}
         }, { media: { bannerUrl: '', logoPath: '/missing.png' } }).then(() => console.log('exiting'));`,
    ], { cwd: path.resolve(__dirname, '..'), timeout: 4000, encoding: 'utf8' });
    assert.equal(out.trim(), 'exiting');
    assert.ok(Date.now() - started < 3500, 'unref timer must not block process exit');
});

test('handleInteractionCreate logs button failures and returns MessageFlags.Ephemeral before and after ack', async () => {
    const { logger, records } = makeSilentLogger();
    const client = {
        commands: new Collection(),
        buttons: new Collection([
            ['throw_before_ack', async () => { throw new Error('pre-ack failure'); }],
            ['throw_after_ack', async (interaction) => {
                await interaction.deferUpdate();
                throw new Error('post-ack failure');
            }],
        ]),
    };

    // Case 1: throws before acknowledgement -> logs BUTTON_ERROR + replies ephemerally
    const preAckReplies = [];
    await handleInteractionCreate({
        id: 'b1',
        guildId: 'guild-1',
        channelId: 'chan-1',
        user: { id: 'u1', tag: 'u1#0001' },
        customId: 'throw_before_ack',
        message: { guildId: 'guild-1' },
        replied: false,
        deferred: false,
        isChatInputCommand: () => false,
        isButton: () => true,
        reply: async (p) => { preAckReplies.push(p); },
        followUp: async () => { throw new Error('expected reply, not followUp'); },
    }, { client, logger });

    assert.equal(preAckReplies.length, 1);
    assert.equal(preAckReplies[0].flags, MessageFlags.Ephemeral);
    assert.equal(preAckReplies[0].ephemeral, undefined);

    // Case 2: throws after deferUpdate -> logs BUTTON_ERROR + follows up ephemerally
    const postAckFollowUps = [];
    const postAckInteraction = {
        id: 'b2',
        guildId: 'guild-1',
        channelId: 'chan-1',
        user: { id: 'u1', tag: 'u1#0001' },
        customId: 'throw_after_ack',
        message: { guildId: 'guild-1' },
        replied: false,
        deferred: false,
        isChatInputCommand: () => false,
        isButton: () => true,
        deferUpdate: async function defer() { this.deferred = true; },
        reply: async () => { throw new Error('expected followUp, not reply'); },
        followUp: async (p) => { postAckFollowUps.push(p); },
    };
    await handleInteractionCreate(postAckInteraction, { client, logger });

    assert.equal(postAckFollowUps.length, 1);
    assert.equal(postAckFollowUps[0].flags, MessageFlags.Ephemeral);
    assert.equal(postAckFollowUps[0].ephemeral, undefined);

    // Case 3: DM invocation is rejected with MessageFlags.Ephemeral
    const dmReplies = [];
    client.commands.set('startup', startup);
    await handleInteractionCreate({
        id: 'c1',
        guildId: null,
        guild: null,
        channelId: 'dm-1',
        user: { id: 'u1', tag: 'u1#0001' },
        commandName: 'startup',
        replied: false,
        deferred: false,
        isChatInputCommand: () => true,
        isButton: () => false,
        reply: async (p) => { dmReplies.push(p); },
    }, { client, logger });
    assert.equal(dmReplies.length, 1);
    assert.equal(dmReplies[0].flags, MessageFlags.Ephemeral);

    await logger.flushAll({ timeoutMs: 1000 });
    const buttonErrors = records.filter((r) => r.event === 'BUTTON_ERROR');
    assert.equal(buttonErrors.length, 1, 'identical button failures are deduplicated without user/guild identity');
    assert.ok(records.some((r) => r.event === 'COMMAND_PERMISSION_DENIED'));
    const recordDump = JSON.stringify(records);
    for (const value of ['b1', 'b2', 'guild-1', 'chan-1', 'u1', 'throw_before_ack', 'throw_after_ack']) {
        assert.ok(!recordDump.includes(value), `log records must not include ${value}`);
    }
    await logger.close();
});

test('createGracefulShutdown measures elapsed time after delayed flush + destroy, stops timers, and closes log file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linuxo-shutdown-'));
    const logFile = path.join(tmpDir, 'shutdown.jsonl');

    try {
        const logger = createLogger({
            console: false,
            file: logFile,
            webhook: {
                enabled: true,
                batchSize: 10,
                flushIntervalMs: 60_000,
                retryLimit: 0,
                categories: { logs: 'https://example.com/logs' },
            },
            buildComponentFn: (record) => ({ record }),
            sendFn: async () => {
                await new Promise((resolve) => setTimeout(resolve, 45));
            },
        });

        let timersStopped = false;
        let clientDestroyed = false;
        let exitCode = null;

        const client = {
            commands: new Collection([
                ['startup', { stopAllTimers: () => { timersStopped = true; } }],
            ]),
            destroy: async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
                clientDestroyed = true;
            },
        };

        const gracefulShutdown = createGracefulShutdown({
            client,
            logger,
            exit: (code) => { exitCode = code; },
        });

        const report = await gracefulShutdown('SIGTERM');

        assert.equal(timersStopped, true);
        assert.equal(clientDestroyed, true);
        assert.equal(exitCode, 0);
        assert.ok(
            report.structured.shutdownDurationMs >= 60,
            `expected shutdownDurationMs >= 60ms (got ${report.structured.shutdownDurationMs}ms)`,
        );

        const persisted = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert.ok(persisted.some((r) => r.event === 'BOT_SHUTDOWN'));
        const shutdownEntry = persisted.find((r) => r.event === 'BOT_SHUTDOWN_REPORT');
        assert.ok(shutdownEntry, 'expected final shutdown report flushed to log file before exit');
        assert.ok(shutdownEntry.shutdownDurationMs >= 60);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
