require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, WebhookClient } = require("discord.js");
const { App, LogLevel } = require("@slack/bolt");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CHANNELS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "channels.json"), "utf8")
);

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;

if (!DISCORD_TOKEN || !SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error(
    "Missing required env vars. Need DISCORD_BOT_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN."
  );
  process.exit(1);
}

const DISCORD_TO_SLACK = new Map(); // discordChannelId -> slackChannelId
const SLACK_TO_DISCORD = new Map(); // slackChannelId -> discordChannelId

for (const c of CHANNELS) {
  if (!c.discordChannelId || !c.slackChannelId) {
    console.warn(`Skipping channel mapping "${c.name}" — missing ID fields.`);
    continue;
  }
  if (c.discordChannelId.startsWith("<") || c.slackChannelId.startsWith("<")) {
    console.warn(
      `Skipping channel mapping "${c.name}" — placeholder not filled in yet.`
    );
    continue;
  }
  if (DISCORD_TO_SLACK.has(c.discordChannelId) || SLACK_TO_DISCORD.has(c.slackChannelId)) {
    console.warn(`Duplicate channel ID in mapping "${c.name}" — overwriting previous entry.`);
  }
  DISCORD_TO_SLACK.set(c.discordChannelId, c.slackChannelId);
  SLACK_TO_DISCORD.set(c.slackChannelId, c.discordChannelId);
}

console.log(`Loaded ${DISCORD_TO_SLACK.size} channel mapping(s).`);

// Per-Discord-channel webhook cache, so Slack->Discord messages can show the
// real Slack sender's name/avatar instead of the bot's own identity.
const webhookCache = new Map(); // discordChannelId -> WebhookClient

// Cache of Slack user info with a 1-hour TTL so name/avatar changes take effect.
const slackUserCache = new Map(); // slackUserId -> { name, image, cachedAt }
const SLACK_USER_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Escape Slack mrkdwn characters that trigger mentions or link parsing.
function escapeSlack(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Discord webhook limits.
const DISCORD_USERNAME_MAX = 80;
const DISCORD_CONTENT_MAX = 2000;

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function getOrCreateWebhook(channelId) {
  if (webhookCache.has(channelId)) return webhookCache.get(channelId);

  const channel = await discord.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Discord channel ${channelId} not found or not text-based`);
  }

  const existing = await channel.fetchWebhooks();
  let webhook = existing.find((w) => w.name === "slack-bridge");

  if (!webhook) {
    webhook = await channel.createWebhook({
      name: "slack-bridge",
      reason: "Relay messages from Slack",
    });
    console.log(`Created webhook for Discord channel ${channelId}`);
  }

  if (!webhook.token) {
    throw new Error(
      `Webhook "slack-bridge" in channel ${channelId} has no token — it was created by another app and cannot be used.`
    );
  }

  const client = new WebhookClient({ id: webhook.id, token: webhook.token });
  webhookCache.set(channelId, client);
  return client;
}

discord.once("ready", () => {
  console.log(`Discord connected as ${discord.user.tag}`);
});

discord.on("messageCreate", async (message) => {
  try {
    // Ignore bots (including ourselves) and anything posted through our
    // own relay webhook, to avoid echo loops.
    if (message.author.bot) return;
    if (message.webhookId) return;

    const slackChannelId = DISCORD_TO_SLACK.get(message.channelId);
    if (!slackChannelId) return; // not a bridged channel

    const displayName = message.member?.displayName || message.author.username;

    let body = message.content || "";

    // Relay attachments as links since Slack can't fetch Discord CDN files
    // through chat.postMessage directly.
    if (message.attachments.size > 0) {
      const links = [...message.attachments.values()].map((a) => a.url).join("\n");
      body = body ? `${body}\n${links}` : links;
    }

    if (!body.trim()) return;

    // Escape < > & to prevent Discord text from injecting Slack mentions
    // (<!channel>, <!here>, <@U…>) when relayed via chat.postMessage.
    const text = `*${escapeSlack(displayName)} (Discord):* ${escapeSlack(body)}`;

    await slackApp.client.chat.postMessage({
      channel: slackChannelId,
      text,
    });
  } catch (err) {
    console.error("Error relaying Discord -> Slack:", err);
  }
});

// ---------------------------------------------------------------------------
// Slack app (Socket Mode)
// ---------------------------------------------------------------------------

const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.WARN,
});

let slackBotUserId = null;

async function getSlackUserInfo(userId) {
  const cached = slackUserCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < SLACK_USER_CACHE_TTL) {
    return { name: cached.name, image: cached.image };
  }

  const info = await slackApp.client.users.info({ user: userId });
  const profile = info.user?.profile || {};
  const result = {
    name: profile.display_name || profile.real_name || info.user?.name || "Slack user",
    image: profile.image_72 || profile.image_48 || null,
    cachedAt: Date.now(),
  };
  slackUserCache.set(userId, result);
  return result;
}

slackApp.message(async ({ message }) => {
  try {
    // Ignore anything that isn't a plain user message (bot messages, edits,
    // deletes, thread broadcasts metadata, etc.) and anything from this bot
    // itself, to avoid echo loops.
    // The relay's own chat.postMessage calls arrive with subtype "bot_message",
    // so they are caught by the subtype check even before slackBotUserId is set.
    if (message.subtype) return;
    if (!("user" in message) || !message.user) return;
    if (slackBotUserId && message.user === slackBotUserId) return;

    const discordChannelId = SLACK_TO_DISCORD.get(message.channel);
    if (!discordChannelId) return; // not a bridged channel

    const text = message.text || "";
    if (!text.trim()) return;

    const userInfo = await getSlackUserInfo(message.user);

    // Discord caps webhook usernames at 80 characters and content at 2000.
    const username = `${userInfo.name} (Slack)`.slice(0, DISCORD_USERNAME_MAX);
    const content =
      text.length > DISCORD_CONTENT_MAX
        ? `${text.slice(0, DISCORD_CONTENT_MAX - 1)}…`
        : text;

    const sendPayload = {
      content,
      username,
      avatarURL: userInfo.image || undefined,
      // Suppress all mention parsing so Slack @-mentions don't ping Discord users.
      allowedMentions: { parse: [] },
    };

    let webhook = await getOrCreateWebhook(discordChannelId);
    try {
      await webhook.send(sendPayload);
    } catch (err) {
      // Discord error 10015 = Unknown Webhook (deleted externally). Drop the
      // cache entry and retry once with a fresh webhook.
      if (err.code === 10015) {
        webhookCache.delete(discordChannelId);
        webhook = await getOrCreateWebhook(discordChannelId);
        await webhook.send(sendPayload);
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error("Error relaying Slack -> Discord:", err);
  }
});

// ---------------------------------------------------------------------------
// Start everything
// ---------------------------------------------------------------------------

(async () => {
  await discord.login(DISCORD_TOKEN);

  // Resolve the bot's own Slack user ID before starting the listener so the
  // loop-prevention check is never racing against incoming messages.
  // (Bot messages also carry subtype "bot_message" and are filtered there,
  // but having the user ID set immediately makes the guard fully reliable.)
  const auth = await slackApp.client.auth.test();
  slackBotUserId = auth.user_id;

  await slackApp.start();
  console.log(`Slack connected as ${auth.user} (${slackBotUserId}) via Socket Mode`);

  console.log("Relay is running.");
})().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
