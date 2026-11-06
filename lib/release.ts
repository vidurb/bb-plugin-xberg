// Installs the pinned Xberg CLI release into the plugin's data directory.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface Release {
  version: string;
  baseUrl: string;
  /** Keyed by `${process.platform}-${process.arch}`. */
  assets: Record<string, { target: string; sha256: string }>;
}

// Digests from the GitHub release's asset metadata. Linux uses the musl builds
// because each archive bundles its own loader and libraries. Intel Macs are
// left out: that build needs a separately installed ONNX Runtime.
export const XBERG_RELEASE: Release = {
  version: "1.3.10",
  baseUrl: "https://github.com/xberg-io/xberg/releases/download/v1.3.10",
  assets: {
    "darwin-arm64": {
      target: "aarch64-apple-darwin",
      sha256:
        "378cc1a7e76addb1302944fd155daead565dba1aa913cec56d19ef2a5878b45a",
    },
    "linux-arm64": {
      target: "aarch64-unknown-linux-musl",
      sha256:
        "cab99a017d3d4ce0d9f54a59010c29601c24487294bc4df60cc675b3c17c0f9a",
    },
    "linux-x64": {
      target: "x86_64-unknown-linux-musl",
      sha256:
        "2da47d679d9175502ba029ef97397db2a8a346ae0e86fdfc00546427d1fd4a16",
    },
  },
};

export interface InstallerOptions {
  dataDir: string;
  /** Stops a running download when the host worker shuts down. */
  signal?: AbortSignal;
  release?: Release;
  platform?: string;
}

export function createInstaller(options: InstallerOptions) {
  const release = options.release ?? XBERG_RELEASE;
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  const asset = Object.hasOwn(release.assets, platform)
    ? release.assets[platform]
    : undefined;
  const releasesDir = join(options.dataDir, "releases");
  const installDir = join(releasesDir, release.version);
  const binaryPath = join(installDir, "xberg");
  let installing: Promise<string> | null = null;

  async function isInstalled(): Promise<boolean> {
    return access(binaryPath).then(
      () => true,
      () => false,
    );
  }

  async function install(): Promise<string> {
    if (!asset) {
      throw new Error(
        `Xberg ${release.version} has no supported build for ${platform}.`,
      );
    }
    await mkdir(releasesDir, { recursive: true });
    // Staged beside the final directory so the rename is atomic.
    const staging = await mkdtemp(join(releasesDir, ".install-"));
    try {
      const archive = join(staging, "xberg.tar.gz");
      const url = `${release.baseUrl}/xberg-cli-${asset.target}.tar.gz`;
      await download(url, archive, asset.sha256, options.signal);
      const unpacked = join(staging, "unpacked");
      await mkdir(unpacked);
      await untar(archive, unpacked, options.signal);
      await access(join(unpacked, "xberg"));
      await rename(unpacked, installDir);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    await removeOtherReleases(releasesDir, release.version);
    return binaryPath;
  }

  return {
    async status() {
      const installed = await isInstalled();
      return {
        version: release.version,
        platform,
        supported: asset !== undefined,
        installed,
        binaryPath: installed ? binaryPath : null,
      };
    },
    /** Installs on first use. Concurrent callers share one download. */
    async ensureInstalled(): Promise<string> {
      if (await isInstalled()) return binaryPath;
      installing ??= install().finally(() => {
        installing = null;
      });
      return installing;
    },
  };
}

async function download(
  url: string,
  destination: string,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`Downloading ${url} failed with HTTP ${response.status}.`);
  }
  const hash = createHash("sha256");
  const hashing = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as never),
    hashing,
    createWriteStream(destination),
    { signal },
  );
  const actual = hash.digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(
      `Checksum mismatch for ${url}: expected ${expectedSha256}, got ${actual}.`,
    );
  }
}

function untar(
  archive: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "tar",
      ["-xzf", archive, "-C", destination, "--strip-components=1"],
      { stdio: ["ignore", "ignore", "pipe"], signal },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with ${code}: ${stderr.trim()}`));
    });
  });
}

async function removeOtherReleases(
  releasesDir: string,
  keep: string,
): Promise<void> {
  for (const entry of await readdir(releasesDir)) {
    if (entry !== keep && !entry.startsWith(".install-")) {
      await rm(join(releasesDir, entry), { recursive: true, force: true });
    }
  }
}
