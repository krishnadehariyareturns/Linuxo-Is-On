'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRetentionStore, DAY_MS } = require('../src/lib/forensic-logger/core/retention');

test('retention store persists only webhook message metadata and selects entries older than 14 days', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linuxo-retention-'));
    const filePath = path.join(dir, 'retention.json');
    const now = Date.now();
    const store = createRetentionStore({ filePath, retentionDays: 14, now: () => now });
    store.add('logs', '12345', now - 15 * DAY_MS);
    store.add('errors', '67890', now - 2 * DAY_MS);

    assert.deepEqual(store.dueEntries().map((entry) => entry.id), ['12345']);
    const persisted = fs.readFileSync(filePath, 'utf8');
    assert.ok(!persisted.includes('webhook'));
    assert.ok(!persisted.includes('user'));
    const reloaded = createRetentionStore({ filePath, retentionDays: 14, now: () => now });
    assert.equal(reloaded.snapshot().length, 2);
    reloaded.remove(reloaded.dueEntries()[0]);
    assert.equal(reloaded.snapshot().length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
});
