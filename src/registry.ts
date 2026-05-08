import type { Bot, Api } from "@maxhub/max-bot-api";

interface BotRecord {
  accountId: string;
  token: string;
  bot: Bot;
}

const botInstances = new Map<string, BotRecord>();
const accountIndex = new Map<string, string>();

export function registerBot(token: string, bot: Bot, accountId?: string): void {
  botInstances.set(token, { accountId: accountId ?? token, token, bot });
  if (accountId) accountIndex.set(accountId, token);
}

export function unregisterBot(token: string): void {
  const record = botInstances.get(token);
  if (record) accountIndex.delete(record.accountId);
  botInstances.delete(token);
}

export function unregisterBotByAccount(accountId: string): void {
  const token = accountIndex.get(accountId);
  if (token) unregisterBot(token);
}

export function getBot(token: string): Bot | undefined {
  return botInstances.get(token)?.bot;
}

export function getBotByAccount(accountId: string): Bot | undefined {
  const token = accountIndex.get(accountId);
  return token ? getBot(token) : undefined;
}

export function getApi(token: string): Api | undefined {
  return getBot(token)?.api;
}

export function getApiByAccount(accountId: string): Api | undefined {
  return getBotByAccount(accountId)?.api;
}

export function getAllBots(): Bot[] {
  return Array.from(botInstances.values()).map((record) => record.bot);
}

export function clearRegistry(): void {
  botInstances.clear();
  accountIndex.clear();
}
