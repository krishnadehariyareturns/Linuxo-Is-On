'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeError, safeSummary, fingerprint, isRetryable, isPermanentHttpStatus } = require('../src/lib/forensic-logger/core/errors');

test('normalizes a plain Error', () => {
    const out = normalizeError(new Error('boom'));
    assert.equal(out.name, 'Error');
    assert.equal(out.message, 'boom');
    assert.equal(out.code, undefined);
    assert.equal(out.stack, undefined, 'stack traces are not retained in log records');
});

test('normalizes a DiscordAPIError-shaped error (status + code)', () => {
    class DiscordAPIError extends Error {
        constructor(message, code, status) {
            super(message);
            this.name = 'DiscordAPIError';
            this.code = code;
            this.status = status;
        }
    }
    const out = normalizeError(new DiscordAPIError('Missing Permissions', 50013, 403));
    assert.equal(out.name, 'DiscordAPIError');
    assert.equal(out.code, 50013);
    assert.equal(out.httpStatus, 403);
    assert.equal(out.retryable, false);
});

test('classifies retryable vs permanent HTTP statuses accurately', () => {
    class ApiError extends Error {
        constructor(status) { super(`http ${status}`); this.status = status; }
    }
    for (const retryableStatus of [408, 425, 429, 500, 502, 503, 504]) {
        assert.equal(normalizeError(new ApiError(retryableStatus)).retryable, true, `expected ${retryableStatus} retryable`);
        assert.equal(isPermanentHttpStatus(retryableStatus), false);
    }
    for (const permanentStatus of [400, 401, 403, 404, 405, 410, 422]) {
        assert.equal(normalizeError(new ApiError(permanentStatus)).retryable, false, `expected ${permanentStatus} non-retryable`);
        assert.equal(isPermanentHttpStatus(permanentStatus), true);
    }
});

test('marks transient network/system/timeout/fetch errors as retryable', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']) {
        const err = new Error('network');
        err.code = code;
        assert.equal(isRetryable(err, undefined), true, `expected ${code} retryable`);
    }

    const fetchErr = new TypeError('fetch failed');
    assert.equal(isRetryable(fetchErr, undefined), true);

    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    assert.equal(isRetryable(abortErr, undefined), true);

    assert.equal(isRetryable(new Error('invalid argument'), undefined), false);
});

test('handles non-Error throws without crashing', () => {
    const out = normalizeError('just a string');
    assert.equal(out.name, 'NonErrorThrown');
    assert.equal(out.message, 'just a string');

    const out2 = normalizeError({ weird: 'object' });
    assert.equal(out2.name, 'NonErrorThrown');
    assert.ok(out2.message.includes('weird'));
});

test('handles null/undefined', () => {
    assert.equal(normalizeError(null), null);
    assert.equal(normalizeError(undefined), null);
});

test('safeSummary never includes the stack and caps length', () => {
    const normalized = normalizeError(new Error('boom'));
    const summary = safeSummary(normalized);
    assert.ok(!summary.includes('at '));
    assert.ok(summary.includes('boom'));

    const long = safeSummary(normalizeError(new Error('x'.repeat(1000))), 50);
    assert.ok(long.length <= 51);
});

test('fingerprint deduplicates the same error by command without retaining guild identity', () => {
    function makeErr() {
        try {
            throw new Error('same failure');
        } catch (e) {
            return e;
        }
    }
    const a1 = fingerprint(normalizeError(makeErr()), { command: 'startup', guildId: 'guild-1' });
    const a2 = fingerprint(normalizeError(makeErr()), { command: 'startup', guildId: 'guild-1' });
    const b1 = fingerprint(normalizeError(makeErr()), { command: 'startup', guildId: 'guild-2' });
    const c1 = fingerprint(normalizeError(makeErr()), { command: 'other', guildId: 'guild-1' });

    assert.equal(a1, a2);
    assert.equal(a1, b1, 'guild identity is intentionally excluded from fingerprints');
    assert.notEqual(a1, c1, 'different commands remain distinguishable');
    assert.equal(fingerprint(null, {}), 'unknown');
});
