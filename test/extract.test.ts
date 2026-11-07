import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtractInput } from "../contract.ts";
import {
  createLimiter,
  extractDocument,
  parseOutput,
  resolveDocument,
  runXberg,
  slicePage,
  xbergArgs,
} from "../lib/extract.ts";

const fakeXberg = join(
  dirname(fileURLToPath(import.meta.url)),
  "fake-xberg.mjs",
);

async function scratch(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "xberg-extract-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, "workspace");
  const outside = join(dir, "outside");
  const dataDir = join(dir, "data");
  await mkdir(join(workspace, "docs"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(workspace, "docs", "report.pdf"), "pdf");
  await writeFile(join(outside, "secret.pdf"), "secret");
  return { workspace, outside, dataDir };
}

const input = (workspace: string, path: string): ExtractInput => ({
  baseDir: workspace,
  roots: [workspace],
  path,
  format: "markdown",
  ocr: "default",
  offset: 0,
  maxChars: 1000,
});

test("resolveDocument accepts relative and absolute paths inside a root", async (t) => {
  const { workspace } = await scratch(t);
  const expected = await resolveDocument(
    workspace,
    [workspace],
    "docs/report.pdf",
  );
  assert.match(expected, /docs\/report\.pdf$/);
  assert.equal(
    await resolveDocument(
      workspace,
      [workspace],
      join(workspace, "docs/report.pdf"),
    ),
    expected,
  );
});

test("resolveDocument rejects traversal, outside paths and symlink escapes", async (t) => {
  const { workspace, outside } = await scratch(t);
  await symlink(join(outside, "secret.pdf"), join(workspace, "link.pdf"));
  await symlink(outside, join(workspace, "linkdir"));
  for (const path of [
    "../outside/secret.pdf",
    join(outside, "secret.pdf"),
    "link.pdf",
    "linkdir/secret.pdf",
  ]) {
    await assert.rejects(
      resolveDocument(workspace, [workspace], path),
      /outside this thread's workspace/,
      path,
    );
  }
});

test("resolveDocument allows a symlink that stays inside the root", async (t) => {
  const { workspace } = await scratch(t);
  await symlink(
    join(workspace, "docs/report.pdf"),
    join(workspace, "alias.pdf"),
  );
  assert.match(
    await resolveDocument(workspace, [workspace], "alias.pdf"),
    /docs\/report\.pdf$/,
  );
});

test("resolveDocument rejects URLs, missing files, directories and the root itself", async (t) => {
  const { workspace } = await scratch(t);
  await assert.rejects(
    resolveDocument(workspace, [workspace], "https://example.com/a.pdf"),
    /Only local file paths/,
  );
  await assert.rejects(
    resolveDocument(workspace, [workspace], "file:///etc/passwd"),
    /Only local file paths/,
  );
  await assert.rejects(
    resolveDocument(workspace, [workspace], "nope.pdf"),
    /File not found/,
  );
  await assert.rejects(
    resolveDocument(workspace, [workspace], "docs"),
    /Not a file/,
  );
  await assert.rejects(
    resolveDocument(workspace, [workspace], "."),
    /outside this thread's workspace/,
  );
});

test("resolveDocument accepts a second root and ignores a missing one", async (t) => {
  const { workspace, outside } = await scratch(t);
  const roots = [join(workspace, "missing"), outside];
  assert.match(
    await resolveDocument(workspace, roots, join(outside, "secret.pdf")),
    /secret\.pdf$/,
  );
});

test("xbergArgs always skips config discovery and maps OCR modes", () => {
  const base = xbergArgs("/a.pdf", "plain", "default");
  assert.deepEqual(base, [
    "extract",
    "/a.pdf",
    "--no-config-discovery",
    "--format",
    "json",
    "--content-format",
    "plain",
  ]);
  assert.deepEqual(xbergArgs("/a", "markdown", "on").slice(-2), [
    "--ocr",
    "true",
  ]);
  assert.deepEqual(xbergArgs("/a", "markdown", "force").slice(-4), [
    "--ocr",
    "true",
    "--force-ocr",
    "true",
  ]);
});

test("parseOutput reads the nested envelope and a flat document", () => {
  assert.deepEqual(
    parseOutput(
      JSON.stringify({
        result: {
          content: "hi",
          mime_type: "text/plain",
          processing_warnings: [{ message: "careful" }],
        },
      }),
    ),
    { content: "hi", mimeType: "text/plain", warnings: ["careful"] },
  );
  assert.equal(
    parseOutput(JSON.stringify({ content: "flat" })).content,
    "flat",
  );
  assert.throws(() => parseOutput("nope"), /not valid JSON/);
  assert.throws(() => parseOutput("{}"), /no document content/);
  assert.throws(() => parseOutput("null"), /no document content/);
});

test("parseOutput drops the EXIF noise and keeps other warnings", () => {
  const { warnings } = parseOutput(
    JSON.stringify({
      content: "x",
      processing_warnings: [
        {
          message:
            "EXIF metadata extraction failed: failed to parse EXIF block: no exif data found in this file",
        },
        { message: "EXIF metadata extraction failed: corrupt block" },
        { message: "low confidence" },
      ],
    }),
  );
  assert.deepEqual(warnings, [
    "EXIF metadata extraction failed: corrupt block",
    "low confidence",
  ]);
});

test("slicePage pages through text and never splits a surrogate pair", () => {
  assert.deepEqual(slicePage("abcdef", 2, 2), { text: "cd", offset: 2 });
  assert.deepEqual(slicePage("abc", 99, 2), { text: "", offset: 3 });
  const emoji = "a😀b";
  assert.deepEqual(slicePage(emoji, 0, 2), { text: "a", offset: 0 });
  assert.deepEqual(slicePage(emoji, 2, 5), { text: "😀b", offset: 1 });
  assert.deepEqual(slicePage("😀", 0, 1), { text: "\ud83d", offset: 0 });
});

test("runXberg uses a minimal environment and the given working directory", async (t) => {
  const { dataDir } = await scratch(t);
  await mkdir(dataDir, { recursive: true });
  process.env.XBERG_TEST_SECRET = "leak";
  t.after(() => delete process.env.XBERG_TEST_SECRET);
  const stdout = await runXberg({
    binary: fakeXberg,
    args: ["extract", "/x/a.pdf"],
    workDir: dataDir,
  });
  const { echo } = JSON.parse(stdout);
  assert.equal(echo.env.XBERG_TEST_SECRET, undefined);
  assert.equal(echo.env.XBERG_CACHE_DIR, join(dataDir, ".xberg"));
  assert.match(echo.cwd, /data$/);
});

test("runXberg kills the process on timeout and on abort", async (t) => {
  const { dataDir } = await scratch(t);
  await mkdir(dataDir, { recursive: true });
  const args = ["extract", "/x/hangs.pdf"];
  await assert.rejects(
    runXberg({ binary: fakeXberg, args, workDir: dataDir, timeoutMs: 200 }),
    /timed out/,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(
    runXberg({
      binary: fakeXberg,
      args,
      workDir: dataDir,
      signal: controller.signal,
    }),
    /cancelled/,
  );
});

test("extractDocument returns a page of text with metadata", async (t) => {
  const { workspace, dataDir } = await scratch(t);
  const result = await extractDocument(
    { ...input(workspace, "docs/report.pdf"), offset: 5, maxChars: 4 },
    { ensureInstalled: async () => fakeXberg, dataDir },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.content, "of r");
  assert.equal(result.offset, 5);
  assert.equal(result.totalChars, "text of report.pdf".length);
  assert.equal(result.mimeType, "application/pdf");
  assert.deepEqual(result.warnings, ["low confidence"]);
});

test("extractDocument checks the path before installing anything", async (t) => {
  const { workspace, outside, dataDir } = await scratch(t);
  let installs = 0;
  const result = await extractDocument(
    input(workspace, join(outside, "secret.pdf")),
    {
      ensureInstalled: async () => {
        installs += 1;
        return fakeXberg;
      },
      dataDir,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(installs, 0);
});

test("extractDocument reports Xberg failures, bad output and install failures as data", async (t) => {
  const { workspace, dataDir } = await scratch(t);
  await writeFile(join(workspace, "fails.pdf"), "x");
  await writeFile(join(workspace, "garbage.pdf"), "x");
  const dependencies = { ensureInstalled: async () => fakeXberg, dataDir };
  assert.deepEqual(
    await extractDocument(input(workspace, "fails.pdf"), dependencies),
    { ok: false, error: "Xberg exited with 3: cannot parse document" },
  );
  assert.deepEqual(
    await extractDocument(input(workspace, "garbage.pdf"), dependencies),
    { ok: false, error: "Xberg returned output that is not valid JSON." },
  );
  assert.deepEqual(
    await extractDocument(input(workspace, "docs/report.pdf"), {
      dataDir,
      ensureInstalled: async () => {
        throw new Error("no build for this platform");
      },
    }),
    { ok: false, error: "no build for this platform" },
  );
});

test("createLimiter runs at most the given number of tasks and survives failures", async () => {
  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;
  const task = async (shouldFail: boolean) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((done) => setTimeout(done, 10));
    active -= 1;
    if (shouldFail) throw new Error("boom");
    return "ok";
  };
  const results = await Promise.allSettled(
    [true, false, false, true, false].map((fail) => limit(() => task(fail))),
  );
  assert.equal(peak, 2);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(active, 0);
});
