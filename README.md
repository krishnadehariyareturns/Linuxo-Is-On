<div align="center">
  <img
    src="Assets/linuxo-text-logo.png"
    alt="Linuxo logo"
    width="100%"
  />

<p align="center">Discord but with a little more Linux</p>

<p align="center">
  <img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/Krishnadehariyareturns/Linuxo-Is-On/main/stats/monthly-commits.json" alt="Monthly commits" />
  <br />
  <a href="#"><img src="https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white" alt="Discord" /></a>
  <br />
  <img src="https://img.shields.io/github/stars/Krishnadehariyareturns/Linuxo-Is-On?style=flat&color=2ea44f" alt="Stars" />
  <img src="https://img.shields.io/github/forks/Krishnadehariyareturns/Linuxo-Is-On?style=flat&color=gray" alt="Forks" />
  <img src="https://img.shields.io/github/issues/Krishnadehariyareturns/Linuxo-Is-On?style=flat&color=2ea44f" alt="Issues" />
  <img src="https://img.shields.io/github/last-commit/Krishnadehariyareturns/Linuxo-Is-On?style=flat&color=gray" alt="Last Commit" />
</p>

![Commit activity](https://raw.githubusercontent.com/Krishnadehariyareturns/Linuxo-Is-On/main/stats/commit-activity.svg)

</div>

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` (from the [Discord Developer Portal](https://discord.com/developers/applications)). Add `GUILD_ID` too if you want `/startup` to appear in your server immediately.
3. In the Developer Portal's OAuth2 URL Generator: check `bot` + `applications.commands`, and under bot permissions check `Send Messages`, `Embed Links`, `Attach Files`. Use the generated link to invite the bot.
4. `npm start`

No privileged intents needed — the bot only requests `Guilds`.

## What's here

- `/startup` — guild-only command that posts the Linuxo status panel (Discord Components V2). Uptime and latency refresh every 5s for 45s using an unref'd timer (automatically cancelled on panel delete, guild removal, or bot shutdown), then freeze.
  - Displays the bundled local `Assets/linuxo-text-logo.png` by default (configurable via `STARTUP_BANNER_URL`, with automatic fallback to a media-free panel if unavailable).
  - Latency is `client.ws.ping`, which only updates on Discord's heartbeat ack (~every 30–40s), so it can repeat across a couple of refreshes — that's expected.
  - The "Ctrl + C" button deletes the panel message with fail-closed authorization: only the verified original `/startup` invoker in the same guild can delete it; anyone else (or a message with missing interaction metadata) receives an ephemeral `Oops, Error 404` reply.
- Rich presence set to "Listening to ls" on boot.
- Slash commands auto-register on startup — to your `GUILD_ID` if set, globally otherwise.
- A structured Components V2 logging/telemetry system (`src/lib/forensic-logger/`) instrumenting every command and button automatically — see below.

## Logging & privacy

Linuxo keeps diagnostic logs deliberately small. By default, it writes operational logs to the console only. It does not store user profiles or message history.

**Records may contain:**
- slash-command name and optional subcommand (never command option values);
- event timestamp, severity, outcome, and command duration;
- sanitised error name, message, numeric code, and HTTP status (no stack traces);
- bot and Node.js versions; and
- aggregate command counts and timings in the shutdown report.

**Records do not contain:** Discord user IDs or tags, server IDs or names, channel IDs, interaction IDs, button custom IDs, raw message content, member lists, hostnames, process IDs, or shard IDs. Gateway warning text is reduced to a generic diagnostic message.

A few Discord identifiers are used **temporarily in memory** for the `/startup` delete-button permission check and to manage short-lived panel refresh timers. The code does not add those identifiers to log records or save them as user data. Timer entries are cleared when the panel expires, is deleted, the bot shuts down, or the bot leaves the relevant server.

**Privacy-first defaults:**
- Webhook log delivery is **disabled**. To opt in, set `LOG_WEBHOOK_ENABLED=true` and configure the required `LOG_WEBHOOK_*` URLs.
- Local file logging is disabled unless `LOG_FILE` is set.
- Redaction is always enabled and cannot be disabled through environment variables or logger overrides. It removes sensitive structured fields and scrubs common credentials, emails, IP addresses, and long numeric identifiers from strings.
- Memory/event-loop sampling is disabled by default. Enable it with `LOG_INCLUDE_MEMORY=true` only when needed.
- Periodic performance summaries are disabled by default (`LOG_SUMMARY_INTERVAL_MS=0`).

If webhook delivery is enabled, webhook messages are scheduled for deletion after 14 days by default. This does not erase copies retained by Discord, hosting providers, backups, container logs, or external log collectors. Optional local-file retention must be configured separately by the host/operator.

**Logger extension points:** `logger.registerHealthCheck(name, async () => ({ ok, detail }))` adds a startup health check. `logger.task({ event, errorEvent, context, handler })` wraps future database or external-service work. Do not pass user content or raw Discord interaction objects into log context.

The event taxonomy includes message/member event names for possible future expansion, but the current bot does not subscribe to those events or request the privileged intents needed for them.
Run `npm test` to execute the automated test suite.
