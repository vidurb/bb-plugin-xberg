// Reports and clears the extracted text Xberg caches on this machine.
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

// Not `xberg cache clear`: it only removes files directly inside the directory
// it's given, and Xberg keeps these in subdirectories. `tessdata` isn't listed
// because it holds OCR language packs, not document text.
const TEXT_CACHES = ["extraction", "ocr"];

export function workDirFor(dataDir: string): string {
  return join(dataDir, "work");
}

function textCacheDirs(dataDir: string): string[] {
  return TEXT_CACHES.map((name) => join(workDirFor(dataDir), ".xberg", name));
}

export async function cacheSize(dataDir: string): Promise<number> {
  let total = 0;
  for (const dir of textCacheDirs(dataDir)) {
    const entries = await readdir(dir, {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const info = await stat(join(entry.parentPath, entry.name)).catch(
        () => null,
      );
      total += info?.size ?? 0;
    }
  }
  return total;
}

/** Empties the caches and leaves their directories for running extractions. */
export async function clearCache(dataDir: string): Promise<number> {
  const removedBytes = await cacheSize(dataDir);
  for (const dir of textCacheDirs(dataDir)) {
    const entries = await readdir(dir).catch(() => []);
    await Promise.all(
      entries.map((entry) =>
        rm(join(dir, entry), { recursive: true, force: true }),
      ),
    );
  }
  return removedBytes;
}
