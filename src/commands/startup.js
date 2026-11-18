'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
    SlashCommandBuilder,
    ContainerBuilder,
    AttachmentBuilder,
    ButtonStyle,
    InteractionContextType,
    MessageFlags,
} = require('discord.js');
const pkg = require('../../package.json');

const DELETE_BUTTON_ID = 'p_339719003125583873';
const REFRESH_MS = 5000;
const MAX_TICKS = 9; // 9 x 5s = 45s of live updates, then the panel freezes
const MAX_ACTIVE_TIMERS = 500;

const DEFAULT_LOGO_NAME = 'linuxo-text-logo.png';
const DEFAULT_LOGO_PATH = path.resolve(__dirname, '../../Assets', DEFAULT_LOGO_NAME);

// Active refresh intervals tracked by interaction ID so delete, guild removal,
// and process shutdown can all cancel in-flight timers cleanly.
const activeTimers = new Map(); // interactionId -> { interval, guildId, stopped }

function formatUptime(ms) {
    const safeMs = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
    const totalSeconds = Math.floor(safeMs / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;

    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function isValidHttpsUrl(value) {
    if (!value || typeof value !== 'string') return false;
    try {
        const parsed = new URL(value.trim());
        return parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Resolve optional banner media without hardcoding any third-party CDN URL.
 * Prefers an explicit HTTPS `STARTUP_BANNER_URL` override when configured,
 * otherwise uses the repository's local `Assets/linuxo-text-logo.png` via
 * Discord attachment reference, or gracefully omits media if unavailable.
 */
function resolvePanelMedia({ bannerUrl = process.env.STARTUP_BANNER_URL, logoPath = DEFAULT_LOGO_PATH } = {}) {
    if (isValidHttpsUrl(bannerUrl)) {
        return { mediaUrl: bannerUrl.trim(), file: null };
    }

    if (logoPath) {
        try {
            fs.accessSync(logoPath, fs.constants.R_OK);
            const name = path.basename(logoPath);
            return {
                mediaUrl: `attachment://${name}`,
                file: new AttachmentBuilder(logoPath, { name }),
            };
        } catch {
            // Local asset missing/unreadable — render the panel cleanly without media.
        }
    }

    return { mediaUrl: null, file: null };
}

function buildPanel(client, { mediaUrl = null } = {}) {
    const uptime = formatUptime(client?.uptime);
    // client.ws.ping only updates when a heartbeat ack comes in (~every 30-40s),
    // so it can repeat across a couple of refreshes — that's expected.
    const rawPing = client?.ws?.ping;
    const ping = typeof rawPing === 'number' && rawPing >= 0 ? `${rawPing}ms` : 'calculating...';

    const container = new ContainerBuilder();

    if (mediaUrl) {
        container
            .addMediaGalleryComponents((gallery) => gallery
                .addItems((mediaGalleryItem) => mediaGalleryItem.setURL(mediaUrl)))
            .addSeparatorComponents((separator) => separator.setDivider(true));
    }

    return container
        .addSectionComponents((section) => section
            .addTextDisplayComponents(
                (textDisplay) => textDisplay
                    .setContent(`## 🐧 Linuxo\n\n**Linuxo Bot**\nVersion: \`v${pkg.version}\`\nStatus: 🟢 Online\nUptime: \`${uptime}\`\nLatency: \`${ping}\`\n\n\`linuxo@discord:~$\``),
            )
            .setButtonAccessory((button) => button
                .setStyle(ButtonStyle.Secondary)
                .setCustomId(DELETE_BUTTON_ID)
                .setLabel('Ctrl + C')))
        .addSeparatorComponents((separator) => separator.setDivider(true))
        .addTextDisplayComponents((textDisplay) => textDisplay
            .setContent('-# 2026 Linuxo owned by MoonX <3'));
}

function stopTimer(timerKey) {
    if (!timerKey) return false;
    const entry = activeTimers.get(timerKey);
    if (!entry) return false;
    entry.stopped = true;
    clearInterval(entry.interval);
    activeTimers.delete(timerKey);
    return true;
}

function stopGuildTimers(guildId) {
    if (!guildId) return 0;
    let cleared = 0;
    for (const [key, entry] of activeTimers.entries()) {
        if (entry.guildId === guildId) {
            entry.stopped = true;
            clearInterval(entry.interval);
            activeTimers.delete(key);
            cleared++;
        }
    }
    return cleared;
}

function stopAllTimers() {
    const count = activeTimers.size;
    for (const entry of activeTimers.values()) {
        entry.stopped = true;
        clearInterval(entry.interval);
    }
    activeTimers.clear();
    return count;
}

function getActiveTimerCount() {
    return activeTimers.size;
}

function isAlreadyDeletedError(err) {
    return err?.code === 10008 || err?.rawError?.code === 10008 || err?.status === 404;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('startup')
        .setDescription('Show the Linuxo startup panel')
        .setContexts(InteractionContextType.Guild),

    async execute(interaction, options = {}) {
        const refreshMs = options.refreshMs ?? REFRESH_MS;
        const maxTicks = options.maxTicks ?? MAX_TICKS;
        const media = resolvePanelMedia(options.media);
        let activeMediaUrl = media.mediaUrl;

        const initialPayload = {
            components: [buildPanel(interaction.client, { mediaUrl: activeMediaUrl })],
            flags: MessageFlags.IsComponentsV2,
        };
        if (media.file) {
            initialPayload.files = [media.file];
        }

        try {
            await interaction.reply(initialPayload);
        } catch (err) {
            // If media caused the initial reply failure and we haven't replied yet,
            // fall back cleanly to the media-free panel instead of failing outright.
            if (activeMediaUrl && !interaction.replied && !interaction.deferred) {
                activeMediaUrl = null;
                await interaction.reply({
                    components: [buildPanel(interaction.client, { mediaUrl: null })],
                    flags: MessageFlags.IsComponentsV2,
                });
            } else {
                throw err;
            }
        }

        const timerKey = interaction.id || `anon_${Date.now()}_${Math.random()}`;
        stopTimer(timerKey);

        if (activeTimers.size >= MAX_ACTIVE_TIMERS) {
            const oldestKey = activeTimers.keys().next().value;
            stopTimer(oldestKey);
        }

        let ticks = 0;
        let inFlight = false;
        const entry = {
            interval: null,
            guildId: interaction.guildId ?? null,
            stopped: false,
        };

        const interval = setInterval(async () => {
            if (entry.stopped || inFlight) return;
            inFlight = true;
            ticks++;
            try {
                await interaction.editReply({
                    components: [buildPanel(interaction.client, { mediaUrl: activeMediaUrl })],
                    flags: MessageFlags.IsComponentsV2,
                });
            } catch {
                stopTimer(timerKey);
                inFlight = false;
                return;
            }
            inFlight = false;
            if (ticks >= maxTicks) {
                stopTimer(timerKey);
            }
        }, refreshMs);

        // Never hold the Node.js event loop open during shutdown.
        interval.unref?.();
        entry.interval = interval;
        activeTimers.set(timerKey, entry);
    },

    buttons: {
        [DELETE_BUTTON_ID]: async (interaction) => {
            const message = interaction.message;
            const invokerId = message?.interactionMetadata?.user?.id;
            const userId = interaction.user?.id;

            // Enforce strict guild isolation when the panel belongs to a guild.
            if (message?.guildId && interaction.guildId !== message.guildId) {
                await interaction.reply({
                    content: 'Oops, Error 404',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // Fail closed: deny whenever the original invoker cannot be verified
            // or differs from the user clicking the button.
            if (!invokerId || !userId || invokerId !== userId) {
                await interaction.reply({
                    content: 'Oops, Error 404',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // Cancel any remaining refresh ticks for this panel immediately.
            stopTimer(message?.interactionMetadata?.id);

            await interaction.deferUpdate();
            try {
                await message.delete();
            } catch (err) {
                if (isAlreadyDeletedError(err)) {
                    return;
                }
                throw err;
            }
        },
    },

    // Exported helpers for lifecycle management and unit testing.
    DELETE_BUTTON_ID,
    DEFAULT_LOGO_PATH,
    formatUptime,
    resolvePanelMedia,
    buildPanel,
    stopTimer,
    stopGuildTimers,
    stopAllTimers,
    getActiveTimerCount,
};
