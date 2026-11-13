// Runs `xberg extract` on one document that is confined to the allowed roots.
import { spawn } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtractInput, ExtractOutput } from "../contract.ts";
import { workDirFor } from "./cache.ts";

export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
export const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_WARNINGS = 5;
export const MAX_WARNING_CHARS = 300;

/** A failure whose message is meant for the agent. */
export class ExtractError extends Error {}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

/**
 * Resolves `path` through symlinks and returns it only if the real file is
 * under a real root. Files with more than one hard link are refused, because a
 * hard link can't be traced back to a location. This narrows what the tool
 * reads; it is not a security boundary against a process that can change the
 * files while Xberg reads them.
 */
export async function resolveDocument(
  baseDir: string,
  roots: readonly string[],
  path: string,
): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new ExtractError(
      `Only local file paths are supported, not "${path}".`,
    );
  }
  const candidate = resolve(baseDir, path);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new ExtractError(`File not found: ${candidate}`);
  }
  const realRoots = await Promise.all(
    roots.map((root) => realpath(root).catch(() => null)),
  );
  if (!realRoots.some((root) => root !== null && isInside(root, real))) {
    throw new ExtractError(
      `${candidate} is outside this thread's workspace and thread storage. Copy it into the workspace first.`,
    );
  }
  const info = await stat(real);
  if (!info.isFile()) throw new ExtractError(`Not a file: ${candidate}`);
  if (info.nlink > 1) {
    throw new ExtractError(
      `${candidate} has other hard links, so it might be a file from outside the allowed folders. Copy it to a new file first.`,
    );
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new ExtractError(
      `${candidate} is ${info.size} bytes; the limit is ${MAX_FILE_BYTES}.`,
    );
  }
  return real;
}

export function xbergArgs(
  file: string,
  format: ExtractInput["format"],
  ocr: ExtractInput["ocr"],
): string[] {
  return [
    "extract",
    file,
    // A config file in the workspace must not be able to change how we run.
    "--no-config-discovery",
    "--format",
    "json",
    "--content-format",
    format,
    ...(ocr === "on" ? ["--ocr", "true"] : []),
    ...(ocr === "force" ? ["--ocr", "true", "--force-ocr", "true"] : []),
  ];
}

interface RunOptions {
  binary: string;
  args: string[];
  /** Holds Xberg's default `.xberg` cache; also keeps it away from the workspace. */
  workDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Runs Xberg with a minimal environment so it can't read the daemon's secrets. */
export function runXberg(options: RunOptions): Promise<string> {
  const { binary, args, workDir, signal } = options;
  const timeoutMs = options.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const env: NodeJS.ProcessEnv = {
    XBERG_CACHE_DIR: join(workDir, ".xberg"),
    NO_COLOR: "1",
  };
  // Proxy settings let Xberg fetch OCR language packs on networks that need one.
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      cwd: workDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let stopReason: string | null = null;
    const stop = (reason: string) => {
      stopReason ??= reason;
      child.kill("SIGKILL");
    };
    const onAbort = () => stop("Extraction was cancelled.");
    const timer = setTimeout(
      () =>
        stop(
          `Extraction timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
        ),
      timeoutMs,
    );
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stop(`Extraction output exceeded ${MAX_STDOUT_BYTES} bytes.`);
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      finish();
      reject(new ExtractError(`Could not run Xberg: ${error.message}`));
    });
    child.on("close", (code) => {
      finish();
      if (stopReason) reject(new ExtractError(stopReason));
      else if (code !== 0) {
        reject(
          new ExtractError(
            `Xberg exited with ${code}: ${stderr.trim() || "no error output"}`,
          ),
        );
      } else resolvePromise(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

interface ParsedDocument {
  content: string;
  mimeType: string | null;
  warnings: string[];
}

// Reported for every image without EXIF data, which says nothing about the text.
const IGNORED_WARNING = /no exif data found/i;

/** Reads `--format json` output: the document sits under `result` in 1.3.x. */
export function parseOutput(stdout: string): ParsedDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ExtractError("Xberg returned output that is not valid JSON.");
  }
  const envelope = (parsed ?? {}) as { result?: unknown };
  const document = (envelope.result ?? envelope) as {
    content?: unknown;
    mime_type?: unknown;
    processing_warnings?: Array<{ source?: unknown; message?: unknown }>;
  };
  if (typeof document.content !== "string") {
    throw new ExtractError("Xberg's output has no document content.");
  }
  // Warnings sit outside the page limit and above the document text, so they
  // are capped: a crafted document could otherwise fill them with its own text.
  const warnings = Array.isArray(document.processing_warnings)
    ? document.processing_warnings
        .map((warning) => warning?.message)
        .filter(
          (message): message is string =>
            typeof message === "string" &&
            message.trim() !== "" &&
            !IGNORED_WARNING.test(message),
        )
        .slice(0, MAX_WARNINGS)
        .map((message) =>
          message.length > MAX_WARNING_CHARS
            ? `${message.slice(0, MAX_WARNING_CHARS)}…`
            : message,
        )
    : [];
  return {
    content: document.content,
    mimeType:
      typeof document.mime_type === "string" ? document.mime_type : null,
    warnings,
  };
}

/** Cuts one page of text without splitting a surrogate pair at either edge. */
export function slicePage(
  content: string,
  offset: number,
  maxChars: number,
): { text: string; offset: number } {
  const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
  let start = Math.min(offset, content.length);
  if (start > 0 && isLowSurrogate(content.charCodeAt(start))) start -= 1;
  let end = Math.min(start + maxChars, content.length);
  if (end < content.length && isLowSurrogate(content.charCodeAt(end))) {
    // Never split a pair; a one-character page takes the whole pair instead,
    // so the next offset always moves forward.
    end += end - start > 1 ? -1 : 1;
  }
  return { text: content.slice(start, end), offset: start };
}

/** Admits at most `size` tasks at once: OCR on big files is memory hungry. */
export function createLimiter(size: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= size) {
      await new Promise<void>((proceed) => waiting.push(proceed));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

export interface ExtractDependencies {
  ensureInstalled: () => Promise<string>;
  dataDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function extractDocument(
  input: ExtractInput,
  dependencies: ExtractDependencies,
): Promise<ExtractOutput> {
  try {
    if (dependencies.signal?.aborted) {
      throw new ExtractError("Extraction was cancelled.");
    }
    const file = await resolveDocument(input.baseDir, input.roots, input.path);
    const before = await stat(file);
    const binary = await dependencies.ensureInstalled();
    const workDir = workDirFor(dependencies.dataDir);
    await mkdir(workDir, { recursive: true });
    const stdout = await runXberg({
      binary,
      args: xbergArgs(file, input.format, input.ocr),
      workDir,
      signal: dependencies.signal,
      timeoutMs: dependencies.timeoutMs,
    });
    const after = await stat(file).catch(() => null);
    if (!after || after.dev !== before.dev || after.ino !== before.ino) {
      throw new ExtractError(
        `${file} was replaced while it was being read, so its text wasn't returned.`,
      );
    }
    const document = parseOutput(stdout);
    const page = slicePage(document.content, input.offset, input.maxChars);
    return {
      ok: true,
      path: file,
      mimeType: document.mimeType,
      content: page.text,
      offset: page.offset,
      totalChars: document.content.length,
      warnings: document.warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
