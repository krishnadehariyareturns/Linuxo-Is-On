'use strict';

const crypto = require('node:crypto');

// HTTP/network codes that are safe to retry (transient failures & rate limits).
const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_SYSTEM_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EPIPE',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ECONNABORTED',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
]);

function extractHttpStatus(err) {
    const raw = err?.status ?? err?.httpStatus ?? err?.statusCode ?? err?.rawError?.status;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function isPermanentHttpStatus(httpStatus) {
    return typeof httpStatus === 'number'
        && httpStatus >= 400
        && httpStatus < 500
        && !RETRYABLE_HTTP.has(httpStatus);
}

function isRetryable(err, httpStatus) {
    const status = httpStatus ?? extractHttpStatus(err);
    if (typeof status === 'number') {
        return RETRYABLE_HTTP.has(status);
    }
    if (!err) return false;
    if (err.code && RETRYABLE_SYSTEM_CODES.has(err.code)) return true;
    if (err.cause?.code && RETRYABLE_SYSTEM_CODES.has(err.cause.code)) return true;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    if (err.name === 'TypeError' && /\b(fetch failed|network)\b/i.test(String(err.message || ''))) return true;
    return false;
}

/**
 * Normalize any thrown value into a consistent shape. Accepts real Errors,
 * discord.js DiscordAPIError/HTTPError instances (which carry .status/.code
 * on top of the usual Error fields), and non-Error throws (strings, plain
 * objects) without ever throwing itself.
 */
function normalizeError(err) {
    if (err === null || err === undefined) return null;

    if (!(err instanceof Error)) {
        return {
            name: 'NonErrorThrown',
            message: typeof err === 'string' ? err : safeStringify(err),
            code: undefined,
            httpStatus: undefined,
            retryable: false,
        };
    }

    const httpStatus = extractHttpStatus(err);
    const code = err.code ?? err.rawError?.code ?? undefined;

    return {
        name: err.name || 'Error',
        message: err.message || String(err),
        code,
        httpStatus,
        retryable: isRetryable(err, httpStatus),
    };
}

function safeStringify(val) {
    try {
        return JSON.stringify(val);
    } catch {
        return String(val);
    }
}

/**
 * A short, single-line summary safe to post to Discord — no stack trace,
 * length-capped. `normalized` is the output of normalizeError().
 */
function safeSummary(normalized, maxLen = 300) {
    if (!normalized) return 'Unknown error';
    const codePart = normalized.code !== undefined ? ` (code ${normalized.code})` : '';
    const statusPart = normalized.httpStatus !== undefined ? ` [HTTP ${normalized.httpStatus}]` : '';
    const summary = `${normalized.name}: ${normalized.message}${codePart}${statusPart}`;
    return summary.length > maxLen ? `${summary.slice(0, maxLen)}…` : summary;
}

function firstStackFrame(stack) {
    if (!stack || typeof stack !== 'string') return '';
    const lines = stack.split('\n');
    // line 0 is "Error: message", line 1 is the first real frame
    const frame = lines[1] || '';
    // Strip absolute filesystem paths down to just "file:line" so
    // fingerprints stay stable across machines/checkouts.
    const match = frame.match(/([^/\\()]+:\d+:\d+)\)?$/);
    return match ? match[1] : frame.trim();
}

/**
 * A short stable hash used to group repeats by error type/code and command/event.
 * It deliberately excludes Discord identifiers and stack paths.
 */
function fingerprint(normalized, context = {}) {
    if (!normalized) return 'unknown';
    const basis = [
        normalized.name,
        normalized.code ?? '',
        context.command ?? context.event ?? '',
    ].join('|');
    return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 10);
}

module.exports = {
    normalizeError,
    safeSummary,
    fingerprint,
    isRetryable,
    isPermanentHttpStatus,
    extractHttpStatus,
    firstStackFrame,
    RETRYABLE_HTTP,
    RETRYABLE_SYSTEM_CODES,
};
