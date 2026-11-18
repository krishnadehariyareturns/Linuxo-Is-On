'use strict';

/**
 * Fixed-capacity rolling window of numeric samples. Oldest samples fall off
 * once `maxSize` is reached, so this stays cheap to keep forever without
 * unbounded memory growth, while still giving a representative recent
 * percentile rather than one that drifts stale over a long-running process.
 */
class RollingWindow {
    constructor(maxSize = 500) {
        this.maxSize = Math.max(1, maxSize);
        this.values = [];
        this.cursor = 0;
        this.count = 0;
    }

    push(value) {
        if (this.values.length < this.maxSize) {
            this.values.push(value);
        } else {
            this.values[this.cursor] = value;
            this.cursor = (this.cursor + 1) % this.maxSize;
        }
        this.count++;
    }

    get size() {
        return this.values.length;
    }

    percentile(p) {
        if (this.values.length === 0) return null;
        const sorted = [...this.values].sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
        return sorted[idx];
    }

    average() {
        if (this.values.length === 0) return null;
        return this.values.reduce((a, b) => a + b, 0) / this.values.length;
    }
}

/**
 * Per-command success/failure counters and duration percentiles, plus the
 * single slowest call seen (for the shutdown report). Bounded by `maxCommands`
 * so unexpected/dynamic command keys can never grow memory unboundedly.
 */
class CommandStats {
    constructor({ windowSize = 500, maxCommands = 200 } = {}) {
        this.windowSize = Math.max(1, windowSize);
        this.maxCommands = Math.max(1, maxCommands);
        this.perCommand = new Map();
        this.totalExecuted = 0;
        this.totalFailed = 0;
        this.startedAt = Date.now();
    }

    _entry(command) {
        const key = String(command || 'unknown');
        let e = this.perCommand.get(key);
        if (!e) {
            if (this.perCommand.size >= this.maxCommands) {
                const oldestKey = this.perCommand.keys().next().value;
                this.perCommand.delete(oldestKey);
            }
            e = {
                success: 0,
                failure: 0,
                durations: new RollingWindow(this.windowSize),
                slowest: null, // { durationMs }
            };
            this.perCommand.set(key, e);
        }
        return e;
    }

    record(command, { status, durationMs } = {}) {
        const e = this._entry(command);
        this.totalExecuted++;
        if (status === 'success') e.success++;
        else {
            e.failure++;
            this.totalFailed++;
        }
        if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
            e.durations.push(durationMs);
            if (!e.slowest || durationMs > e.slowest.durationMs) {
                e.slowest = { durationMs };
            }
        }
    }

    snapshot() {
        const perCommand = {};
        let overallSlowest = null;
        let allDurations = [];

        for (const [name, e] of this.perCommand.entries()) {
            perCommand[name] = {
                success: e.success,
                failure: e.failure,
                total: e.success + e.failure,
                p50: e.durations.percentile(50),
                p95: e.durations.percentile(95),
                p99: e.durations.percentile(99),
                avg: e.durations.average(),
                slowest: e.slowest,
            };
            if (e.slowest && (!overallSlowest || e.slowest.durationMs > overallSlowest.durationMs)) {
                overallSlowest = { command: name, ...e.slowest };
            }
            allDurations = allDurations.concat(e.durations.values);
        }

        const overallAvg = allDurations.length
            ? allDurations.reduce((a, b) => a + b, 0) / allDurations.length
            : null;

        return {
            uptimeMs: Date.now() - this.startedAt,
            totalExecuted: this.totalExecuted,
            totalSucceeded: this.totalExecuted - this.totalFailed,
            totalFailed: this.totalFailed,
            overallAvgDurationMs: overallAvg,
            slowestCommand: overallSlowest,
            perCommand,
        };
    }
}

/**
 * Suppresses repeat webhook noise for the same failure fingerprint within a
 * rolling time window, while never affecting what gets written to
 * console/JSON (those stay complete — dedup only throttles the Discord-facing
 * surface). Strictly bounded by `maxEntries` with automatic expiry sweeping.
 */
class ErrorDedup {
    constructor({ windowMs = 60_000, maxEntries = 1000 } = {}) {
        this.windowMs = Math.max(0, windowMs);
        this.maxEntries = Math.max(1, maxEntries);
        this.seen = new Map(); // fingerprint -> { firstAt, lastAt, count }
    }

    check(fingerprint) {
        const now = Date.now();
        const existing = this.seen.get(fingerprint);

        if (!existing || now - existing.firstAt > this.windowMs) {
            const previouslySuppressed = existing ? existing.count - 1 : 0;
            if (existing) {
                this.seen.delete(fingerprint);
            } else if (this.seen.size >= this.maxEntries) {
                this.sweep(now);
                if (this.seen.size >= this.maxEntries) {
                    const oldestFp = this.seen.keys().next().value;
                    this.seen.delete(oldestFp);
                }
            }
            this.seen.set(fingerprint, { firstAt: now, lastAt: now, count: 1 });
            return { shouldEmit: true, suppressedCount: 0, previouslySuppressed };
        }

        existing.count++;
        existing.lastAt = now;
        return { shouldEmit: false, suppressedCount: existing.count - 1, previouslySuppressed: 0 };
    }

    /** Drop entries whose window has fully expired, to bound memory. */
    sweep(now = Date.now()) {
        for (const [fp, entry] of this.seen.entries()) {
            if (now - entry.lastAt > this.windowMs) this.seen.delete(fp);
        }
    }
}

module.exports = { RollingWindow, CommandStats, ErrorDedup };
