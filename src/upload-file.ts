import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { MaxAccountConfig } from "./types.js";

export type UploadType = "image" | "video" | "audio" | "file";
type RawUploadsApi = { raw: { uploads: { getUploadUrl: (opts: { type: UploadType }) => Promise<{ url: string; token?: string }> } } };

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "webm"]);
const AUDIO_EXTS = new Set(["mp3", "ogg", "wav", "m4a"]);

export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Resolve upload type from file extension and/or content-type header. */
export function resolveUploadType(ext?: string, contentType?: string): UploadType {
  const bareExt = ext?.replace(/^\./, "").toLowerCase() ?? "";
  if (contentType?.startsWith("image/") || IMAGE_EXTS.has(bareExt)) return "image";
  if (contentType?.startsWith("video/") || VIDEO_EXTS.has(bareExt)) return "video";
  if (contentType?.startsWith("audio/") || AUDIO_EXTS.has(bareExt)) return "audio";
  return "file";
}

/** Strip "max:" prefix from IDs. */
export function stripMaxPrefix(id: string): string {
  return id.replace(/^max:/i, "");
}

export function resolveMaxToken(account: MaxAccountConfig): string {
  const token = account.token ?? (account.tokenEnv ? process.env[account.tokenEnv] : undefined);
  if (!token) {
    const hint = account.tokenEnv ? `env ${account.tokenEnv}` : "token/tokenEnv";
    throw new Error(`Max account is missing bot token (${hint})`);
  }
  return token;
}

export function resolvePositiveIntegerId(rawId: unknown, label = "Max chat id"): number {
  const value = Number(stripMaxPrefix(String(rawId ?? "").trim()));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}: ${String(rawId ?? "")}`);
  }
  return value;
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith(`~${path.sep}`)) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function defaultAllowedFileRoots(): string[] {
  return [
    path.join(os.homedir(), ".openclaw", "workspace"),
    path.join(os.homedir(), ".openclaw", "exports"),
    path.join(os.tmpdir(), "openclaw-send"),
  ];
}

export function resolveAllowedFileRoots(account?: MaxAccountConfig): string[] {
  return (account?.allowedFileRoots?.length ? account.allowedFileRoots : defaultAllowedFileRoots())
    .map((root) => path.resolve(expandHome(root)));
}

export function assertLocalFileAllowed(filePath: string, account?: MaxAccountConfig): string {
  if (!path.isAbsolute(filePath)) {
    throw new Error("Only absolute local file paths are allowed");
  }

  const realPath = fs.realpathSync(filePath);
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a regular file: ${filePath}`);
  }

  const maxBytes = account?.maxUploadBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (stat.size > maxBytes) {
    throw new Error(`File is too large: ${stat.size} bytes exceeds limit ${maxBytes}`);
  }

  const allowedRoots = resolveAllowedFileRoots(account);
  const allowed = allowedRoots.some((root) => {
    if (!fs.existsSync(root)) return false;
    const realRoot = fs.realpathSync(root);
    return realPath === realRoot || realPath.startsWith(realRoot + path.sep);
  });

  if (!allowed) {
    throw new Error(
      `File path is outside allowed roots. Allowed roots: ${allowedRoots.join(", ")}`,
    );
  }

  return realPath;
}

export async function fetchBufferWithLimit(
  url: string,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
  timeoutMs = 30_000,
): Promise<{ buffer: Buffer; contentType: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to download media: ${res.status}`);

    const contentLength = Number(res.headers.get("content-length") ?? "0");
    if (contentLength > maxBytes) {
      throw new Error(`Remote file is too large: ${contentLength} bytes exceeds limit ${maxBytes}`);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      const fallback = Buffer.from(await res.arrayBuffer());
      if (fallback.length > maxBytes) {
        throw new Error(`Remote file is too large: ${fallback.length} bytes exceeds limit ${maxBytes}`);
      }
      return { buffer: fallback, contentType: res.headers.get("content-type") || "" };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Remote file is too large: ${total} bytes exceeds limit ${maxBytes}`);
      }
      chunks.push(value);
    }

    return { buffer: Buffer.concat(chunks), contentType: res.headers.get("content-type") || "" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Upload any media via raw Max Bot API, bypassing the SDK's upload helpers.
 *
 * The SDK loses the token for Buffer uploads in some cases. This helper
 * uses the raw getUploadUrl endpoint and captures the token from either
 * the getUploadUrl response or the upload response itself.
 *
 * Works for all types: image, video, audio, file.
 */
export async function rawUpload(
  api: RawUploadsApi,
  type: UploadType,
  source: string | Buffer,
  filename: string,
): Promise<{ type: UploadType; payload: { token: string } }> {
  const resp = await api.raw.uploads.getUploadUrl({ type });
  const uploadUrl = resp.url;
  let token = resp.token;

  const buf = typeof source === "string" ? fs.readFileSync(source) : source;
  const name = typeof source === "string" ? path.basename(source) : filename;

  const formData = new FormData();
  formData.append("data", new Blob([buf as BlobPart]), name);
  const uploadRes = await fetch(uploadUrl, { method: "POST", body: formData });

  if (!uploadRes.ok) {
    throw new Error(`Max upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
  }

  // Token may come from the upload response instead of getUploadUrl
  if (!token) {
    try {
      const json = await uploadRes.json() as Record<string, unknown>;
      if (typeof json.token === "string") {
        token = json.token;
      }
    } catch {
      // response may not be JSON
    }
  }

  if (!token) {
    throw new Error(`Max API did not return an upload token for type "${type}"`);
  }

  return { type, payload: { token } };
}
