// Runs on the machine that holds the thread's workspace.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.ts";
import { createLimiter, extractDocument } from "./lib/extract.ts";
import { createInstaller } from "./lib/release.ts";

type Installer = ReturnType<typeof createInstaller>;

let installer: Installer | null = null;
const limit = createLimiter(2);

function installerFor(context: {
  experimental_paths: { dataDir: string };
  lifecycle: { signal: AbortSignal };
}): Installer {
  installer ??= createInstaller({
    dataDir: context.experimental_paths.dataDir,
    signal: context.lifecycle.signal,
  });
  return installer;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: async (_input, context) => installerFor(context).status(),
    install: async (_input, context) => {
      const current = installerFor(context);
      await current.ensureInstalled();
      return current.status();
    },
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
