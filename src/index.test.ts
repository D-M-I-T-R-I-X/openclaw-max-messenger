import { describe, it, expect, vi, beforeEach } from "vitest";
import plugin from "./index.js";
import { maxChannel } from "./channel.js";
import { extractAttachments } from "./polling.js";
import { clearRegistry } from "./registry.js";

describe("plugin object", () => {
  it("has correct id and name", () => {
    expect(plugin.id).toBe("openclaw-max-messenger");
    expect(plugin.name).toBe("Max Messenger");
  });

  it("has configSchema", () => {
    expect(plugin.configSchema).toBeDefined();
  });

  it("register calls registerChannel and registerTool", () => {
    const registerChannel = vi.fn();
    const registerTool = vi.fn();
    const mockApi = {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      runtime: {
        config: { loadConfig: vi.fn() },
        channel: { routing: {}, session: {}, reply: {} },
      },
      registerChannel,
      registerTool,
    } as any;

    plugin.register(mockApi);

    expect(registerChannel).toHaveBeenCalledWith({
      plugin: maxChannel,
    });
    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "max_send_file" }));
  });
});

describe("maxChannel", () => {
  describe("meta", () => {
    it("has correct id and label", () => {
      expect(maxChannel.meta.id).toBe("max");
      expect(maxChannel.meta.label).toBe("Max Messenger");
      expect(maxChannel.meta.aliases).toContain("max-messenger");
    });
  });

  describe("capabilities", () => {
    it("supports direct and group chats", () => {
      expect(maxChannel.capabilities.chatTypes).toContain("direct");
      expect(maxChannel.capabilities.chatTypes).toContain("group");
    });

    it("supports media and edit but not threads/reactions", () => {
      expect(maxChannel.capabilities.media).toBe(true);
      expect(maxChannel.capabilities.edit).toBe(true);
      expect(maxChannel.capabilities.threads).toBe(false);
      expect(maxChannel.capabilities.reactions).toBe(false);
    });
  });

  describe("config", () => {
    const cfg = {
      channels: {
        max: {
          accounts: {
            default: { token: "tok-1" },
            secondary: { tokenEnv: "MAX_SECONDARY_TOKEN" },
          },
        },
      },
    };

    it("listAccountIds returns all account keys", () => {
      const ids = maxChannel.config.listAccountIds(cfg);
      expect(ids).toEqual(["default", "secondary"]);
    });

    it("listAccountIds returns empty array for missing config", () => {
      expect(maxChannel.config.listAccountIds({})).toEqual([]);
    });

    it("resolveAccount returns correct account", () => {
      const account = maxChannel.config.resolveAccount(cfg, "secondary");
      expect(account.tokenEnv).toBe("MAX_SECONDARY_TOKEN");
      expect(account.accountId).toBe("secondary");
    });

    it("resolveAccount defaults to 'default'", () => {
      const account = maxChannel.config.resolveAccount(cfg);
      expect(account.token).toBe("tok-1");
      expect(account.accountId).toBe("default");
    });

    it("resolveAccount throws for unknown account", () => {
      expect(() => maxChannel.config.resolveAccount(cfg, "unknown")).toThrow(
        'Max account "unknown" not found'
      );
    });
  });

  describe("outbound", () => {
    beforeEach(() => {
      clearRegistry();
    });

    it("has direct delivery mode", () => {
      expect(maxChannel.outbound.deliveryMode).toBe("direct");
    });

    it("has sendMedia method", () => {
      expect(maxChannel.outbound.sendMedia).toBeTypeOf("function");
    });

    it("sendText throws when bot is not started for the requested account", async () => {
      await expect(
        maxChannel.outbound.sendText({
          text: "hello",
          accountId: "default",
          chatId: "123",
          account: { accountId: "default", token: "no-such-token" },
        })
      ).rejects.toThrow('Bot not started for Max account "default"');
    });

    it("sendMedia throws when media URL is missing", async () => {
      const { registerBot } = await import("./registry.js");
      const mockApi = {
        raw: { uploads: { getUploadUrl: vi.fn() } },
        sendMessageToChat: vi.fn(),
      };
      const mockBot = { api: mockApi } as any;
      registerBot("test-tok", mockBot, "default");

      await expect(
        maxChannel.outbound.sendMedia({
          accountId: "default",
          chatId: "123",
          account: { accountId: "default", token: "test-tok" },
          type: "audio",
          // no mediaUrl, no url
        })
      ).rejects.toThrow("No media URL provided");
    });
  });

  describe("gateway", () => {
    it("has startAccount method", () => {
      expect(maxChannel.gateway.startAccount).toBeTypeOf("function");
    });

    it("startAccount throws when token is missing", async () => {
      const abortController = new AbortController();
      await expect(
        maxChannel.gateway.startAccount({
          cfg: {},
          accountId: "test",
          account: {},
          runtime: {},
          abortSignal: abortController.signal,
        })
      ).rejects.toThrow("missing bot token");
    });
  });
});

describe("extractAttachments", () => {
  it("returns undefined for null/empty attachments", () => {
    expect(extractAttachments(null)).toBeUndefined();
    expect(extractAttachments(undefined)).toBeUndefined();
    expect(extractAttachments([])).toBeUndefined();
  });

  it("extracts audio attachment (voice message)", () => {
    const result = extractAttachments([
      {
        type: "audio",
        payload: {
          url: "https://max.ru/audio/123.ogg",
          token: "audio-tok-1",
        },
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      type: "audio",
      url: "https://max.ru/audio/123.ogg",
      token: "audio-tok-1",
    });
  });

  it("extracts file attachment with filename and size", () => {
    const result = extractAttachments([
      {
        type: "file",
        payload: {
          url: "https://max.ru/files/doc.pdf",
          token: "file-tok-1",
        },
        filename: "report.pdf",
        size: 102400,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      type: "file",
      url: "https://max.ru/files/doc.pdf",
      token: "file-tok-1",
      filename: "report.pdf",
      size: 102400,
    });
  });

  it("extracts image attachment", () => {
    const result = extractAttachments([
      {
        type: "image",
        payload: {
          url: "https://max.ru/img/photo.jpg",
          token: "img-tok-1",
        },
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result![0].type).toBe("image");
    expect(result![0].url).toBe("https://max.ru/img/photo.jpg");
  });

  it("extracts multiple attachments", () => {
    const result = extractAttachments([
      {
        type: "image",
        payload: { url: "https://max.ru/img/1.jpg", token: "t1" },
      },
      {
        type: "audio",
        payload: { url: "https://max.ru/audio/voice.ogg", token: "t2" },
      },
      {
        type: "file",
        payload: { url: "https://max.ru/files/doc.pdf", token: "t3" },
        filename: "doc.pdf",
        size: 5000,
      },
    ]);

    expect(result).toHaveLength(3);
    expect(result!.map((a) => a.type)).toEqual(["image", "audio", "file"]);
  });

  it("filters out unsupported attachment types", () => {
    const result = extractAttachments([
      {
        type: "inline_keyboard",
        payload: { buttons: [] },
      } as any,
      {
        type: "audio",
        payload: { url: "https://max.ru/audio/1.ogg", token: "t1" },
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result![0].type).toBe("audio");
  });

  it("returns undefined when all attachments are unsupported", () => {
    const result = extractAttachments([
      { type: "inline_keyboard", payload: { buttons: [] } } as any,
    ]);
    expect(result).toBeUndefined();
  });
});
