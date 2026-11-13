import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import hostEntry from "../host.ts";
import { XBERG_RELEASE } from "../lib/release.ts";

const fakeXberg = join(
  dirname(fileURLToPath(import.meta.url)),
  "fake-xberg.mjs",
);

// The host entry downloads Xberg on first use, so each test pre-installs the
// fake binary where the installer looks for the pinned release.
async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "xberg-host-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, "data");
  const releaseDir = join(dataDir, "releases", XBERG_RELEASE.version);
  await mkdir(releaseDir, { recursive: true });
  await copyFile(fakeXberg, join(releaseDir, "xberg"));
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "hangs.pdf"), "x");
  await writeFile(join(workspace, "ok.pdf"), "x");
  return { dataDir, workspace };
}

const handlers = (
  hostEntry as unknown as {
    handlers: Record<
      string,
      (input: unknown, context: unknown) => Promise<any>
    >;
  }
).handlers;

function context(dataDir: string, signal: AbortSignal, lifecycle: AbortSignal) {
  return {
    signal,
    lifecycle: { signal: lifecycle },
    experimental_paths: { dataDir, tempDir: dataDir },
  };
}

const request = (workspace: string, path: string) => ({
  baseDir: workspace,
  roots: [workspace],
  path,
  format: "markdown",
  ocr: "default",
  offset: 0,
  maxChars: 1000,
});

const supported = Object.hasOwn(
  XBERG_RELEASE.assets,
  `${process.platform}-${process.arch}`,
);

test(
  "stopping the worker stops a running extraction",
  { skip: !supported && "no pinned build for this platform" },
  async (t) => {
    const { dataDir, workspace } = await setup(t);
    const lifecycle = new AbortController();
    const started = Date.now();
    const run = handlers.extract!(
      request(workspace, "hangs.pdf"),
      context(dataDir, new AbortController().signal, lifecycle.signal),
    );
    setTimeout(() => lifecycle.abort(), 200);
    assert.deepEqual(await run, {
      ok: false,
      error: "Extraction was cancelled.",
    });
    assert.ok(Date.now() - started < 5000);
  },
);

test(
  "extraction works through the host entry with an installed binary",
  { skip: !supported && "no pinned build for this platform" },
  async (t) => {
    const { dataDir, workspace } = await setup(t);
    const never = new AbortController().signal;
    const result = await handlers.extract!(
      request(workspace, "ok.pdf"),
      context(dataDir, never, never),
    );
    assert.equal(result.ok, true);
    assert.equal(result.content, "text of ok.pdf");
  },
);
