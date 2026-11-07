import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const okResult = {
  ok: true,
  path: "/work/report.pdf",
  mimeType: "application/pdf",
  content: "hello",
  offset: 0,
  totalChars: 5,
  warnings: [],
};
const status = {
  version: "1.3.10",
  platform: "darwin-arm64",
  supported: true,
  installed: true,
  binaryPath: "/data/xberg",
  cacheBytes: 3 * 1024 * 1024,
};

async function setup(
  respond: (call: { method: string; input: unknown }) => unknown,
  options: {
    environmentId?: string | null;
    storage?: string | null;
    thread?: Record<string, unknown>;
  } = {},
) {
  const calls: Array<{
    method: string;
    input: any;
    hostId: string;
  }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "xberg",
    agentSkillIds: ["xberg"],
    sdk: {
      threads: {
        get: async () => ({
          environmentId:
            options.environmentId === undefined
              ? "env_1"
              : options.environmentId,
          parentThreadId: null,
          sourceThreadId: null,
          ...options.thread,
        }),
      },
      environments: {
        get: async () => ({ hostId: "host_mac", path: "/work" }),
      },
      hosts: {
        get: async () => ({
          threadStorageRootPath:
            options.storage === undefined ? "/storage" : options.storage,
        }),
        list: async () => [
          { id: "host_mac", name: "Mac" },
          { id: "host_pod", name: "pod" },
        ],
      },
    },
    experimental_callHostRpc: async ({ method, input, hostId }: any) => {
      calls.push({ method, input, hostId });
      return respond({ method, input });
    },
  } as unknown as Parameters<typeof createFakePluginHost>[0]);
  await plugin(bb);
  return { harness, calls };
}

const extract = (harness: any, args: Record<string, unknown>) =>
  harness.behavior.callAgentTool("xberg_extract", args) as Promise<any>;
const text = (result: any) =>
  typeof result === "string"
    ? result
    : result.content.map((part: any) => part.text).join("\n");

test("the tool runs on the thread's machine, confined to workspace and storage", async () => {
  const { harness, calls } = await setup(() => okResult);
  const result = await extract(harness, { path: "report.pdf" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "extract");
  assert.equal(calls[0]!.hostId, "host_mac");
  assert.deepEqual(calls[0]!.input, {
    baseDir: "/work",
    roots: ["/work", "/storage/thread-test"],
    path: "report.pdf",
    format: "markdown",
    ocr: "default",
    offset: 0,
    maxChars: 50_000,
  });
  assert.match(
    text(result),
    /Document: \/work\/report\.pdf \(application\/pdf\)/,
  );
  assert.match(text(result), /Characters 0-5 of 5\./);
  assert.match(text(result), /\n\nhello$/);
  assert.doesNotMatch(text(result), /offset=/);
});

test("a thread can also read storage from the threads it came from", async () => {
  const { harness, calls } = await setup(() => okResult, {
    thread: { parentThreadId: "thr_parent", sourceThreadId: "thr_source" },
  });
  await extract(harness, { path: "report.pdf" });
  assert.deepEqual(calls[0]!.input.roots, [
    "/work",
    "/storage/thread-test",
    "/storage/thr_parent",
    "/storage/thr_source",
  ]);
});

test("a machine without thread storage confines to the workspace alone", async () => {
  const { harness, calls } = await setup(() => okResult, { storage: null });
  await extract(harness, { path: "report.pdf" });
  assert.deepEqual(calls[0]!.input.roots, ["/work"]);
});

test("partial results say how to continue", async () => {
  const { harness } = await setup(() => ({
    ...okResult,
    offset: 10,
    totalChars: 100,
    warnings: ["low confidence"],
  }));
  const output = text(await extract(harness, { path: "a.pdf", offset: 10 }));
  assert.match(output, /Characters 10-15 of 100\. Call again with offset=15/);
  assert.match(output, /Warning: low confidence/);
});

test("an empty document suggests OCR", async () => {
  const { harness } = await setup(() => ({
    ...okResult,
    content: "",
    totalChars: 0,
  }));
  assert.match(
    text(await extract(harness, { path: "scan.pdf" })),
    /retry with ocr="on"/,
  );
});

test("host-side failures and offline machines become tool errors", async () => {
  const refused = await setup(() => ({
    ok: false,
    error: "outside workspace",
  }));
  const denied = await extract(refused.harness, { path: "/etc/passwd" });
  assert.equal(denied.isError, true);
  assert.equal(text(denied), "outside workspace");

  const offline = await setup(() => {
    throw new Error("host is offline");
  });
  const failed = await extract(offline.harness, { path: "a.pdf" });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /host is offline/);
});

test("a thread without an environment gets a clear error and no host call", async () => {
  const { harness, calls } = await setup(() => okResult, {
    environmentId: null,
  });
  const result = await extract(harness, { path: "a.pdf" });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test("invalid tool arguments are rejected before reaching the host", async () => {
  const { harness, calls } = await setup(() => okResult);
  await assert.rejects(extract(harness, { path: "a.pdf", max_chars: 1e9 }));
  await assert.rejects(extract(harness, { path: "a.pdf", format: "docx" }));
  await assert.rejects(extract(harness, { path: "" }));
  assert.equal(calls.length, 0);
});

test("the CLI targets a named machine or the current thread's machine", async () => {
  const { harness, calls } = await setup(() => status);
  const byName = await harness.behavior.runCli(["status", "--machine", "pod"]);
  assert.equal(byName.exitCode, 0);
  assert.match(
    String(byName.stdout),
    /^pod: Xberg 1\.3\.10 on darwin-arm64: installed/,
  );
  assert.equal(calls.at(-1)!.hostId, "host_pod");

  const byThread = await harness.behavior.runCli(["install"], {
    threadId: "thr_1",
  });
  assert.equal(byThread.exitCode, 0);
  assert.equal(calls.at(-1)!.method, "install");
  assert.equal(calls.at(-1)!.hostId, "host_mac");
});

test("the CLI reports cache size and clears the cache", async () => {
  const { harness, calls } = await setup(({ method }) =>
    method === "clearCache" ? { removedBytes: 2 * 1024 * 1024 } : status,
  );
  const shown = await harness.behavior.runCli(["status", "--machine", "pod"]);
  assert.match(String(shown.stdout), /3\.0 MB of cached text/);
  const cleared = await harness.behavior.runCli([
    "cache",
    "clear",
    "--machine",
    "pod",
  ]);
  assert.equal(cleared.exitCode, 0);
  assert.equal(String(cleared.stdout), "pod: removed 2.0 MB of cached text\n");
  assert.equal(calls.at(-1)!.method, "clearCache");
  assert.equal(calls.at(-1)!.hostId, "host_pod");
});

test("the CLI explains what to do when it can't pick a machine", async () => {
  const { harness, calls } = await setup(() => status);
  const noThread = await harness.behavior.runCli(["status"]);
  assert.notEqual(noThread.exitCode, 0);
  assert.match(String(noThread.stderr), /--machine/);
  const unknown = await harness.behavior.runCli([
    "status",
    "--machine",
    "ghost",
  ]);
  assert.notEqual(unknown.exitCode, 0);
  assert.match(String(unknown.stderr), /ghost/);
  assert.equal(calls.length, 0);
});
