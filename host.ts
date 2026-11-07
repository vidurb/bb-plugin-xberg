// Runs on the machine that holds the thread's workspace.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.ts";
import { cacheSize, clearCache } from "./lib/cache.ts";
import { createLimiter, extractDocument } from "./lib/extract.ts";
import { createInstaller } from "./lib/release.ts";

type Installer = ReturnType<typeof createInstaller>;

let installer: Installer | null = null;
const limit = createLimiter(2);

interface HostContext {
  experimental_paths: { dataDir: string };
  lifecycle: { signal: AbortSignal };
}

function installerFor(context: HostContext): Installer {
  installer ??= createInstaller({
    dataDir: context.experimental_paths.dataDir,
    signal: context.lifecycle.signal,
  });
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
      return limit(() =>
        extractDocument(input, {
          ensureInstalled: current.ensureInstalled,
          dataDir: context.experimental_paths.dataDir,
          signal: context.signal,
        }),
      );
    },
  },
});
