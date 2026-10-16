# discord-slack-relay

A small Node.js bot that mirrors messages both ways between paired Discord and Slack channels. Everything lives in `index.js`, and it runs as a single Docker container.

## How it works

```
 Discord channel  ──(bot reads message)──▶  relay  ──(chat.postMessage)──▶  Slack channel
 Discord channel  ◀──(channel webhook)────  relay  ◀──(Socket Mode event)──  Slack channel
```

- **Discord → Slack**: The Discord bot listens for `messageCreate` in mapped channels and posts the text to the paired Slack channel as `*Name (Discord):* message`. Attachments are sent as Discord CDN links. Only the basic `chat:write` scope is needed, because the bot puts the sender's name in the message text instead of using `chat:write.customize`.
- **Slack → Discord**: The Slack app connects over **Socket Mode**, which uses an outbound websocket, so you don't need a public URL or open ports. When a message arrives, the relay looks up the sender's display name and avatar with `users.info` and posts it to Discord through a channel webhook called `slack-bridge`. The message shows up as `Name (Slack)` with that user's avatar. If the webhook doesn't exist yet, the relay creates it.
- **Loop prevention**: On the Discord side the relay ignores bot authors and webhook posts, which includes its own. On the Slack side it ignores messages that have a `subtype` (bots, edits, deletes) and messages from its own bot user.
- **Caches**: Webhooks and Slack user info are cached in memory. A restart clears them, and they rebuild on their own.

### Limitations
- Edits, deletes, reactions and threads are not relayed. Slack thread replies show up in Discord as top-level messages.
- Files uploaded in Slack are not relayed, only message text.
- Mentions and Slack-specific formatting (`<@U123>`, `<#C123>`) come through as raw text.

## Files

| File | Purpose |
|---|---|
| `index.js` | The relay itself |
| `channels.json` | Discord ↔ Slack channel pairs |
| `env.example` | Template for `.env` (tokens) |
| `Dockerfile` / `docker-compose.yml` | Container build and run |
| `index.js.bak` | Older version that set a custom Slack username and avatar (needed `chat:write.customize`) |
| `gitignore` | Ignores `node_modules/` and `.env`. It has to be renamed to `.gitignore` to take effect. |

## Channel mapping

`channels.json` is a list of pairs:

```json
{ "name": "general", "discordChannelId": "1552…", "slackChannelId": "C0C9…" }
```

- `name` is only a label for your reference.
- If either ID still starts with `<` (a placeholder), that pair is skipped with a warning.
- Discord channel ID: turn on Developer Mode, then right-click the channel → *Copy Channel ID*.
- Slack channel ID: open the channel details. The ID is at the bottom.
- The Slack bot has to be **invited** to each Slack channel (`/invite @yourbot`).

## Setup

### 1. Discord bot
In the [Discord Developer Portal](https://discord.com/developers/applications):
- Create an application and add a bot, then copy its token into `DISCORD_BOT_TOKEN`.
- Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
- Invite the bot to your server with **View Channels**, **Read Message History**, **Send Messages** and **Manage Webhooks** permissions.

### 2. Slack app
In [api.slack.com/apps](https://api.slack.com/apps):
- Enable **Socket Mode**. Generate an app-level token with the `connections:write` scope and put it in `SLACK_APP_TOKEN` (`xapp-…`).
- Under **OAuth & Permissions**, add these bot scopes: `chat:write`, `users:read`, `channels:history`. If you bridge private channels, also add `groups:history`.
- Under **Event Subscriptions**, subscribe to the bot events `message.channels` and, for private channels, `message.groups`.
- Install the app to the workspace and copy the Bot User OAuth Token into `SLACK_BOT_TOKEN` (`xoxb-…`).

### 3. Configure and run
```bash
cp env.example .env        # fill in the three tokens
# edit channels.json with your channel pairs
docker compose up -d --build
docker compose logs -f     # expect "Relay is running."
```

To run it without Docker: `npm install && npm start`.

## Operating

- **Change channel mappings**: Edit `channels.json`, then `docker compose restart`. The file is mounted read-only into the container and only read at startup.
- **Change code**: `docker compose up -d --build`.
- **Logs**: Relay errors are logged to stdout as `Error relaying Discord -> Slack` or `Error relaying Slack -> Discord`. If the relay hits an error at startup or a required token is missing, it exits, and Docker restarts it (`restart: unless-stopped`).
