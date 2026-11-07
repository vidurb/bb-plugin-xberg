import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cacheSize, clearCache } from "../lib/cache.ts";

test("clearing removes cached text and keeps language packs and directories", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "xberg-cache-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cache = join(dataDir, "work", ".xberg");
  await mkdir(join(cache, "extraction", "nested"), { recursive: true });
  await mkdir(join(cache, "ocr"));
  await mkdir(join(cache, "tessdata"));
  await writeFile(join(cache, "extraction", "a.msgpack"), "12345");
  await writeFile(join(cache, "extraction", "nested", "b.msgpack"), "123");
  await writeFile(join(cache, "ocr", "c.msgpack"), "12");
  await writeFile(join(cache, "tessdata", "eng.traineddata"), "pack");

  assert.equal(await cacheSize(dataDir), 10);
  assert.equal(await clearCache(dataDir), 10);
  assert.equal(await cacheSize(dataDir), 0);
  assert.deepEqual(await readdir(join(cache, "extraction")), []);
  assert.deepEqual(await readdir(join(cache, "ocr")), []);
  assert.deepEqual(await readdir(join(cache, "tessdata")), ["eng.traineddata"]);
});

test("a machine with no cache yet reports zero", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "xberg-cache-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  assert.equal(await cacheSize(dataDir), 0);
  assert.equal(await clearCache(dataDir), 0);
});
