/**
 * pi-workbuddy-connect: WorkBuddy / WorkBuddy AI desktop models in Pi.
 *
 * One native provider per WorkBuddy variant (`workbuddy`, `workbuddy-ai`),
 * the `/workbuddy` command family, and the balance status bar. No processes,
 * sockets, or timers are started here — long-lived work happens lazily inside
 * auth resolution, catalog refreshes, and commands.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "../src/commands.ts";
import { createWorkBuddyProvider } from "../src/provider.ts";
import { allVariants, createVariantRuntime } from "../src/runtime.ts";
import { registerStatusline } from "../src/statusline.ts";

export default function workBuddyConnectExtension(pi: ExtensionAPI): void {
  const runtimes = allVariants().map((variant) => createVariantRuntime({ variant }));

  for (const runtime of runtimes) {
    pi.registerProvider(createWorkBuddyProvider(runtime));
  }

  registerCommands(pi, runtimes);
  registerStatusline(pi, runtimes);
}
