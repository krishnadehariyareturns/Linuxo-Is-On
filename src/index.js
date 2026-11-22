'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const {
    Client,
    Collection,
    Events: DiscordEvents,
    GatewayIntentBits,
    ActivityType,
    MessageFlags,
} = require('discord.js');
const { createLogger, Events } = require('./lib/forensic-logger');
const pkg = require('../package.json');

function isBenignReplyError(err) {
    const code = err?.code ?? err?.rawError?.code;
    // 10062 = Unknown interaction (expired), 40060 = Interaction already acknowledged
    return code === 10062 || code === 40060;
}

async function sendEphemeralError(interaction, content, logger, errorEvent, ctx) {
    const errorPayload = {
        content,
        flags: MessageFlags.Ephemeral,
    };
    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(errorPayload);
        } else {
            await interaction.reply(errorPayload);
        }
    } catch (replyErr) {
        if (!isBenignReplyError(replyErr)) {
            logger.error(errorEvent, ctx, replyErr);
        }
    }
}

/**
 * Dispatch a Discord interaction across registered slash commands and buttons,
 * logging all failures and providing safe ephemeral feedback to the user.
 */
async function handleInteractionCreate(interaction, { client, logger }) {
    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        const ctx = logger.fromInteraction(interaction);
        if (!command) {
            await sendEphemeralError(
                interaction,
                '❌ That command is no longer available.',
                logger,
                'COMMAND_ERROR_REPLY_FAILED',
                ctx,
            );
            return;
        }

        // Defense-in-depth: reject DM invocation; bot commands are guild-scoped.
        if (!interaction.guildId) {
            logger.warn(Events.COMMAND_PERMISSION_DENIED, ctx, {
                message: `Rejected non-guild invocation of /${interaction.commandName}`,
            });
            await sendEphemeralError(
                interaction,
                '❌ This command can only be used inside a server.',
                logger,
                'COMMAND_ERROR_REPLY_FAILED',
                ctx,
            );
            return;
        }

        try {
            await logger.command(interaction.commandName, { ...ctx, interaction }, async () => {
                await command.execute(interaction);
            });
        } catch {
            // logger.command() has already logged COMMAND_ERROR with full telemetry.
            await sendEphemeralError(
                interaction,
                '❌ There was an error executing that command.',
                logger,
                'COMMAND_ERROR_REPLY_FAILED',
                ctx,
            );
        }
        return;
    }

    if (interaction.isButton()) {
        const handler = client.buttons.get(interaction.customId);
        if (!handler) return;

        const ctx = logger.fromInteraction(interaction);

        // Defense-in-depth: reject non-guild or cross-guild button interactions.
        if (
            !interaction.guildId
            || (interaction.message?.guildId && interaction.message.guildId !== interaction.guildId)
        ) {
            logger.warn(Events.COMMAND_PERMISSION_DENIED, ctx, {
                message: `Rejected out-of-guild button interaction "${interaction.customId}"`,
            });
            await sendEphemeralError(
                interaction,
                'Oops, Error 404',
                logger,
                'BUTTON_ERROR_REPLY_FAILED',
                ctx,
            );
            return;
        }

        try {
            await logger.button(interaction.customId, { ...ctx, interaction }, async () => {
                await handler(interaction);
            });
        } catch {
            // logger.button() has already logged BUTTON_ERROR with full telemetry.
            await sendEphemeralError(
                interaction,
                '❌ There was an error handling that button.',
                logger,
                'BUTTON_ERROR_REPLY_FAILED',
                ctx,
            );
        }
    }
}

function stopAllCommandTimers(client) {
    if (!client?.commands) return;
    for (const command of client.commands.values()) {
        try {
            command.stopAllTimers?.();
        } catch {
            /* ignore cleanup error */
        }
    }
}

function stopGuildCommandTimers(client, guildId) {
    if (!client?.commands || !guildId) return;
    for (const command of client.commands.values()) {
        try {
            command.stopGuildTimers?.(guildId);
        } catch {
            /* ignore cleanup error */
        }
    }
}

/**
 * Builds a graceful shutdown handler that measures elapsed time AFTER cleanup
 * completes and flushes/closes all logger transports (including the file stream)
 * before exiting.
 */
function createGracefulShutdown({ client, logger, exit = (code) => process.exit(code), flushTimeoutMs = 5000, closeTimeoutMs = 3000 }) {
    let shutdownPromise = null;

    return function gracefulShutdown(signal) {
        if (shutdownPromise) return shutdownPromise;

        shutdownPromise = (async () => {
            const shutdownStartedAt = Date.now();
            logger.info(Events.BOT_SHUTDOWN, logger.fromInteraction(null, { signal }));

            stopAllCommandTimers(client);
            logger.stopBackgroundTasks();

            const queueStats = logger.getQueueStats();
            await logger.flushAll({ timeoutMs: flushTimeoutMs });

            try {
                await client.destroy();
            } catch {
                /* client already shutting down */
            }

            const shutdownDurationMs = Date.now() - shutdownStartedAt;
            const report = await logger.reportShutdown({ shutdownDurationMs, queueStats });
            await logger.close({ timeoutMs: closeTimeoutMs });

            exit(0);
            return report;
        })();

        return shutdownPromise;
    };
}

function loadCommands(client, logger, commandsPath = path.join(__dirname, 'commands')) {
    let commandsLoaded = 0;
    const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));

    for (const file of commandFiles) {
        try {
            // eslint-disable-next-line global-require, import/no-dynamic-require
            const command = require(path.join(commandsPath, file));
            client.commands.set(command.data.name, command);
            commandsLoaded++;

            if (command.buttons) {
                for (const [customId, handler] of Object.entries(command.buttons)) {
                    client.buttons.set(customId, handler);
                }
            }
        } catch (err) {
            logger.error('COMMAND_LOAD_ERROR', logger.fromInteraction(null, { file }), err);
        }
    }

    return commandsLoaded;
}

function startBot() {
    const processStartedAt = Date.now();

    const client = new Client({
        intents: [GatewayIntentBits.Guilds],
    });

    client.commands = new Collection();
    client.buttons = new Collection();

    const logger = createLogger({
        botVersion: pkg.version,
        shardId: 0,
    });
    client.logger = logger;

    const commandsLoaded = loadCommands(client, logger);

    let eventsLoaded = 0;
    function on(eventName, handler) {
        client.on(eventName, handler);
        eventsLoaded++;
    }

    client.once(DiscordEvents.ClientReady, async () => {
        client.user.setActivity('ls', { type: ActivityType.Listening });
        logger.info(Events.BOT_READY, logger.fromInteraction(null));

        const commandsData = client.commands.map((cmd) => cmd.data.toJSON());
        try {
            if (process.env.GUILD_ID) {
                const guild = await client.guilds.fetch(process.env.GUILD_ID);
                await guild.commands.set(commandsData);
                logger.info('COMMAND_REGISTER', logger.fromInteraction(null), {
                    message: `Registered ${commandsData.length} command(s)`,
                });
            } else {
                await client.application.commands.set(commandsData);
                logger.info('COMMAND_REGISTER', logger.fromInteraction(null), {
                    message: `Registered ${commandsData.length} command(s) globally`,
                });
            }
        } catch (err) {
            logger.error('COMMAND_REGISTER_ERROR', logger.fromInteraction(null, {
                guildId: process.env.GUILD_ID || undefined,
            }), err);
        }

        const webhooksConfigured = Object.values(logger.config.webhook.categories).filter(Boolean).length;
        await logger.reportStartup({
            client,
            commandsLoaded,
            eventsLoaded,
            webhooksConfigured,
            startupDurationMs: Date.now() - processStartedAt,
        });
    });

    on('interactionCreate', (interaction) => handleInteractionCreate(interaction, { client, logger }));

    // ---- gateway / shard telemetry (all fire under Guilds-only intent) ----
    on('error', (err) => logger.error(Events.GATEWAY_ERROR, logger.fromInteraction(null, {}), err));
    on('warn', () => logger.warn(Events.GATEWAY_ERROR, logger.fromInteraction(null, {}), { message: 'Discord gateway warning' }));
    on('shardError', (err) => logger.error(Events.SHARD_ERROR, logger.fromInteraction(null, {}), err));
    on('shardReady', () => logger.info(Events.SHARD_READY, logger.fromInteraction(null, {})));
    on('shardReconnecting', () => logger.warn(Events.GATEWAY_RECONNECT, logger.fromInteraction(null, {})));
    on('shardDisconnect', (event) => logger.warn(Events.GATEWAY_DISCONNECT, logger.fromInteraction(null, { code: event?.code })));
    // Guild IDs are used only transiently to clean up that guild's panel timers.
    on('guildDelete', (guild) => stopGuildCommandTimers(client, guild.id));

    // ---- process-level safety net ----
    const gracefulShutdown = createGracefulShutdown({ client, logger });

    process.on('unhandledRejection', (reason) => {
        logger.error(Events.UNHANDLED_REJECTION, logger.fromInteraction(null, {}), reason instanceof Error ? reason : new Error(String(reason)));
    });

    process.on('uncaughtException', async (err) => {
        stopAllCommandTimers(client);
        logger.fatal(Events.UNHANDLED_EXCEPTION, logger.fromInteraction(null, {}), err);
        try {
            await logger.close({ timeoutMs: 3000 });
        } finally {
            process.exit(1);
        }
    });

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    client.login(process.env.DISCORD_TOKEN).catch(async (err) => {
        stopAllCommandTimers(client);
        logger.fatal(Events.BOT_CRASH, logger.fromInteraction(null, {}), err);
        try {
            await logger.close({ timeoutMs: 3000 });
        } finally {
            process.exit(1);
        }
    });

    return { client, logger, gracefulShutdown };
}

if (require.main === module) {
    startBot();
}

module.exports = {
    startBot,
    loadCommands,
    handleInteractionCreate,
    createGracefulShutdown,
    stopAllCommandTimers,
    stopGuildCommandTimers,
};
