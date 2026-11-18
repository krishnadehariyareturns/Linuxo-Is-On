'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RollingWindow, CommandStats, ErrorDedup } = require('../src/lib/forensic-logger/core/stats');

test('RollingWindow computes percentiles, average, and eviction cleanly', () => {
    const empty = new RollingWindow(10);
    assert.equal(empty.percentile(50), null);
    assert.equal(empty.average(), null);

    const w = new RollingWindow(100);
    for (let i = 1; i <= 100; i++) w.push(i);
    assert.equal(w.percentile(50), 50);
    assert.equal(w.percentile(95), 95);
    assert.equal(w.percentile(99), 99);
    assert.equal(w.percentile(100), 100);

    const small = new RollingWindow(3);
    small.push(1); small.push(2); small.push(3); small.push(4);
    assert.equal(small.size, 3);
    assert.equal(small.count, 4);
    assert.ok(!small.values.includes(1));
    assert.ok(small.values.includes(4));

    const avg = new RollingWindow(10);
    [10, 20, 30].forEach((v) => avg.push(v));
    assert.equal(avg.average(), 20);
});

test('CommandStats records counts, percentiles, slowest command without log IDs, and bounds command keys', () => {
    const stats = new CommandStats({ maxCommands: 3 });
    stats.record('startup', { status: 'success', durationMs: 10 });
    stats.record('startup', { status: 'success', durationMs: 20 });
    stats.record('startup', { status: 'failure', durationMs: 5 });
    stats.record('backup', { status: 'success', durationMs: 5000 });

    const snap = stats.snapshot();
    assert.equal(snap.totalExecuted, 4);
    assert.equal(snap.totalFailed, 1);
    assert.equal(snap.totalSucceeded, 3);
    assert.equal(snap.perCommand.startup.success, 2);
    assert.equal(snap.perCommand.startup.failure, 1);
    assert.equal(snap.slowestCommand.command, 'backup');
    assert.equal(snap.slowestCommand.durationMs, 5000);
    assert.equal(snap.slowestCommand.traceId, undefined);

    // Push past maxCommands to verify bounded eviction.
    stats.record('cmd3', { status: 'success', durationMs: 1 });
    stats.record('cmd4', { status: 'success', durationMs: 1 });
    assert.equal(stats.perCommand.size, 3);
});

test('ErrorDedup emits first occurrence, suppresses repeats, re-emits after window, sweeps, and caps maxEntries', async () => {
    const dedup = new ErrorDedup({ windowMs: 15, maxEntries: 5 });
    assert.equal(dedup.check('fp1').shouldEmit, true);
    assert.equal(dedup.check('fp1').shouldEmit, false);
    assert.equal(dedup.check('fp1').suppressedCount, 2);
    assert.equal(dedup.check('fp2').shouldEmit, true);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterExpiry = dedup.check('fp1');
    assert.equal(afterExpiry.shouldEmit, true);
    assert.equal(afterExpiry.previouslySuppressed, 2);

    await new Promise((resolve) => setTimeout(resolve, 30));
    dedup.sweep();
    assert.equal(dedup.seen.size, 0);

    // Verify hard upper bound under flood of distinct error fingerprints.
    const bounded = new ErrorDedup({ windowMs: 60_000, maxEntries: 10 });
    for (let i = 0; i < 50; i++) bounded.check(`unique-fp-${i}`);
    assert.equal(bounded.seen.size, 10);
});
