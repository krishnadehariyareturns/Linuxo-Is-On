'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Small persistent index of webhook message IDs. It stores no webhook URLs,
 * user data, or log contents. The webhook URL remains in environment config.
 */
function createRetentionStore({ filePath, retentionDays = 14, now = Date.now } = {}) {
    const resolvedPath = path.resolve(filePath || path.join(process.cwd(), 'data', 'log-retention.json'));
    const maxAgeMs = Math.max(1, retentionDays) * DAY_MS;
    let entries = [];

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
            entries = Array.isArray(parsed) ? parsed.filter(isValidEntry) : [];
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            entries = [];
        }
        return entries.length;
    }

    function isValidEntry(entry) {
        return entry && typeof entry.id === 'string'
            && typeof entry.category === 'string'
            && Number.isFinite(entry.createdAt);
    }

    function save() {
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
        const tempPath = `${resolvedPath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(entries), { mode: 0o600 });
        fs.renameSync(tempPath, resolvedPath);
    }

    function pruneExpired() {
        const cutoff = now() - maxAgeMs;
        const before = entries.length;
        entries = entries.filter((entry) => entry.createdAt > cutoff);
        if (entries.length !== before) save();
        return before - entries.length;
    }

    function add(category, id, createdAt = now()) {
        if (!category || !id) return;
        entries.push({ category, id: String(id), createdAt });
        save();
    }

    function dueEntries() {
        const cutoff = now() - maxAgeMs;
        return entries.filter((entry) => entry.createdAt <= cutoff);
    }

    function remove(entry) {
        const before = entries.length;
        entries = entries.filter((item) => !(item.category === entry.category && item.id === entry.id));
        if (entries.length !== before) save();
    }

    function snapshot() {
        return entries.map((entry) => ({ ...entry }));
    }

    load();
    return { add, dueEntries, remove, pruneExpired, snapshot, filePath: resolvedPath };
}

module.exports = { createRetentionStore, DAY_MS };
