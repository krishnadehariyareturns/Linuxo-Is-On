'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, scrubString, keyMatches } = require('../src/lib/forensic-logger/core/redact');

// Synthetic patterns assembled dynamically so test sources contain no real secrets.
function syntheticDiscordToken() {
    return ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'G1b2C3', 'z'.repeat(32)].join('.');
}

function syntheticWebhookUrl() {
    return `https://discord.com/api/webhooks/123456789012345678/${'w'.repeat(42)}`;
}

function syntheticJwt() {
    return ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 's'.repeat(24)].join('.');
}

test('redacts known sensitive keys at top level', () => {
    const out = redact({ token: 'val', username: 'bob' });
    assert.equal(out.token, '[REDACTED]');
    assert.equal(out.username, 'bob');
});

test('redacts sensitive keys regardless of casing/separators', () => {
    const out = redact({
        Authorization: 'value-1',
        API_KEY: 'value-2',
        apiKey: 'value-3',
        apikey: 'value-4',
        webhookUrl: 'value-5',
        WEBHOOK_URL: 'value-6',
        clientSecret: 'value-7',
        private_key: 'value-8',
        'x-auth-token': 'value-9',
        'set-cookie': 'value-10',
    });
    for (const [k, v] of Object.entries(out)) {
        assert.equal(v, '[REDACTED]', `expected key "${k}" to be redacted`);
    }
});

test('does NOT over-redact legitimate non-secret keys like author or authorId', () => {
    const input = {
        author: 'linus',
        authorId: '123456789',
        authorTag: 'linus#0001',
        authority: 'discord.com',
        authenticated: true,
        webhooksConfigured: 2,
        maxTokens: 500,
        guildId: '987654321',
        command: 'startup',
        durationMs: 42,
    };
    const out = redact(input);
    assert.deepEqual(out, input);
});

test('redacts nested keys and array elements recursively', () => {
    const out = redact({
        context: { request: { headers: { cookie: 'sid=123' } } },
        items: [{ password: 'p1' }, { passwd: 'p2' }],
    });
    assert.equal(out.context.request.headers.cookie, '[REDACTED]');
    assert.equal(out.items[0].password, '[REDACTED]');
    assert.equal(out.items[1].passwd, '[REDACTED]');
});

test('scrubs secrets embedded in ordinary strings, URLs, Error.message, and Error.stack', () => {
    const botTok = syntheticDiscordToken();
    const hookUrl = syntheticWebhookUrl();
    const apiKey = `sk-or-v1-${'k'.repeat(32)}`;
    const ghToken = `ghp_${'g'.repeat(30)}`;
    const ptlKey = `ptlc_${'p'.repeat(28)}`;
    const jwt = syntheticJwt();

    const err = new Error(`Failed POST ${hookUrl} with Bot ${botTok}`);
    const normalized = {
        name: err.name,
        message: err.message,
        stack: `${err.name}: ${err.message}\n    at send (/app/src/transport.js:42:11)\n    at run (/app/src/index.js:10:5)`,
    };

    const out = redact({
        msg: `Header Authorization: Bearer ${jwt}`,
        dbUrl: 'postgres://admin:myDbPass@db.internal:5432/app?token=querySecret123&mode=ro',
        keys: `k1=${apiKey} k2=${ghToken} k3=${ptlKey}`,
        inline: 'DISCORD_TOKEN=inlineSecretValue',
        authToken: `Authorization: Token ${'t'.repeat(32)}`,
        apiSecret: `API_SECRET=${'a'.repeat(32)}`,
        awsSecret: `AWS_SECRET_ACCESS_KEY=${'w'.repeat(32)}`,
        rawErr: err,
        error: normalized,
    });

    const serialized = JSON.stringify(out);
    for (const secret of [botTok, hookUrl, apiKey, ghToken, ptlKey, jwt, 'myDbPass', 'querySecret123', 'inlineSecretValue', 't'.repeat(32), 'a'.repeat(32), 'w'.repeat(32)]) {
        assert.ok(!serialized.includes(secret), `expected "${secret.slice(0, 10)}..." to be scrubbed`);
    }
    assert.ok(out.dbUrl.includes('postgres://admin:[REDACTED]@db.internal:5432/app?token=[REDACTED]&mode=ro'));
    assert.ok(out.error.stack.includes('/app/src/transport.js:42:11'), 'diagnostic stack frame preserved');
    assert.equal(out.rawErr.stack, undefined);
});

test('preserves stack traces beyond maxStringLength while still scrubbing secrets before truncation', () => {
    const hookUrl = syntheticWebhookUrl();
    const frames = Array.from({ length: 15 }, (_, i) => `    at fn${i} (/app/src/file${i}.js:${i + 1}:5)`).join('\n');
    const stack = `Error: webhook failure\n${frames}\n    at tail (${hookUrl}:1:1)`;

    const out = redact(
        { message: 'x'.repeat(600), error: { name: 'Error', message: 'fail', stack } },
        { maxStringLength: 100, maxStackLength: 4096 },
    );

    assert.ok(out.message.includes('+500 chars'), 'regular strings still obey maxStringLength');
    assert.ok(out.error.stack.includes('fn14'), 'stack frames beyond 100 chars are preserved');
    assert.ok(!out.error.stack.includes(hookUrl), 'secrets deep in the stack are scrubbed');

    // Secret placed past maxStringLength is scrubbed BEFORE truncation, never split in half.
    const boundaryStr = `${'a'.repeat(90)} ${hookUrl}`;
    const scrubbedBoundary = scrubString(boundaryStr);
    assert.ok(!scrubbedBoundary.includes('webhooks'));
});

test('handles circular references and deep nesting without throwing or hanging', () => {
    const obj = { name: 'x' };
    obj.self = obj;
    const out = redact(obj);
    assert.equal(out.name, 'x');
    assert.equal(out.self, '[Circular]');

    let deep = { leaf: true };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    const walked = redact(deep);
    let cursor = walked;
    let sawMarker = false;
    for (let i = 0; i < 25 && cursor && typeof cursor === 'object'; i++) {
        if (cursor.child === '[MaxDepth]') { sawMarker = true; break; }
        cursor = cursor.child;
    }
    assert.ok(sawMarker);

    const shared = { safe: 'ok' };
    const dag = redact({ first: shared, second: shared, buf: Buffer.from('abc'), json: '{"token":"jsonSecret99"}' });
    assert.deepEqual(dag.first, { safe: 'ok' });
    assert.deepEqual(dag.second, { safe: 'ok' });
    assert.equal(dag.buf, '[Binary]');
    assert.equal(dag.json, '{"token":"[REDACTED]"}');

    const oPrefixToken = ['OTk5OTk5OTk5OTk5OTk5OTk5', 'A1B2C3', 'q'.repeat(30)].join('.');
    assert.equal(scrubString(oPrefixToken), '[REDACTED]');
});

test('supports extra custom sensitive keys and handles null/undefined values', () => {
    const out = redact({ myCustomSecret: 'x', a: null, b: undefined, token: null }, { extraKeys: ['myCustomSecret'] });
    assert.equal(out.myCustomSecret, '[REDACTED]');
    assert.equal(out.a, null);
    assert.equal(out.b, undefined);
    assert.equal(out.token, '[REDACTED]');
});

test('keyMatches is boundary-aware and case/separator insensitive', () => {
    assert.ok(keyMatches('API_KEY', ['api_key']));
    assert.ok(keyMatches('apiKey', ['apikey']));
    assert.ok(keyMatches('myApiKey', ['api_key']));
    assert.ok(keyMatches('authHeader', ['auth']));
    assert.ok(keyMatches('Authorization', ['authorization']));
    assert.ok(!keyMatches('author', ['auth', 'authorization']));
    assert.ok(!keyMatches('authorId', ['auth', 'authorization']));
    assert.ok(!keyMatches('username', ['api_key', 'token']));
});
