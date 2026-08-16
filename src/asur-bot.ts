import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import {
  AuditLogEvent,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
  type Webhook,
} from "discord.js";

const PREFIX = ".";
const WATERMARK_TEXT = "/S A T A N S";
const WEBHOOK_NAME = "ASUR 2.O Cross Upload";
const CONFIG_PATH = process.env.ASUR_CONFIG_PATH ?? join(process.cwd(), "data", "asur-config.json");

// The leading minus signs in the original server IDs are stripped because Discord snowflakes are positive strings.
const MAIN_GUILD_ID = normalizeId(process.env.MAIN_GUILD_ID ?? "1519742384865280070");
const BACKUP_GUILD_ID = normalizeId(process.env.BACKUP_GUILD_ID ?? "1534880845070864435");

type AutoReactConfig = {
  emoji: string;
  channelId?: string;
};

type GuildConfig = {
  automodEnabled: boolean;
  antinukeEnabled: boolean;
  autoroleId?: string;
  autoreact?: AutoReactConfig;
};

type GiveawayState = {
  messageId: string;
  guildId: string;
  channelId: string;
  prize: string;
  winnerCount: number;
  endsAt: number;
};

type PersistedState = {
  guilds: Record<string, Partial<GuildConfig>>;
  giveaways: Record<string, GiveawayState>;
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent,
  ],
});

const state: PersistedState = {
  guilds: {},
  giveaways: {},
};
const giveawayTimers = new Map<string, NodeJS.Timeout>();
const antinukeEvents = new Map<string, number[]>();
const recentMessageFingerprints = new Map<string, { content: string; at: number }[]>();

function normalizeId(value: string): string {
  return value.trim().replace(/^[-+]/, "");
}

function getGuildConfig(guildId: string): GuildConfig {
  const saved = state.guilds[guildId] ?? {};
  return {
    automodEnabled: saved.automodEnabled ?? true,
    antinukeEnabled: saved.antinukeEnabled ?? false,
    autoroleId: saved.autoroleId,
    autoreact: saved.autoreact,
  };
}

async function loadState(): Promise<void> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    Object.assign(state, {
      guilds: parsed.guilds ?? {},
      giveaways: parsed.giveaways ?? {},
    });
  } catch {
    // A first run has no config file yet.
  }
}

async function saveState(): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(state, null, 2), "utf8");
}

function isTextChannel(channel: unknown): channel is TextChannel {
  return Boolean(channel && typeof channel === "object" && "type" in channel && channel.type === ChannelType.GuildText);
}

function isModerator(message: Message, permission: bigint): boolean {
  return Boolean(
    message.guild &&
      (message.guild.ownerId === message.author.id ||
        message.member?.permissions.has(permission) ||
        message.member?.permissions.has(PermissionFlagsBits.Administrator)),
  );
}

async function requirePermission(message: Message, permission: bigint, label: string): Promise<boolean> {
  if (isModerator(message, permission)) return true;
  await message.reply({
    content: `You need **${label}** permission to use this command.`,
    allowedMentions: { repliedUser: false },
  });
  return false;
}

function stripMention(value: string): string {
  return value.replace(/^<#(\d+)>$/, "$1").replace(/^<@&(\d+)>$/, "$1").replace(/^<@!?(\d+)>$/, "$1");
}

async function resolveTextChannel(guild: Guild, input: string | undefined, fallback?: TextChannel): Promise<TextChannel | undefined> {
  if (!input) return fallback;
  const cleaned = stripMention(input).toLowerCase();
  const channels = await guild.channels.fetch();
  return channels.find(
    (channel): channel is TextChannel =>
      isTextChannel(channel) && (channel.id === cleaned || channel.name.toLowerCase() === cleaned),
  );
}

function channelLabel(channel: TextChannel): string {
  return `<#${channel.id}>`;
}

async function getOrCreateWebhook(channel: TextChannel): Promise<Webhook> {
  const webhooks = await channel.fetchWebhooks();
  const existing = webhooks.find((hook) => hook.name === WEBHOOK_NAME && hook.owner?.id === client.user?.id);
  if (existing) return existing;

  return channel.createWebhook({
    name: WEBHOOK_NAME,
    avatar: client.user?.displayAvatarURL(),
    reason: "ASUR 2.O cross-upload automation",
  });
}

function isImageAttachment(attachment: { contentType?: string | null; name: string }): boolean {
  return Boolean(
    attachment.contentType?.startsWith("image/") ||
      /\.(png|jpe?g|webp|gif|avif|tiff?)$/i.test(attachment.name),
  );
}

function escapeSvgText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function watermarkAndStripMetadata(
  url: string,
  originalName: string,
  suffix: string,
): Promise<{ attachment: Buffer; name: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Attachment download failed with ${response.status}`);
  }

  const input = Buffer.from(await response.arrayBuffer());
  const source = sharp(input, { failOn: "none" });
  const metadata = await source.metadata();
  const width = metadata.width ?? 1600;
  const height = metadata.height ?? 900;
  const fontSize = Math.max(28, Math.round(Math.min(width, height) / 9));
  const watermark = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <g transform="translate(${width / 2} ${height / 2}) rotate(-10)">
        <text
          x="0"
          y="0"
          text-anchor="middle"
          dominant-baseline="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${fontSize}"
          font-weight="700"
          letter-spacing="${Math.max(2, Math.round(fontSize / 12))}"
          fill="#ffffff"
          fill-opacity="0.45"
          stroke="#000000"
          stroke-opacity="0.15"
          stroke-width="${Math.max(1, Math.round(fontSize / 30))}"
        >${escapeSvgText(WATERMARK_TEXT)}</text>
      </g>
    </svg>
  `);

  const format = metadata.format;
  const pipeline = source.rotate().composite([{ input: watermark, blend: "over" }]);
  let output: Buffer;
  let extension: string;

  if (format === "png") {
    output = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    extension = "png";
  } else if (format === "webp") {
    output = await pipeline.webp({ quality: 92 }).toBuffer();
    extension = "webp";
  } else if (format === "avif") {
    output = await pipeline.avif({ quality: 85 }).toBuffer();
    extension = "avif";
  } else {
    output = await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    extension = "jpg";
  }

  const originalExtension = originalName.includes(".") ? originalName.split(".").pop() : extension;
  const finalExtension = format === "gif" ? "jpg" : extension || originalExtension;
  return {
    attachment: output,
    name: `SATANS_OWNS_YOU${suffix}.${finalExtension}`,
  };
}

async function findSameNamedChannel(guild: Guild, channelName: string): Promise<TextChannel | undefined> {
  const channels = await guild.channels.fetch();
  return channels.find(
    (channel): channel is TextChannel => isTextChannel(channel) && channel.name === channelName,
  );
}

async function crossUpload(message: Message): Promise<void> {
  if (message.author.bot || message.guildId !== BACKUP_GUILD_ID || !message.attachments.size) return;
  const imageAttachments = [...message.attachments.values()].filter(isImageAttachment);
  if (!imageAttachments.length) return;

  const files: { attachment: Buffer; name: string }[] = [];
  for (const [index, attachment] of imageAttachments.entries()) {
    try {
      files.push(
        await watermarkAndStripMetadata(
          attachment.url,
          attachment.name,
          imageAttachments.length > 1 ? `_${index + 1}` : "",
        ),
      );
    } catch (error) {
      console.error("[ASUR] Could not process attachment:", error);
    }
  }
  if (!files.length || !isTextChannel(message.channel)) return;

  const mainGuild = await client.guilds.fetch(MAIN_GUILD_ID).catch(() => undefined);
  const destination = mainGuild ? await findSameNamedChannel(mainGuild, message.channel.name) : undefined;
  if (!destination) {
    console.warn(`[ASUR] No matching channel found in the Main server for #${message.channel.name}`);
    return;
  }

  const sourceWebhook = await getOrCreateWebhook(message.channel);
  const sourceText = message.content.trim();
  const content = sourceText || undefined;
  const webhookPayload = {
    content: content || undefined,
    files,
    username: message.member?.displayName ?? message.author.username,
    avatarURL: message.author.displayAvatarURL(),
    allowedMentions: { parse: [] as ("users" | "roles" | "everyone")[] },
  };

  // Post into Uploading first, then use Discord's native forward operation.
  const uploadedMessage = await sourceWebhook.send(webhookPayload);
  await uploadedMessage.forward(destination);
}

function parseDuration(value: string): number | undefined {
  const match = value.match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const duration = amount * multipliers[match[2].toLowerCase()];
  if (!Number.isFinite(duration) || duration < 10_000 || duration > 30 * 86_400_000) return undefined;
  return duration;
}

function chooseRandom<T>(values: T[], count: number): T[] {
  const pool = [...values];
  const chosen: T[] = [];
  while (pool.length && chosen.length < count) {
    const index = Math.floor(Math.random() * pool.length);
    chosen.push(pool.splice(index, 1)[0]);
  }
  return chosen;
}

async function finishGiveaway(giveaway: GiveawayState, reroll = false): Promise<void> {
  const guild = await client.guilds.fetch(giveaway.guildId).catch(() => undefined);
  const channel = guild ? await guild.channels.fetch(giveaway.channelId).catch(() => undefined) : undefined;
  if (!guild || !isTextChannel(channel)) return;

  const giveawayMessage = await channel.messages.fetch(giveaway.messageId).catch(() => undefined);
  if (!giveawayMessage) return;
  const reaction = giveawayMessage.reactions.cache.get("🎉");
  const users = reaction ? await reaction.users.fetch() : new Map();
  const entrants = [...users.values()].filter((user) => !user.bot);
  const winners = chooseRandom(entrants, Math.min(giveaway.winnerCount, entrants.length));

  const result = winners.length
    ? winners.map((winner) => `<@${winner.id}>`).join(", ")
    : "No eligible entrants";
  await channel.send({
    content: `${reroll ? "Giveaway rerolled." : "Giveaway ended."} Prize: **${giveaway.prize}**\nWinner${winners.length === 1 ? "" : "s"}: ${result}`,
    allowedMentions: { users: winners.map((winner) => winner.id) },
  });
  delete state.giveaways[giveaway.messageId];
  giveawayTimers.get(giveaway.messageId) && clearTimeout(giveawayTimers.get(giveaway.messageId));
  giveawayTimers.delete(giveaway.messageId);
  await saveState();
}

function scheduleGiveaway(giveaway: GiveawayState): void {
  const remaining = giveaway.endsAt - Date.now();
  if (remaining <= 0) {
    void finishGiveaway(giveaway);
    return;
  }
  const timer = setTimeout(() => void finishGiveaway(giveaway), remaining);
  giveawayTimers.set(giveaway.messageId, timer);
}

async function startGiveaway(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !isTextChannel(message.channel)) return;
  if (!(await requirePermission(message, PermissionFlagsBits.ManageGuild, "Manage Server"))) return;
  const duration = parseDuration(args[0] ?? "");
  const winnerCount = Number(args[1]);
  const prize = args.slice(2).join(" ").trim();
  if (!duration || !Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 50 || !prize) {
    await message.reply({
      content: "Usage: `.gwy start <duration> <winners> <prize>` — example: `.gwy start 1h 2 Nitro`.",
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  const endsAt = Date.now() + duration;
  const giveawayMessage = await message.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xd20f39)
        .setTitle("ASUR 2.O Giveaway")
        .setDescription("React with 🎉 to enter.")
        .addFields(
          { name: "Prize", value: prize, inline: true },
          { name: "Winners", value: String(winnerCount), inline: true },
          { name: "Ends", value: `<t:${Math.floor(endsAt / 1000)}:R>`, inline: true },
        )
        .setFooter({ text: "ASUR 2.O • Fair random draw" }),
    ],
  });
  await giveawayMessage.react("🎉");
  const giveaway: GiveawayState = {
    messageId: giveawayMessage.id,
    guildId: message.guild.id,
    channelId: message.channel.id,
    prize,
    winnerCount,
    endsAt,
  };
  state.giveaways[giveaway.messageId] = giveaway;
  await saveState();
  scheduleGiveaway(giveaway);
}

async function createLockedChannel(message: Message, args: string[]): Promise<void> {
  if (!message.guild) return;
  if (!(await requirePermission(message, PermissionFlagsBits.ManageChannels, "Manage Channels"))) return;
  const categoryId = normalizeId(args.at(-1) ?? "");
  const rawName = args.slice(0, -1).join(" ").trim();
  const category = message.guild.channels.cache.get(categoryId);
  const name = rawName
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);

  if (!name || !category || category.type !== ChannelType.GuildCategory) {
    await message.reply({
      content: "Usage: `.create <channel name> <category id>` with a valid category ID.",
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  const channel = await message.guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
    nsfw: true,
    permissionOverwrites: [
      {
        id: message.guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions],
      },
    ],
    reason: `Created by ${message.author.tag} through ASUR 2.O`,
  });
  await message.reply({
    content: `Created locked age-restricted channel ${channelLabel(channel)}. Everyone can view and read history, but cannot send or react.`,
    allowedMentions: { repliedUser: false },
  });
}

async function setChannelLock(message: Message, locked: boolean): Promise<void> {
  if (!message.guild || !isTextChannel(message.channel)) return;
  if (!(await requirePermission(message, PermissionFlagsBits.ManageChannels, "Manage Channels"))) return;
  const channel = await resolveTextChannel(message.guild, message.content.trim().split(/\s+/)[1], message.channel);
  if (!channel) return;
  await channel.permissionOverwrites.edit(message.guild.roles.everyone, {
    SendMessages: !locked,
    AddReactions: !locked,
  });
  await message.reply({
    content: `${channelLabel(channel)} is now **${locked ? "locked" : "unlocked"}**.`,
    allowedMentions: { repliedUser: false },
  });
}

async function setChannelVisibility(message: Message, visible: boolean): Promise<void> {
  if (!message.guild || !isTextChannel(message.channel)) return;
  if (!(await requirePermission(message, PermissionFlagsBits.ManageChannels, "Manage Channels"))) return;
  const channel = await resolveTextChannel(message.guild, message.content.trim().split(/\s+/)[1], message.channel);
  if (!channel) return;
  await channel.permissionOverwrites.edit(message.guild.roles.everyone, {
    ViewChannel: visible,
    ReadMessageHistory: visible,
  });
  await message.reply({
    content: `${channelLabel(channel)} is now **${visible ? "visible" : "hidden"}** to @everyone.`,
    allowedMentions: { repliedUser: false },
  });
}

async function sendEveryoneWebhook(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !isTextChannel(message.channel)) return;
  if (!(await requirePermission(message, PermissionFlagsBits.MentionEveryone, "Mention Everyone"))) return;
  const destination = await resolveTextChannel(message.guild, args[0]);
  const content = args.slice(1).join(" ").trim();
  if (!destination || !content) {
    await message.reply({
      content: "Usage: `.every <channel name or ID> <message>`.",
      allowedMentions: { repliedUser: false },
    });
    return;
  }
  const webhook = await getOrCreateWebhook(destination);
  await webhook.send({
    content: `@everyone ${content}`,
    username: message.member?.displayName ?? message.author.username,
    avatarURL: message.author.displayAvatarURL(),
    allowedMentions: { parse: ["everyone"] },
  });
  await message.reply({
    content: `Everyone ping sent through a webhook in ${channelLabel(destination)}.`,
    allowedMentions: { repliedUser: false },
  });
}

async function setAutoReact(message: Message, args: string[]): Promise<void> {
  if (!message.guild) return;
  if (!(await requirePermission(message, PermissionFlagsBits.ManageGuild, "Manage Server"))) return;
  const config = getGuildConfig(message.guild.id);
  if (args[0]?.toLowerCase() === "off") {
    delete config.autoreact;
    state.guilds[message.guild.id] = config;
    await saveState();
    await message.reply({ content: "Autoreact disabled.", allowedMentions: { repliedUser: false } });
    return;
  }
  const emoji = args[0];
  const channel = await resolveTextChannel(message.guild, args[1]);
  if (!emoji) {
    await message.reply({
      content: "Usage: `.autoreact <emoji> [channel name or ID]` or `.autoreact off`.",
      allowedMentions: { repliedUser: false },
    });
    return;
  }
  config.autoreact = { emoji, channelId: channel?.id };
  state.guilds[message.guild.id] = config;
  await saveState();
  await message.reply({
    content: `Autoreact enabled${channel ? ` in ${channelLabel(channel)}` : " in every channel"} with ${emoji}.`,
    allowedMentions: { repliedUser: false },
  });
}

async function setBooleanConfig(
  message: Message,
  args: string[],
  key: "automodEnabled" | "antinukeEnabled",
  label: string,
): Promise<void> {
  if (!message.guild) return;
  if (!(await requirePermission(message, PermissionFlagsBits.ManageGuild, "Manage Server"))) return;
  const config = getGuildConfig(message.guild.id);
  const value = args[0]?.toLowerCase();
  if (value === "status") {
    await message.reply({
      content: `${label}: **${config[key] ? "ON" : "OFF"}**.`,
      allowedMentions: { repliedUser: false },
    });
    return;
  }
  if (value !== "on" && value !== "off") {
    await message.reply({
      content: `Usage: \`.${key === "automodEnabled" ? "automod" : "antinuke"} <on|off|status>\`.`,
      allowedMentions: { repliedUser: false },
    });
    return;
  }
  config[key] = value === "on";
  state.guilds[message.guild.id] = config;
  await saveState();
  await message.reply({
    content: `${label} is now **${config[key] ? "ON" : "OFF"}**.`,
    allowedMentions: { repliedUser: false },
  });
}

async function setAutorole(message: Message, args: string[]): Promise<void> {
  if (!message.guild) return;
  if (!(await requirePermission(message, PermissionFlagsBits.ManageRoles, "Manage Roles"))) return;
  const config = getGuildConfig(message.guild.id);
  if (args[0]?.toLowerCase() === "off") {
    delete config.autoroleId;
    state.guilds[message.guild.id] = config;
    await saveState();
    await message.reply({ content: "Autorole disabled.", allowedMentions: { repliedUser: false } });
    return;
  }
  const roleId = normalizeId(stripMention(args[0] ?? ""));
  const role = message.guild.roles.cache.get(roleId);
  if (!role || role.managed) {
    await message.reply({
      content: "Usage: `.autorole <role ID or role mention>` with a role the bot can assign.",
      allowedMentions: { repliedUser: false },
    });
    return;
  }
  config.autoroleId = role.id;
  state.guilds[message.guild.id] = config;
  await saveState();
  await message.reply({
    content: `Autorole set to ${role}. New members will receive it automatically.`,
    allowedMentions: { repliedUser: false },
  });
}

async function moderateMember(message: Message, action: "kick" | "ban", args: string[]): Promise<void> {
  if (!message.guild) return;
  const permission = action === "ban" ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.KickMembers;
  if (!(await requirePermission(message, permission, `${action === "ban" ? "Ban" : "Kick"} Members`))) return;
  const target =
    message.mentions.members?.first() ??
    (args[0] ? await message.guild.members.fetch(normalizeId(args[0])).catch(() => undefined) : undefined);
  const reason = args.slice(1).join(" ").trim() || `Action by ${message.author.tag}`;
  if (!target || target.id === message.author.id || target.id === client.user?.id) {
    await message.reply({
      content: `Usage: \`.${action} <user mention or ID> [reason]\`.`,
      allowedMentions: { repliedUser: false },
    });
    return;
  }
  if (!target.manageable) {
    await message.reply({ content: "I cannot moderate that member because of role hierarchy.", allowedMentions: { repliedUser: false } });
    return;
  }
  if (action === "ban") await target.ban({ reason });
  else await target.kick(reason);
  await message.reply({
    content: `${action === "ban" ? "Banned" : "Kicked"} **${target.user.tag}**.`,
    allowedMentions: { repliedUser: false },
  });
}

async function handleCommand(message: Message): Promise<void> {
  if (!message.guild || !message.content.startsWith(PREFIX)) return;
  const body = message.content.slice(PREFIX.length).trim();
  const [command, ...args] = body.split(/\s+/);
  const name = command.toLowerCase();

  switch (name) {
    case "help":
    case "bas":
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xd20f39)
            .setTitle("ASUR 2.O • Control Center")
            .setDescription("Professional server automation for the Main and Uploading servers.")
            .addFields(
              { name: "Cross Upload", value: "Automatic: image metadata is stripped, the 45% watermark is applied, then the processed file is webhook-posted to Uploading and natively forwarded to the same-name Main channel." },
              { name: "Moderation", value: "`.kick @user [reason]`\n`.ban @user [reason]`\n`.lock [channel]` • `.unlock [channel]`\n`.hide [channel]` • `.unhide [channel]`" },
              { name: "Server Tools", value: "`.every <channel> <message>`\n`.create <name> <category id>`\n`.automod on|off|status`\n`.autorole <role>`\n`.autoreact <emoji> [channel]`" },
              { name: "Security", value: "`.antinuke on|off|status` — detects rapid destructive actions and quarantines the executor." },
              { name: "Giveaways", value: "`.gwy start <10s|10m|1h|1d> <winners> <prize>`\n`.gwy end <message id>`\n`.gwy reroll <message id>`" },
            )
            .setFooter({ text: "Prefix: . • Privileged commands require Discord permissions" }),
        ],
        allowedMentions: { repliedUser: false },
      });
      break;
    case "every":
      await sendEveryoneWebhook(message, args);
      break;
    case "create":
      await createLockedChannel(message, args);
      break;
    case "lock":
      await setChannelLock(message, true);
      break;
    case "unlock":
      await setChannelLock(message, false);
      break;
    case "hide":
      await setChannelVisibility(message, false);
      break;
    case "unhide":
      await setChannelVisibility(message, true);
      break;
    case "automod":
      await setBooleanConfig(message, args, "automodEnabled", "Automod");
      break;
    case "antinuke":
      await setBooleanConfig(message, args, "antinukeEnabled", "Antinuke");
      break;
    case "autorole":
      await setAutorole(message, args);
      break;
    case "autoreact":
      await setAutoReact(message, args);
      break;
    case "kick":
      await moderateMember(message, "kick", args);
      break;
    case "ban":
      await moderateMember(message, "ban", args);
      break;
    case "gwy": {
      const subcommand = args.shift()?.toLowerCase();
      if (subcommand === "start") await startGiveaway(message, args);
      else if (subcommand === "end" || subcommand === "reroll") {
        if (!(await requirePermission(message, PermissionFlagsBits.ManageGuild, "Manage Server"))) return;
        const giveaway = state.giveaways[args[0] ?? ""];
        if (!giveaway) {
          await message.reply({ content: "Giveaway not found in the current bot state.", allowedMentions: { repliedUser: false } });
          return;
        }
        await finishGiveaway(giveaway, subcommand === "reroll");
      } else {
        await message.reply({
          content: "Usage: `.gwy start <duration> <winners> <prize>`, `.gwy end <message id>`, or `.gwy reroll <message id>`.",
          allowedMentions: { repliedUser: false },
        });
      }
      break;
    }
    default:
      await message.reply({
        content: `Unknown command. Use \`${PREFIX}help\` for the ASUR 2.O command center.`,
        allowedMentions: { repliedUser: false },
      });
  }
}

async function runAutomod(message: Message): Promise<boolean> {
  if (!message.guild || message.author.bot || !message.member || isModerator(message, PermissionFlagsBits.ManageMessages)) return false;
  const config = getGuildConfig(message.guild.id);
  if (!config.automodEnabled) return false;

  const fingerprintKey = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const recent = (recentMessageFingerprints.get(fingerprintKey) ?? []).filter((entry) => now - entry.at < 8_000);
  const inviteLink = /(?:discord\.gg|discord(?:app)?\.com\/invite)\//i.test(message.content);
  const excessiveMentions = message.mentions.users.size + message.mentions.roles.size > 5 || message.mentions.everyone;
  const repeated = recent.some((entry) => entry.content === message.content && now - entry.at < 4_000);
  recent.push({ content: message.content, at: now });
  recentMessageFingerprints.set(fingerprintKey, recent.slice(-5));

  if (!inviteLink && !excessiveMentions && !repeated) return false;
  await message.delete().catch(() => undefined);
  await message.member.timeout(10 * 60_000, "ASUR 2.O automod violation").catch(() => undefined);
  return true;
}

async function antinukeQuarantine(guild: Guild, executorId: string, reason: string): Promise<void> {
  if (executorId === client.user?.id || executorId === guild.ownerId) return;
  const member = await guild.members.fetch(executorId).catch(() => undefined);
  if (!member || !member.manageable) return;
  await member.roles.set([], `ASUR 2.O antinuke: ${reason}`).catch(() => undefined);
  await member.timeout(60 * 60_000, `ASUR 2.O antinuke: ${reason}`).catch(() => undefined);
  console.warn(`[ASUR] Antinuke quarantined ${executorId} in ${guild.id}: ${reason}`);
}

async function trackAntinuke(guild: Guild, kind: string, auditType: AuditLogEvent): Promise<void> {
  if (!getGuildConfig(guild.id).antinukeEnabled) return;
  const logs = await guild.fetchAuditLogs({ type: auditType, limit: 5 }).catch(() => undefined);
  const entry = logs?.entries.find((item) => Date.now() - item.createdTimestamp < 8_000);
  const executorId = entry?.executor?.id;
  if (!executorId) return;

  const key = `${guild.id}:${executorId}:${kind}`;
  const recent = (antinukeEvents.get(key) ?? []).filter((timestamp) => Date.now() - timestamp < 10_000);
  recent.push(Date.now());
  antinukeEvents.set(key, recent);
  if (recent.length >= 3) await antinukeQuarantine(guild, executorId, `3 rapid ${kind} actions`);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.info(`[ASUR] Logged in as ${readyClient.user.tag}`);
  for (const giveaway of Object.values(state.giveaways)) scheduleGiveaway(giveaway);
});

client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
  const roleId = getGuildConfig(member.guild.id).autoroleId;
  if (!roleId) return;
  const role = member.guild.roles.cache.get(roleId);
  if (role && role.editable) await member.roles.add(role, "ASUR 2.O autorole").catch(() => undefined);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.guildId === BACKUP_GUILD_ID && message.attachments.size) {
    void crossUpload(message).catch((error) => console.error("[ASUR] Cross-upload failed:", error));
  }
  if (!message.guild) return;
  if (await runAutomod(message)) return;
  if (message.content.startsWith(PREFIX)) {
    await handleCommand(message).catch((error) => console.error("[ASUR] Command failed:", error));
    return;
  }

  const autoReact = getGuildConfig(message.guild.id).autoreact;
  if (autoReact && (!autoReact.channelId || autoReact.channelId === message.channelId)) {
    await message.react(autoReact.emoji).catch(() => undefined);
  }
});

client.on(Events.GuildBanAdd, (ban) => void trackAntinuke(ban.guild, "ban", AuditLogEvent.MemberBanAdd));
client.on(Events.GuildMemberRemove, (member) => void trackAntinuke(member.guild, "kick", AuditLogEvent.MemberKick));
client.on(Events.ChannelDelete, (channel) => {
  if ("guild" in channel && channel.guild) {
    void trackAntinuke(channel.guild, "channel deletion", AuditLogEvent.ChannelDelete);
  }
});
client.on(Events.GuildRoleDelete, (role) => void trackAntinuke(role.guild, "role deletion", AuditLogEvent.RoleDelete));

async function main(): Promise<void> {
  await loadState();
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("Missing DISCORD_BOT_TOKEN. Add the Discord bot token as a Replit Secret before starting ASUR 2.O.");
  }
  await client.login(token);
}

void main().catch((error) => {
  console.error("[ASUR] Startup failed:", error);
  process.exitCode = 1;
});