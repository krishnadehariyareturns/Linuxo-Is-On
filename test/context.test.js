'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createContextFactory,
    createContext,
    childContext,
    fromInteraction,
} = require('../src/lib/forensic-logger/core/context');

test('static context contains only bot and runtime versions', () => {
    const factory = createContextFactory({ botVersion: '1.0.0', shardId: 2 });
    const ctx = factory.createContext();
    assert.equal(ctx.botVersion, '1.0.0');
    assert.equal(ctx.nodeVersion, process.version);
    assert.equal(ctx.pid, undefined);
    assert.equal(ctx.hostname, undefined);
    assert.equal(ctx.shardId, undefined);
});

test('contexts never generate correlation or host identifiers', () => {
    const ctx = createContext({ command: 'startup' });
    const child = childContext(ctx, { event: 'DATABASE_QUERY' });
    for (const obj of [ctx, child, fromInteraction(null)]) {
        assert.equal(obj.traceId, undefined);
        assert.equal(obj.requestId, undefined);
        assert.equal(obj.parentRequestId, undefined);
        assert.equal(obj.logId, undefined);
        assert.equal(obj.pid, undefined);
        assert.equal(obj.hostname, undefined);
    }
});

test('createContext merges caller-provided non-sensitive fields', () => {
    const ctx = createContext({ command: 'startup' });
    assert.equal(ctx.command, 'startup');
    assert.equal(ctx.nodeVersion, process.version);
});

test('childContext inherits parent fields and merges child overrides', () => {
    const factory = createContextFactory({ botVersion: '1.2.3' });
    const parent = factory.createContext({ command: 'startup' });
    const child = factory.childContext(parent, { event: 'DATABASE_QUERY' });
    assert.equal(child.command, 'startup');
    assert.equal(child.botVersion, '1.2.3');
    assert.equal(child.event, 'DATABASE_QUERY');
});

test('fromInteraction records only the command name and subcommand', () => {
    const fakeInteraction = {
        guildId: 'guild-sensitive',
        guild: { name: 'Private Server Name' },
        channelId: 'channel-sensitive',
        user: { id: 'user-sensitive', tag: 'private-tag#0001' },
        id: 'interaction-sensitive',
        commandName: 'startup',
        isChatInputCommand: () => true,
        isButton: () => false,
        options: { getSubcommand: () => 'status' },
    };
    const ctx = fromInteraction(fakeInteraction);
    assert.equal(ctx.command, 'startup');
    assert.equal(ctx.subcommand, 'status');
    for (const key of ['guildId', 'guildName', 'channelId', 'userId', 'userTag', 'interactionId']) {
        assert.equal(ctx[key], undefined, `${key} must not enter log context`);
    }
});

test('button interactions do not expose identifiers or custom IDs in log context', () => {
    const fakeInteraction = {
        guildId: 'guild-sensitive',
        channelId: 'channel-sensitive',
        user: { id: 'user-sensitive', tag: 'private-tag#0001' },
        id: 'interaction-sensitive',
        customId: 'private-custom-id',
        isChatInputCommand: () => false,
        isButton: () => true,
    };
    const ctx = fromInteraction(fakeInteraction);
    for (const key of ['guildId', 'channelId', 'userId', 'userTag', 'interactionId', 'customId', 'command']) {
        assert.equal(ctx[key], undefined);
    }
});

test('fromInteraction handles a missing interaction gracefully', () => {
    const ctx = fromInteraction(null);
    assert.equal(ctx.nodeVersion, process.version);
    assert.equal(ctx.pid, undefined);
});
