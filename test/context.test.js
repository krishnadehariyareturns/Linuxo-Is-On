'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createContextFactory,
    createContext,
    childContext,
    fromInteraction,
} = require('../src/lib/forensic-logger/core/context');

test('createContextFactory creates isolated instance-scoped static fields', () => {
    const factoryA = createContextFactory({ botVersion: '1.0.0', shardId: 2 });
    const factoryB = createContextFactory({ botVersion: '2.5.0', shardId: 7 });

    const ctxA = factoryA.createContext({ guildId: 'g1' });
    const ctxB = factoryB.createContext({ guildId: 'g2' });

    assert.equal(ctxA.botVersion, '1.0.0');
    assert.equal(ctxA.shardId, 2);
    assert.equal(ctxA.guildId, 'g1');

    assert.equal(ctxB.botVersion, '2.5.0');
    assert.equal(ctxB.shardId, 7);
    assert.equal(ctxB.guildId, 'g2');

    // Re-creating via factoryA after factoryB still retains factoryA's own metadata.
    const ctxA2 = factoryA.fromInteraction(null);
    assert.equal(ctxA2.botVersion, '1.0.0');
    assert.equal(ctxA2.shardId, 2);
});

test('contexts never generate traceId, requestId, parentRequestId, or logId', () => {
    const factory = createContextFactory({ botVersion: '1.0.0', shardId: 0 });
    const ctx = factory.createContext({ command: 'startup' });
    const child = factory.childContext(ctx, { event: 'DATABASE_QUERY' });

    for (const obj of [ctx, child, createContext({}), fromInteraction(null)]) {
        assert.equal(obj.traceId, undefined);
        assert.equal(obj.requestId, undefined);
        assert.equal(obj.parentRequestId, undefined);
        assert.equal(obj.logId, undefined);
    }
});

test('createContext merges overrides on top of base fields', () => {
    const ctx = createContext({ guildId: 'g1', command: 'startup' });
    assert.equal(ctx.guildId, 'g1');
    assert.equal(ctx.command, 'startup');
    assert.equal(ctx.nodeVersion, process.version);
});

test('childContext inherits parent fields and merges child overrides', () => {
    const factory = createContextFactory({ botVersion: '1.2.3', shardId: 1 });
    const parent = factory.createContext({ command: 'startup', guildId: 'g1' });
    const child = factory.childContext(parent, { event: 'DATABASE_QUERY' });
    assert.equal(child.command, 'startup');
    assert.equal(child.guildId, 'g1');
    assert.equal(child.botVersion, '1.2.3');
    assert.equal(child.shardId, 1);
    assert.equal(child.event, 'DATABASE_QUERY');
});

test('fromInteraction extracts guild/channel/user/command fields', () => {
    const fakeInteraction = {
        guildId: 'g1',
        guild: { name: 'Test Guild' },
        channelId: 'c1',
        user: { id: 'u1', tag: 'user#0001' },
        id: 'i1',
        commandName: 'startup',
        isChatInputCommand: () => true,
        isButton: () => false,
        options: { getSubcommand: () => null },
    };
    const ctx = fromInteraction(fakeInteraction);
    assert.equal(ctx.guildId, 'g1');
    assert.equal(ctx.guildName, 'Test Guild');
    assert.equal(ctx.channelId, 'c1');
    assert.equal(ctx.userId, 'u1');
    assert.equal(ctx.userTag, 'user#0001');
    assert.equal(ctx.interactionId, 'i1');
    assert.equal(ctx.command, 'startup');
});

test('fromInteraction handles DM interactions with null guildId', () => {
    const fakeInteraction = {
        guildId: null,
        guild: null,
        channelId: 'c1',
        user: { id: 'u1', tag: 'user#0001' },
        id: 'i1',
        commandName: 'startup',
        isChatInputCommand: () => true,
        isButton: () => false,
        options: { getSubcommand: () => null },
    };
    const ctx = fromInteraction(fakeInteraction);
    assert.equal(ctx.guildId, undefined);
    assert.equal(ctx.guildName, undefined);
});

test('fromInteraction extracts customId for button interactions', () => {
    const fakeInteraction = {
        guildId: 'g1',
        channelId: 'c1',
        user: { id: 'u1', tag: 'user#0001' },
        id: 'i1',
        customId: 'my_button',
        isChatInputCommand: () => false,
        isButton: () => true,
    };
    const ctx = fromInteraction(fakeInteraction);
    assert.equal(ctx.customId, 'my_button');
    assert.equal(ctx.command, undefined);
});

test('fromInteraction handles a missing interaction gracefully', () => {
    const ctx = fromInteraction(null);
    assert.equal(ctx.nodeVersion, process.version);
    assert.equal(ctx.pid, process.pid);
});
