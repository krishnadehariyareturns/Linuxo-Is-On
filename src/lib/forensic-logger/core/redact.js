'use strict';

// Token/boundary-aware sensitive key names. Multi-word entries match both
// separated/camelCase forms ("apiKey", "API_KEY", "myApiKey") and flat forms
// ("apikey") without over-redacting unrelated words like "author" or "authority".
const DEFAULT_SENSITIVE_KEYS = [
    'token',
    'authorization',
    'auth',
    'cookie',
    'cookies',
    'password',
    'passwd',
    'passphrase',
    'secret',
    'secrets',
    'api_key',
    'api_secret',
    'aws_secret_access_key',
    'secret_access_key',
    'access_key',
    'secret_key',
    'private_key',
    'client_secret',
    'webhook_url',
    // Discord/account identifiers and user-supplied personal data.
    'user_id', 'user_tag', 'guild_id', 'guild_name', 'channel_id', 'interaction_id',
    'message_id', 'member_id', 'display_name', 'email', 'phone', 'phone_number',
    'ip_address', 'ip', 'street_address', 'postal_address', 'message_content',
    'attachment_url', 'avatar_url',
    'credential',
    'credentials',
];

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;
const DEFAULT_MAX_STACK_LENGTH = 4096;

// Value-level secret scrubbers applied in order to every string (including
// Error.message, Error.stack, URLs, and free-form log lines) BEFORE truncation.
const VALUE_SCRUBBERS = [
    // PEM-encoded private keys
    {
        pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
        replacement: REDACTED,
    },
    // Discord webhook URLs (discord.com / discordapp.com / canary / ptb, with optional API version & query)
    {
        pattern: /https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+(?:\?[^\s"'<>)\]]*)?/gi,
        replacement: REDACTED,
    },
    // URLs containing embedded basic-auth credentials (scheme://user:password@host)
    {
        pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@"'<>]+):([^@\s/"'<>]+)@/gi,
        replacement: `$1:${REDACTED}@`,
    },
    // Common personal identifiers embedded in otherwise free-form text.
    { pattern: /(?<!\[)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: REDACTED },
    { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: REDACTED },
    // Discord snowflakes and other long numeric identifiers in free-form errors.
    { pattern: /\b\d{17,20}\b/g, replacement: REDACTED },
    // Sensitive URL query parameters (?token=..., &api_key=..., etc.)
    {
        pattern: /([?&](?:access_token|refresh_token|id_token|bot_token|auth_token|token|api_key|apikey|client_secret|secret_key|secret|password|passwd|auth)=)[^&#\s"'<>)\]]+/gi,
        replacement: `$1${REDACTED}`,
    },
    // Discord MFA tokens
    {
        pattern: /\bmfa\.[A-Za-z0-9_-]{20,}\b/g,
        replacement: REDACTED,
    },
    // Discord Bot / OAuth 3-part tokens (base64url snowflake . 6-char timestamp . HMAC)
    {
        pattern: /\b(?:(Bot)\s+)?[MNO][A-Za-z0-9_-]{21,32}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,64}\b/g,
        replacement: (_, scheme) => (scheme ? `${scheme} ${REDACTED}` : REDACTED),
    },
    // JSON Web Tokens (three base64url segments starting with eyJ)
    {
        pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
        replacement: REDACTED,
    },
    // Authorization schemes: Bearer / Basic / Bot <credential>
    {
        pattern: /\b(Bearer|Basic|Token)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}/gi,
        replacement: `$1 ${REDACTED}`,
    },
    {
        pattern: /\b(Bot)\s+(?!\[REDACTED\])[A-Za-z0-9._-]{16,}/g,
        replacement: `$1 ${REDACTED}`,
    },
    // Common provider API keys (sk-*, GitHub, Slack, AWS, Pterodactyl)
    {
        pattern: /\bsk-(?:or-v\d+-|proj-|live-|test-|ant-[a-z0-9-]+-)?[A-Za-z0-9_-]{16,}\b/g,
        replacement: REDACTED,
    },
    {
        pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
        replacement: REDACTED,
    },
    {
        pattern: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
        replacement: REDACTED,
    },
    {
        pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
        replacement: REDACTED,
    },
    {
        pattern: /\bptl[ca]_[A-Za-z0-9]{20,}\b/g,
        replacement: REDACTED,
    },
    // JSON-serialized secret fields inside stringified payloads
    {
        pattern: /"((?:discord_token|access_token|refresh_token|id_token|bot_token|auth_token|token|authorization|password|passwd|passphrase|api_key|apikey|api_secret|aws_secret_access_key|secret_access_key|access_key|secret_key|private_key|client_secret|secret|webhook_url|set-cookie|cookie))"\s*:\s*"(?!\[REDACTED\])[^"]*"/gi,
        replacement: `"$1":"${REDACTED}"`,
    },
    // Inline secret key=value or key: value assignments inside free-form strings/logs
    {
        pattern: /\b((?:discord_token|access_token|refresh_token|id_token|bot_token|auth_token|token|authorization|password|passwd|passphrase|api_key|apikey|access_key|secret_key|private_key|client_secret|secret|webhook_url|set-cookie|cookie)\s*[:=]\s*)(?!\[REDACTED\])(?!(?:Bearer|Basic|Bot)\s+\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;}"')\]]+)/gi,
        replacement: `$1${REDACTED}`,
    },
];

function splitKeyTokens(key) {
    return String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function normalizeFlat(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function containsTokenSequence(tokens, sequence) {
    if (sequence.length === 0 || sequence.length > tokens.length) return false;
    for (let i = 0; i <= tokens.length - sequence.length; i++) {
        let match = true;
        for (let j = 0; j < sequence.length; j++) {
            if (tokens[i + j] !== sequence[j]) {
                match = false;
                break;
            }
        }
        if (match) return true;
    }
    return false;
}

/**
 * Boundary-aware sensitive key matcher.
 * - Matches exact normalized names ("apikey" <-> "API_KEY" <-> "apiKey")
 * - Matches full word/token sequences ("clientSecret" matches "secret";
 *   "myApiKey" matches "api_key"; "x-auth-token" matches "auth" & "token")
 * - Never matches partial word stems ("author", "authorId", "authority", and
 *   "authenticated" do NOT match "auth"; "maxTokens" does NOT match "token").
 */
function keyMatches(key, sensitiveKeys = DEFAULT_SENSITIVE_KEYS) {
    const keyTokens = splitKeyTokens(key);
    const keyFlat = normalizeFlat(key);
    if (!keyFlat) return false;

    return sensitiveKeys.some((sensitive) => {
        const sTokens = splitKeyTokens(sensitive);
        const sFlat = normalizeFlat(sensitive);
        if (!sFlat) return false;
        if (keyFlat === sFlat) return true;
        if (containsTokenSequence(keyTokens, sTokens)) return true;
        if (keyTokens.includes(sFlat)) return true;
        return false;
    });
}

/** Scrub recognizable secret values embedded inside an arbitrary string. */
function scrubString(str) {
    if (typeof str !== 'string' || str.length === 0) return str;
    let out = str;
    for (const { pattern, replacement } of VALUE_SCRUBBERS) {
        out = out.replace(pattern, replacement);
    }
    return out;
}

function truncateString(str, maxLen) {
    if (typeof str !== 'string' || !maxLen || str.length <= maxLen) return str;
    return `${str.slice(0, maxLen)}…(+${str.length - maxLen} chars)`;
}

function isStackKey(keyHint) {
    return typeof keyHint === 'string' && keyHint.toLowerCase() === 'stack';
}

/**
 * Recursively redact sensitive keys and embedded secret values from a record.
 * Handles circular references, arrays, Error instances, Dates, and depth limits
 * so a pathological or accidentally-circular context object can never hang the
 * process or throw out of the logger.
 */
function redact(value, options = {}) {
    const sensitiveKeys = [...DEFAULT_SENSITIVE_KEYS, ...(options.extraKeys || [])];
    const maxStringLength = options.maxStringLength || 0;
    const maxStackLength = options.maxStackLength !== undefined
        ? options.maxStackLength
        : (maxStringLength > 0 ? Math.max(maxStringLength * 8, DEFAULT_MAX_STACK_LENGTH) : 0);
    const seen = new WeakSet();

    function sanitizeString(str, keyHint) {
        const scrubbed = scrubString(str);
        const limit = isStackKey(keyHint) ? maxStackLength : maxStringLength;
        return truncateString(scrubbed, limit);
    }

    function walk(val, depth, keyHint) {
        if (val === null || val === undefined) return val;

        if (typeof val === 'string') {
            return sanitizeString(val, keyHint);
        }

        if (typeof val === 'function') return '[Function]';
        if (typeof val === 'symbol') return val.toString();
        if (typeof val !== 'object') return val; // number, boolean, bigint

        if (val instanceof Date) return val.toISOString();
        if (val instanceof RegExp) return scrubString(val.toString());
        if (Buffer.isBuffer(val) || ArrayBuffer.isView(val)) return '[Binary]';

        if (depth >= MAX_DEPTH) return '[MaxDepth]';

        if (seen.has(val)) return '[Circular]';
        seen.add(val);
        try {
            if (val instanceof Error) {
                return {
                    name: val.name,
                    message: sanitizeString(val.message, 'message'),
                };
            }

            if (Array.isArray(val)) {
                return val.map((item) => walk(item, depth + 1, keyHint));
            }

            const out = {};
            for (const [k, v] of Object.entries(val)) {
                if (keyMatches(k, sensitiveKeys)) {
                    out[k] = REDACTED;
                    continue;
                }
                out[k] = walk(v, depth + 1, k);
            }
            return out;
        } finally {
            seen.delete(val);
        }
    }

    return walk(value, 0, undefined);
}

module.exports = { redact, scrubString, DEFAULT_SENSITIVE_KEYS, keyMatches, splitKeyTokens };
