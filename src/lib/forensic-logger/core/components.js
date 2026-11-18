'use strict';

// Discord.js is required lazily so this module (and anything that requires
// it, like core.js) can still load in test environments without
// discord.js installed. Only actually building a component tree needs it.
const { safeSummary } = require('./errors');

const COLOR_BY_LEVEL = {
    trace: 0x95a5a6,
    debug: 0x3498db,
    info: 0x2ecc71,
    warn: 0xf1c40f,
    error: 0xe74c3c,
    fatal: 0x992d22,
};

const TEXT_MAX = 4000; // Components v2 text display practical cap per block
const MAX_FIELD_LINES = 13;

function truncate(str, max) {
    if (str === undefined || str === null) return str;
    const s = String(str);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fmtDuration(ms) {
    if (typeof ms !== 'number') return undefined;
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function colorFor(record) {
    if (record.status === 'failure') return COLOR_BY_LEVEL.error;
    if (record.status === 'success') return COLOR_BY_LEVEL.info;
    return COLOR_BY_LEVEL[record.level] ?? COLOR_BY_LEVEL.info;
}

/** Ordered metadata fields rendered as markdown lines inside a log container. */
const FIELD_DEFS = [
    ['Command', (r) => (r.command ? (r.subcommand ? `/${r.command} ${r.subcommand}` : `/${r.command}`) : undefined)],
    ['Status', (r) => (r.status ? String(r.status).toUpperCase() : undefined)],
    ['Duration', (r) => fmtDuration(r.durationMs)],
    ['Guild', (r) => (r.guildName && r.guildId ? `${r.guildName} (${r.guildId})` : (r.guildName || r.guildId))],
    ['User', (r) => r.userTag || r.userId],
    ['Handler', (r) => r.handler],
    ['Component', (r) => r.customId],
    ['HTTP Status', (r) => r.httpStatus],
    ['Retries', (r) => r.retryCount],
    ['Cache', (r) => r.cacheStatus],
    ['API calls', (r) => r.apiCalls],
    ['Repeated', (r) => (r.suppressedCount !== undefined && r.suppressedCount !== null ? `${r.suppressedCount}x in the last window` : undefined)],
];

/**
 * Build a Components v2 container for a fully-assembled log record
 * (envelope + context + normalized error, already redacted). Never
 * includes a stack trace — that stays in console/JSON/file logs only.
 */
function buildLogComponent(record) {
    // eslint-disable-next-line global-require
    const { ContainerBuilder, SeparatorSpacingSize } = require('discord.js');

    const statusTag = record.status ? `[${record.status.toUpperCase()}] ` : '';
    const title = truncate(`${statusTag}[${record.level.toUpperCase()}] ${record.event}`, 256);

    const lines = [`## ${title}`];
    if (record.message) lines.push(truncate(record.message, TEXT_MAX - 200));

    const fieldLines = [];
    for (const [label, extract] of FIELD_DEFS) {
        const value = extract(record);
        if (value === undefined || value === null || value === '') continue;
        fieldLines.push(`**${label}:** ${value}`);
    }
    if (fieldLines.length) lines.push(fieldLines.slice(0, MAX_FIELD_LINES).join('\n'));

    if (record.error) {
        lines.push(`**Error:** ${truncate(safeSummary(record.error), 1024)}`);
    }

    const footerBits = [
        record.botVersion ? `v${record.botVersion}` : null,
        record.timestamp || null,
    ].filter(Boolean).join(' · ');

    const container = new ContainerBuilder()
        .setAccentColor(colorFor(record))
        .addTextDisplayComponents((textDisplay) => textDisplay.setContent(truncate(lines.join('\n\n'), TEXT_MAX)));

    if (footerBits) {
        container
            .addSeparatorComponents((separator) => separator.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
            .addTextDisplayComponents((textDisplay) => textDisplay.setContent(`-# ${truncate(footerBits, 256)}`));
    }

    return container;
}

/** Wraps one or more containers with the IsComponentsV2 flag, ready for webhookClient.send()/channel.send(). */
function toMessagePayload(containers) {
    // eslint-disable-next-line global-require
    const { MessageFlags } = require('discord.js');
    const list = Array.isArray(containers) ? containers : [containers];
    return { components: list, flags: MessageFlags.IsComponentsV2 };
}

module.exports = { buildLogComponent, toMessagePayload, colorFor, fmtDuration, COLOR_BY_LEVEL };
