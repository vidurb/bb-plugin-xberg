// Runs on the machine that holds the thread's workspace.
import {
  experimental_defineHostEntry,
  experimental_killProcessesWithCwdUnder,
} from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.ts";
import { cacheSize, clearCache, workDirFor } from "./lib/cache.ts";
import { createLimiter, extractDocument } from "./lib/extract.ts";
import { createInstaller } from "./lib/release.ts";

type Installer = ReturnType<typeof createInstaller>;

const installers = new Map<string, Installer>();
const limit = createLimiter(2);

interface HostContext {
  experimental_paths: { dataDir: string };
  lifecycle: { signal: AbortSignal };
}

function installerFor(context: HostContext): Installer {
  const { dataDir } = context.experimental_paths;
  let installer = installers.get(dataDir);
  if (!installer) {
    installer = createInstaller({
      dataDir,
      signal: context.lifecycle.signal,
    });
    installers.set(dataDir, installer);
  }
  return installer;
}

async function statusFor(context: HostContext) {
  return {
    ...(await installerFor(context).status()),
    cacheBytes: await cacheSize(context.experimental_paths.dataDir),
  };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: async (_input, context) => statusFor(context),
    install: async (_input, context) => {
      await installerFor(context).ensureInstalled();
      return statusFor(context);
    },
    clearCache: async (_input, context) => ({
      removedBytes: await clearCache(context.experimental_paths.dataDir),
    }),
    extract: async (input, context) => {
      const current = installerFor(context);
      // Xberg must stop when the call is cancelled and when the worker stops
      // (reload, idle eviction, shutdown), or it would outlive its timeout.
      const signal = AbortSignal.any([
        context.signal,
        context.lifecycle.signal,
      ]);
      return limit(() =>
        extractDocument(input, {
          ensureInstalled: current.ensureInstalled,
          dataDir: context.experimental_paths.dataDir,
          signal,
        }),
      );
    },
  },
  // Covers a run whose abort didn't land before the worker exits.
  dispose: async () => {
    const directories = [...installers.keys()].map(workDirFor);
    if (directories.length > 0) {
      await experimental_killProcessesWithCwdUnder({ directories });
    }
  },
});
