<h1 align="center">Linuxo</h1>

Discord but with a little more Linux

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

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` (from the [Discord Developer Portal](https://discord.com/developers/applications)). Add `GUILD_ID` too if you want `/startup` to appear in your guild immediately.
3. In the Developer Portal's OAuth2 URL Generator: check `bot` + `applications.commands`, and under bot permissions check `Send Messages`, `Embed Links`, `Attach Files`. Use the generated link to invite the bot.
4. `npm start`

No privileged intents needed — the bot only requests `Guilds`.

## What's here

- `/startup` — posts the Linuxo status panel (Components V2). Uptime and latency refresh every 5s for 45s, then freeze.
  - Latency is `client.ws.ping`, which only updates on Discord's heartbeat ack (~every 30-40s), so it can repeat across a couple of refreshes — that's expected.
  - The "Ctrl + C" button deletes the panel message, but only for whoever ran `/startup`. Anyone else who clicks it gets an ephemeral "Oops, Error 404" reply.
- Rich presence set to "Listening to ls" on boot.
- Slash commands auto-register on startup — to your `GUILD_ID` if set, global otherwise.
- A structured logging/telemetry system (`lib/logger/`) instrumenting every command and button automatically — see below.

## Logging & telemetry

Every slash command and button click is wrapped automatically — you don't need to touch `commands/*.js` to get this. It logs to the console always, and optionally to Discord webhooks and/or a local JSON log file.

**Setup:** fill in whichever `LOG_WEBHOOK_*` URLs you want in `.env` (create them under a channel's Settings → Integrations → Webhooks). None are required — with all blank, you still get full console + JSON telemetry.

**What you get, with zero code changes:**
- `COMMAND_START` / `COMMAND_END` / `COMMAND_ERROR` for every slash command, with duration, trace ID, guild/user, and (on failure) a normalized error — printed as a report box in dev console, JSON into a file, and optionally shipped to Discord webhooks.
- The same for buttons (`BUTTON_START`/`BUTTON_END`/`BUTTON_ERROR`).
- A startup diagnostics report and a shutdown report (on `SIGINT`/`SIGTERM`) with command counts, success/failure totals, and p50/p95/p99-style latency stats.
- Automatic secret redaction (tokens, passwords, webhook URLs, etc.) before anything is logged anywhere.
- Slow-command detection, error deduplication (repeats of the same failure get suppressed on Discord, never in the console/JSON record), retry+backoff and a circuit breaker for webhook delivery, and bot-health summaries.

**Extension points, for when this bot grows:**
- `logger.registerHealthCheck(name, async () => ({ok, detail}))` — wire up a database/cache/external-service check; it shows up in the startup report automatically. Nothing's registered today since the bot is intentionally minimal.
- `logger.task({event, errorEvent, context, handler})` — the same wrapping pattern as commands, for future DB queries or external API calls (`Events.DATABASE_QUERY`/`DATABASE_ERROR`, `EXTERNAL_API_REQUEST`, etc.).
- Inside a command handler, `interaction.client.logger.contextFor(interaction)` returns the live context object for that call — set `.metrics.apiCalls` / `.metrics.cache` on it to have those numbers appear in logs and diagnostics.
- Message/member events (`MESSAGE_CREATE`, `MEMBER_JOIN`, etc.) are defined in the event taxonomy but not wired up, since they need privileged intents (`GuildMessages`/`MessageContent`, `GuildMembers`, etc.).

Run `npm test` to run the logger's own test suite (95 tests covering redaction, error handling, the webhook queue/retry/circuit-breaker, and the full logging pipeline).
