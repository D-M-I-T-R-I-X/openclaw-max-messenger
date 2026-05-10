import fs from "node:fs";
import path from "node:path";
import { getApiByAccount } from "./registry.js";
import { assertLocalFileAllowed, rawUpload, resolveUploadType, resolvePositiveIntegerId } from "./upload-file.js";
import type { MaxAccountConfig } from "./types.js";

interface ChatContext {
  accountId: string;
  chatId: string;
  userId?: string;
  account: MaxAccountConfig;
  updatedAt: number;
}

const recentContexts = new Map<string, ChatContext>();

function contextKey(accountId: string, chatId: string, userId?: string): string {
  return `${accountId}:${chatId}:${userId ?? ""}`;
}

export function recordLastUsedContext(params: {
  accountId: string;
  chatId: string;
  userId?: string;
  account: MaxAccountConfig;
}): void {
  recentContexts.set(contextKey(params.accountId, params.chatId, params.userId), {
    ...params,
    updatedAt: Date.now(),
  });
}

export function clearRecordedContexts(accountId?: string): void {
  for (const [key, value] of recentContexts) {
    if (!accountId || value.accountId === accountId) recentContexts.delete(key);
  }
}

function resolveContext(params: Record<string, unknown>): ChatContext | null {
  const accountId = String(params.account_id ?? params.accountId ?? "").trim();
  const chatId = String(params.chat_id ?? params.chatId ?? "").trim();
  const userId = String(params.user_id ?? params.userId ?? "").trim() || undefined;

  if (accountId && chatId) {
    const exact = recentContexts.get(contextKey(accountId, chatId, userId));
    const byChat = exact ?? Array.from(recentContexts.values()).find(
      (ctx) => ctx.accountId === accountId && ctx.chatId === chatId,
    );
    return byChat ?? null;
  }

  if (recentContexts.size === 1) {
    return Array.from(recentContexts.values())[0];
  }

  const ordered = Array.from(recentContexts.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  return ordered[0] ?? null;
}

export const sendFileTool = {
  name: "max_send_file",
  label: "Send File",
  description:
    "Send a file from an allowed local export/workspace directory to a Max chat. " +
    "Prefer passing account_id and chat_id from the current Max context. " +
    "Supports PDF, images, documents, archives, etc.",
  parameters: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string" as const,
        description: "Absolute path to the file to send. Must be under allowedFileRoots.",
      },
      caption: {
        type: "string" as const,
        description: "Optional message to send with the file",
      },
      account_id: {
        type: "string" as const,
        description: "Optional Max account id. Safer than relying on recent chat context.",
      },
      chat_id: {
        type: "string" as const,
        description: "Optional Max chat id. Safer than relying on recent chat context.",
      },
    },
    required: ["file_path"],
  },
  async execute(_toolCallId: string, params: Record<string, unknown>) {
    const filePath = String(params.file_path ?? "").trim();
    if (!filePath) {
      return {
        content: [{ type: "text" as const, text: "Error: file_path is required" }],
      };
    }

    const resolved = resolveContext(params);
    if (!resolved) {
      return {
        content: [{
          type: "text" as const,
          text: "Error: no active Max chat context. Provide account_id and chat_id explicitly.",
        }],
      };
    }

    const api = getApiByAccount(resolved.accountId);
    if (!api) {
      return {
        content: [{ type: "text" as const, text: `Error: Max bot is not running for account ${resolved.accountId}` }],
      };
    }

    try {
      const safePath = assertLocalFileAllowed(filePath, resolved.account);
      const chatId = resolvePositiveIntegerId(resolved.chatId, "Max chat id");
      const caption = String(params.caption ?? "").trim();
      const filename = path.basename(safePath);
      const ext = path.extname(safePath).toLowerCase();
      const uploadType = resolveUploadType(ext);
      const attachment = await rawUpload(api, uploadType, safePath, filename);
      const fileSize = fs.statSync(safePath).size;

      await api.sendMessageToChat(chatId, caption || filename, {
        attachments: [attachment],
      });

      return {
        content: [{ type: "text" as const, text: `File sent: ${filename} (${fileSize} bytes)` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error sending file: ${String(err)}` }],
      };
    }
  },
};
