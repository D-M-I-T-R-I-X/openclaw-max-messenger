import { Bot } from "@maxhub/max-bot-api";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { handleMaxInbound } from "./inbound.js";
import { registerBot, unregisterBotByAccount } from "./registry.js";
import { clearRecordedContexts, recordLastUsedContext } from "./send-file-tool.js";
import { resolveMaxToken } from "./upload-file.js";
import type { MaxAccountConfig, InboundAttachment, PluginLogger } from "./types.js";

interface RawAttachment {
  type: string;
  payload?: { url?: string; token?: string };
  filename?: string;
  size?: number;
}

const SUPPORTED_ATTACHMENT_TYPES = new Set([
  "image", "video", "audio", "file", "sticker", "contact", "location", "share",
]);

export function extractAttachments(
  rawAttachments: RawAttachment[] | null | undefined
): InboundAttachment[] | undefined {
  if (!rawAttachments?.length) return undefined;

  const result = rawAttachments
    .filter((a) => SUPPORTED_ATTACHMENT_TYPES.has(a.type))
    .map((a): InboundAttachment => {
      const attachment: InboundAttachment = {
        type: a.type as InboundAttachment["type"],
        url: a.payload?.url,
        token: a.payload?.token,
      };

      if (a.type === "file") {
        attachment.filename = a.filename;
        attachment.size = a.size;
      }

      return attachment;
    });

  return result.length ? result : undefined;
}

const activeBots = new Map<string, { bot: Bot; token: string }>();
const stoppedAccounts = new Set<string>();
const MAX_RESTART_DELAY_MS = 60_000;

export async function startPolling(params: {
  accounts: Record<string, MaxAccountConfig>;
  logger: PluginLogger;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const { accounts, logger, runtime } = params;

  for (const [accountId, rawConfig] of Object.entries(accounts)) {
    if (activeBots.has(accountId)) {
      logger.warn(`Polling already active for account "${accountId}"`);
      continue;
    }

    const token = resolveMaxToken(rawConfig);
    const config: MaxAccountConfig = { ...rawConfig, accountId };
    stoppedAccounts.delete(accountId);

    const bot = createConfiguredBot({ accountId, config, token, logger, runtime });
    activeBots.set(accountId, { bot, token });
    registerBot(token, bot, accountId);

    runWithRestart({ bot, accountId, config, token, logger, runtime });

    logger.info(`Max polling started for account "${accountId}"`);
  }
}

function createConfiguredBot(params: {
  accountId: string;
  config: MaxAccountConfig;
  token: string;
  logger: PluginLogger;
  runtime?: RuntimeEnv;
}): Bot {
  const { accountId, config, token, logger, runtime } = params;
  const bot = new Bot(token);

  bot.on("message_created", (ctx: unknown) => {
    const c = ctx as Record<string, unknown>;
    const chatId = c.chatId as number | undefined;
    const user = c.user as Record<string, unknown> | undefined;
    const userId = user?.user_id as number | undefined;
    const messageId = c.messageId as number | undefined;
    const myId = c.myId as number | undefined;

    if (!chatId || !userId) return;

    // Ignore messages sent by the bot itself
    if (myId && userId === myId) return;

    const message = c.message as Record<string, unknown> | undefined;
    const body = message?.body as Record<string, unknown> | undefined;
    const text = (body?.text as string) ?? "";
    const attachments = extractAttachments(
      body?.attachments as RawAttachment[] | null
    );

    if (!text && !attachments?.length) return;

    recordLastUsedContext({
      accountId,
      chatId: String(chatId),
      userId: String(userId),
      account: config,
    });

    const chat = c.chat as Record<string, unknown> | undefined;

    handleMaxInbound({
      message: {
        channel: "max",
        accountId,
        chatId: String(chatId),
        userId: String(userId),
        messageId: String(messageId ?? Date.now()),
        text,
        timestamp: Date.now(),
        username: user?.username as string | undefined,
        displayName: user?.name as string | undefined,
        isGroup: chat?.type !== "dialog",
        attachments,
        payload: { update: c.update },
      },
      account: config,
      accountId,
      runtime,
    }).catch((err) => {
      logger.error(`Max inbound handling error (${accountId}):`, err);
    });
  });

  bot.on("bot_started", (ctx: unknown) => {
    const c = ctx as Record<string, unknown>;
    const user = c.user as Record<string, unknown> | undefined;
    const userId = user?.user_id as number | undefined;
    const chatId = c.chatId as number | undefined;

    if (!userId || !chatId) return;

    recordLastUsedContext({
      accountId,
      chatId: String(chatId),
      userId: String(userId),
      account: config,
    });

    handleMaxInbound({
      message: {
        channel: "max",
        accountId,
        chatId: String(chatId),
        userId: String(userId),
        messageId: `start_${Date.now()}`,
        text: "/start",
        timestamp: Date.now(),
        username: user?.username as string | undefined,
        displayName: user?.name as string | undefined,
        payload: {
          startPayload: c.startPayload,
          update: c.update,
        },
      },
      account: config,
      accountId,
      runtime,
    }).catch((err) => {
      logger.error(`Max inbound handling error (${accountId}):`, err);
    });
  });

  bot.catch((err: unknown) => {
    logger.error(`Max bot error (${accountId}):`, err);
  });

  return bot;
}

function runWithRestart(ctx: {
  bot: Bot;
  accountId: string;
  config: MaxAccountConfig;
  token: string;
  logger: PluginLogger;
  runtime?: RuntimeEnv;
  attempt?: number;
}): void {
  const { bot, accountId, config, token, logger, runtime } = ctx;
  const attempt = ctx.attempt ?? 0;

  bot.start({
    allowedUpdates: (config.allowedUpdates ?? ["message_created", "bot_started"]) as never,
  }).then(() => {
    logger.info(`Max poll loop ended normally (${accountId})`);
  }).catch((err) => {
    const errMsg = err instanceof Error ? err.message : String(err ?? "unknown");
    logger.error(`Max poll loop crashed (${accountId}): ${errMsg}`);

    if (stoppedAccounts.has(accountId)) return;

    const delay = Math.min(1000 * 2 ** attempt, MAX_RESTART_DELAY_MS);
    logger.info(`Max poll loop restarting (${accountId}) in ${delay}ms (attempt ${attempt + 1})`);

    setTimeout(() => {
      if (stoppedAccounts.has(accountId)) return;
      unregisterBotByAccount(accountId);
      const freshBot = createConfiguredBot({ accountId, config, token, logger, runtime });
      activeBots.set(accountId, { bot: freshBot, token });
      registerBot(token, freshBot, accountId);
      runWithRestart({ bot: freshBot, accountId, config, token, logger, runtime, attempt: attempt + 1 });
    }, delay);
  });
}

export function stopPolling(accountId?: string): void {
  const entries = accountId
    ? Array.from(activeBots.entries()).filter(([id]) => id === accountId)
    : Array.from(activeBots.entries());

  for (const [id, { bot }] of entries) {
    stoppedAccounts.add(id);
    bot.stop();
    unregisterBotByAccount(id);
    activeBots.delete(id);
    clearRecordedContexts(id);
  }
}
