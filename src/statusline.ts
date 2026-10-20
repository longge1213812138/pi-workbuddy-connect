/**
 * Status bar integration: show the remaining credit next to the model
 * selection, refreshed when a WorkBuddy model becomes active.
 *
 * Deliberately read-once per selection — every read is a real billing query —
 * with `/workbuddy balance` as the manual refresh, matching the plugin's
 * "read once on mount, refresh by hand" policy.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readBalanceText } from "./credits.ts";
import type { VariantRuntime } from "./runtime.ts";

export const STATUS_KEY = "workbuddy";

export function registerStatusline(pi: ExtensionAPI, runtimes: readonly VariantRuntime[]): void {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("model_select", async (event, ctx) => {
    const runtime = runtimes.find((candidate) => candidate.variant.id === event.model.provider);
    if (runtime === undefined) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, await readBalanceText(runtime));
  });
}
