'use strict';

const os = require('node:os');

function buildStaticFields({ botVersion, shardId = 0 } = {}) {
    return Object.freeze({
        botVersion: botVersion || 'unknown',
        nodeVersion: process.version,
        pid: process.pid,
        hostname: os.hostname(),
        shardId,
    });
}

/**
 * Create an instance-scoped context builder bound to a specific logger's static
 * metadata. Multiple logger instances (e.g. across shards or tests) remain
 * completely isolated and never overwrite each other's botVersion or shardId.
 */
function createContextFactory({ botVersion, shardId = 0 } = {}) {
    const staticFields = buildStaticFields({ botVersion, shardId });

    function getStaticFields() {
        return staticFields;
    }

    /** Build a fresh top-level context for a command or lifecycle event. */
    function createContext(overrides = {}) {
        return {
            ...staticFields,
            ...overrides,
        };
    }

    /** Derive a child context for a sub-operation while inheriting parent context. */
    function childContext(parent, overrides = {}) {
        return {
            ...staticFields,
            ...(parent || {}),
            ...overrides,
        };
    }

    /**
     * Extract standard Discord metadata from a command or button interaction
     * defensively — guildId is null in DMs, guild may be uncached, etc.
     */
    function fromInteraction(interaction, overrides = {}) {
        if (!interaction) return createContext(overrides);

        const fields = {
            guildId: interaction.guildId ?? undefined,
            guildName: interaction.guild?.name ?? undefined,
            channelId: interaction.channelId ?? undefined,
            userId: interaction.user?.id ?? undefined,
            userTag: interaction.user?.tag ?? undefined,
            interactionId: interaction.id ?? undefined,
        };

        if (typeof interaction.isChatInputCommand === 'function' && interaction.isChatInputCommand()) {
            fields.command = interaction.commandName;
            fields.subcommand = interaction.options?.getSubcommand?.(false) ?? undefined;
        } else if (typeof interaction.isButton === 'function' && interaction.isButton()) {
            fields.customId = interaction.customId;
        }

        return createContext({ ...fields, ...overrides });
    }

    return {
        createContext,
        childContext,
        fromInteraction,
        getStaticFields,
    };
}

// Stateless default helpers for callers that don't have a specific logger instance.
const defaultFactory = createContextFactory();

module.exports = {
    createContextFactory,
    buildStaticFields,
    createContext: defaultFactory.createContext,
    childContext: defaultFactory.childContext,
    fromInteraction: defaultFactory.fromInteraction,
    getStaticFields: defaultFactory.getStaticFields,
};
