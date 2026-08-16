# ASUR 2.O Discord Bot

This is the complete standalone ASUR 2.O bot source package.

## Install and run

Requires **Node.js 22.12.0 or newer** (discord.js v14.27 will not start on older
versions, including Node 19, which is also end-of-life and unsupported).

```bash
npm install
npm start
```

For a production host, use the same start command:

```bash
npm start
```

### WispByte hosting

1. When creating the server, pick the **Node.js** Docker image and choose the
   highest available Node version in the dropdown (22.x or 24.x). Do not pick
   Node 19 — it's unsupported and too old for discord.js v14.27.
2. Upload/extract this project into the server's file manager (or connect the
   Git repo if WispByte's panel supports it).
3. In the panel's **Startup** tab, set the start command to `npm start`
   (it already runs `npm install` automatically on most Pterodactyl-based
   panels — if not, run `npm install` once from the console first).
4. Add `DISCORD_BOT_TOKEN` (and `MAIN_GUILD_ID` / `BACKUP_GUILD_ID` if you're
   overriding the defaults) under the **Environment/Variables** tab — never
   paste the token directly into `src/asur-bot.ts`.
5. Start the server from the panel console.

The bot token must be configured as a secret/environment variable:

```text
DISCORD_BOT_TOKEN
```

Never commit the real token to source control or put it directly inside
`src/asur-bot.ts`.

## Server mapping

```text
Main server:    1519742384865280070
Uploading server: 1534880845070864435
```

These can be overridden with `MAIN_GUILD_ID` and `BACKUP_GUILD_ID`.
Leading `-` characters are ignored if they are included when copying IDs.

## Discord Developer Portal setup

Enable these privileged intents:

- Message Content Intent
- Server Members Intent
- Guild Moderation Intent

Invite the bot with permissions for:

- View Channels
- Send Messages
- Read Message History
- Embed Links
- Attach Files
- Manage Webhooks
- Manage Channels
- Manage Roles
- Manage Messages
- Add Reactions
- Mention Everyone
- Kick Members
- Ban Members
- Moderate Members
- View Audit Log

Keep the bot role above roles it must assign or moderate.

## Automatic cross-upload

When an image is posted in a channel in the Uploading server, ASUR:

1. Downloads the image.
2. Strips its metadata by re-encoding it.
3. Adds `/S A T A N S` at 45% opacity with a 10-degree tilt.
4. Renames it to `SATANS_OWNS_YOU.<extension>`.
5. Posts it through a webhook in the original Uploading channel.
6. Uses Discord's native message-forward operation to forward that exact posted message
   to the same-named text channel in the Main server.

Discord displays its mandatory `Forwarded from` attribution on native forwards.

## Commands

```text
.help / .bas
.every <channel name or ID> <message>
.create <channel name> <category ID>
.lock [channel]
.unlock [channel]
.hide [channel]
.unhide [channel]
.automod on|off|status
.autorole <role mention or ID>
.autorole off
.autoreact <emoji> [channel]
.autoreact off
.antinuke on|off|status
.kick <user mention or ID> [reason]
.ban <user mention or ID> [reason]
.gwy start <10s|10m|1h|1d> <winners> <prize>
.gwy end <giveaway message ID>
.gwy reroll <giveaway message ID>
```

Guild configuration is saved in `data/asur-config.json`.