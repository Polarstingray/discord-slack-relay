require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, WebhookClient } = require("discord.js");
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
  if (c.discordChannelId.startsWith("<") || c.slackChannelId.startsWith("<")) {
    console.warn(
      `Skipping channel mapping "${c.name}" — placeholder not filled in yet.`
    );
    continue;
  }
  DISCORD_TO_SLACK.set(c.discordChannelId, c.slackChannelId);
  SLACK_TO_DISCORD.set(c.slackChannelId, c.discordChannelId);
}

console.log(`Loaded ${DISCORD_TO_SLACK.size} channel mapping(s).`);

// Per-Discord-channel webhook cache, so Slack->Discord messages can show the
// real Slack sender's name/avatar instead of the bot's own identity.
const webhookCache = new Map(); // discordChannelId -> WebhookClient

// Simple cache of Slack user info so we don't re-fetch on every message.
const slackUserCache = new Map(); // slackUserId -> { name, image }

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
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

    // We don't rely on chat:write.customize (username/icon_url overrides) —
    // it's not always available/approved on every workspace. Instead we
    // prefix the real sender's name directly in the message text, which
    // only needs the base chat:write scope and always works.
    const text = `*${displayName} (Discord):* ${body}`;

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
  if (slackUserCache.has(userId)) return slackUserCache.get(userId);

  const info = await slackApp.client.users.info({ user: userId });
  const profile = info.user?.profile || {};
  const result = {
    name: profile.display_name || profile.real_name || info.user?.name || "Slack user",
    image: profile.image_72 || profile.image_48 || null,
  };
  slackUserCache.set(userId, result);
  return result;
}

slackApp.message(async ({ message, client }) => {
  try {
    // Ignore anything that isn't a plain user message (bot messages, edits,
    // deletes, thread broadcasts metadata, etc.) and anything from this bot
    // itself, to avoid echo loops.
    if (message.subtype) return;
    if (!("user" in message) || !message.user) return;
    if (slackBotUserId && message.user === slackBotUserId) return;

    const discordChannelId = SLACK_TO_DISCORD.get(message.channel);
    if (!discordChannelId) return; // not a bridged channel

    const text = message.text || "";
    if (!text.trim()) return;

    const userInfo = await getSlackUserInfo(message.user);
    const webhook = await getOrCreateWebhook(discordChannelId);

    await webhook.send({
      content: text,
      username: `${userInfo.name} (Slack)`,
      avatarURL: userInfo.image || undefined,
    });
  } catch (err) {
    console.error("Error relaying Slack -> Discord:", err);
  }
});

// ---------------------------------------------------------------------------
// Start everything
// ---------------------------------------------------------------------------

(async () => {
  await discord.login(DISCORD_TOKEN);

  await slackApp.start();
  const auth = await slackApp.client.auth.test();
  slackBotUserId = auth.user_id;
  console.log(`Slack connected as ${auth.user} (${slackBotUserId}) via Socket Mode`);

  console.log("Relay is running.");
})().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
