export interface MaxAccountConfig {
  /** Prefer tokenEnv for production deployments. token remains supported for compatibility. */
  token?: string;
  tokenEnv?: string;
  botId?: string;
  allowedUpdates?: string[];
  accountId?: string | null;
  dmPolicy?: string;
  allowFrom?: Array<string | number>;
  /** Optional allow-list for group chat ids. Empty/undefined means no group chat restriction. */
  allowChats?: Array<string | number>;
  /**
   * Group handling policy. Defaults to "always" for compatibility with Max private chats
   * that may appear as group-style chats in the SDK.
   */
  respondInGroups?: "never" | "command" | "always";
  /** Command prefixes used when respondInGroups is "command". */
  groupTriggerPrefixes?: string[];
  /** Opt-in only: auto-upload absolute local file paths found in agent replies. */
  autoSendLocalFiles?: boolean;
  /** Directories from which local files may be uploaded by this plugin/tool. */
  allowedFileRoots?: string[];
  /** Maximum bytes to download from inbound/outbound URLs. Defaults to 25 MiB. */
  maxDownloadBytes?: number;
  /** Maximum bytes to upload from local files. Defaults to 25 MiB. */
  maxUploadBytes?: number;
}

export interface MaxChannelsConfig {
  channels?: {
    max?: {
      accounts?: Record<string, MaxAccountConfig>;
    };
  };
}

export interface MaxOutboundContext {
  text: string;
  accountId: string;
  chatId: string;
  userId?: string;
  messageId?: string;
  account: MaxAccountConfig;
}

export type MediaType = "image" | "video" | "audio" | "file";

export interface MaxMediaContext {
  accountId: string;
  chatId: string;
  account: MaxAccountConfig;
  type: MediaType;
  url?: string;
  source?: string | Buffer;
  text?: string;
}

export interface InboundAttachment {
  type: MediaType | "sticker" | "contact" | "location" | "share";
  url?: string;
  token?: string;
  filename?: string;
  size?: number;
}

export interface InboundMessage {
  channel: string;
  accountId: string;
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  timestamp: number;
  username?: string;
  displayName?: string;
  isGroup?: boolean;
  attachments?: InboundAttachment[];
  payload?: Record<string, unknown>;
}

export interface PluginLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}
