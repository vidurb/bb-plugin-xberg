import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { XBERG_RELEASE, createInstaller } from "../lib/release.ts";

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "xberg-release-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const packageDir = join(dir, "pkg", "xberg-cli-test");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "xberg"), "#!/bin/sh\n");
  await chmod(join(packageDir, "xberg"), 0o755);
  const archivePath = join(dir, "cli.tar.gz");
  execFileSync("tar", [
    "-czf",
    archivePath,
    "-C",
    join(dir, "pkg"),
    "xberg-cli-test",
  ]);
  const body = await readFile(archivePath);
  let requests = 0;
  let status = 200;
  const server = createServer((_request, response) => {
    requests += 1;
    response.statusCode = status;
    response.end(status === 200 ? body : "nope");
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  t.after(() => new Promise((done) => server.close(done)));
  const { port } = server.address() as AddressInfo;
  const release = (sha256: string, version = "9.9.9") => ({
    version,
    baseUrl: `http://127.0.0.1:${port}`,
    assets: { "test-os": { target: "test", sha256 } },
  });
  return {
    dataDir: join(dir, "data"),
    digest: createHash("sha256").update(body).digest("hex"),
    release,
    requests: () => requests,
    setStatus: (next: number) => {
      status = next;
    },
  };
}

test("the pinned release covers the machines bb runs on, with real digests", () => {
  assert.deepEqual(Object.keys(XBERG_RELEASE.assets).sort(), [
    "darwin-arm64",
    "linux-arm64",
    "linux-x64",
  ]);
  for (const asset of Object.values(XBERG_RELEASE.assets)) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(XBERG_RELEASE.baseUrl.endsWith(`/v${XBERG_RELEASE.version}`));
});

test("installs once, verified and atomically, and reports status", async (t) => {
  const { dataDir, digest, release, requests } = await setup(t);
  const installer = createInstaller({
    dataDir,
    release: release(digest),
    platform: "test-os",
  });
  assert.deepEqual(await installer.status(), {
    version: "9.9.9",
    platform: "test-os",
    supported: true,
    installed: false,
    binaryPath: null,
  });
  const [first, second] = await Promise.all([
    installer.ensureInstalled(),
    installer.ensureInstalled(),
  ]);
  assert.equal(first, second);
  assert.equal(first, join(dataDir, "releases", "9.9.9", "xberg"));
  assert.equal(requests(), 1, "concurrent callers share one download");
  await installer.ensureInstalled();
  assert.equal(requests(), 1, "an installed release is not downloaded again");
  assert.equal((await installer.status()).installed, true);
  assert.deepEqual(await readdir(join(dataDir, "releases")), ["9.9.9"]);
});

test("a wrong checksum installs nothing and a later attempt can succeed", async (t) => {
  const { dataDir, digest, release } = await setup(t);
  const bad = createInstaller({
    dataDir,
    release: release("0".repeat(64)),
    platform: "test-os",
  });
  await assert.rejects(bad.ensureInstalled(), /Checksum mismatch/);
  assert.equal((await bad.status()).installed, false);
  assert.deepEqual(await readdir(join(dataDir, "releases")), []);
  const good = createInstaller({
    dataDir,
    release: release(digest),
    platform: "test-os",
  });
  await good.ensureInstalled();
  assert.equal((await good.status()).installed, true);
});

test("an HTTP failure is reported and can be retried", async (t) => {
  const { dataDir, digest, release, setStatus } = await setup(t);
  const installer = createInstaller({
    dataDir,
    release: release(digest),
    platform: "test-os",
  });
  setStatus(404);
  await assert.rejects(installer.ensureInstalled(), /HTTP 404/);
  setStatus(200);
  await installer.ensureInstalled();
  assert.equal((await installer.status()).installed, true);
});

test("an unsupported platform says so, including inherited object keys", async (t) => {
  const { dataDir, digest, release } = await setup(t);
  for (const platform of ["win32-x64", "constructor"]) {
    const installer = createInstaller({
      dataDir,
      release: release(digest),
      platform,
    });
    assert.equal((await installer.status()).supported, false);
    await assert.rejects(installer.ensureInstalled(), /no supported build/);
  }
});

test("installing a new version removes the old one", async (t) => {
  const { dataDir, digest, release } = await setup(t);
  await createInstaller({
    dataDir,
    release: release(digest, "1.0.0"),
    platform: "test-os",
  }).ensureInstalled();
  await createInstaller({
    dataDir,
    release: release(digest, "2.0.0"),
    platform: "test-os",
  }).ensureInstalled();
  assert.deepEqual(await readdir(join(dataDir, "releases")), ["2.0.0"]);
});
