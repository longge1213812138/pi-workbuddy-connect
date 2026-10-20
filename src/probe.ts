/**
 * Reasoning-effort detection, user-authorized and account-scoped.
 *
 * The sweep (baseline → sentinel → level candidates) lives in the vendored
 * `probeModel`; this module owns the orchestration rules the plugin
 * documented: probing is manual-only and consented per run, results are keyed
 * by account × catalog fingerprint, an in-flight probe that finishes after an
 * account switch is discarded, and one sweep runs at a time.
 */
import { probeModel, type ProbeAttempt, type WorkBuddyCredential, type WorkBuddyUpstreamModel } from "./core.ts";
import { fingerprintModel, type ProbeStore, type ProbeValidation } from "./stores.ts";

/** The runtime surface a probe needs (structurally satisfied by VariantRuntime). */
export interface ProbeRuntime {
  variant: { region: "cn" | "global" };
  catalog: { current(): readonly WorkBuddyUpstreamModel[] };
  probeStore: ProbeStore;
  credentials: { current(): Promise<WorkBuddyCredential | undefined> };
  client: {
    probeEffort(
      credential: WorkBuddyCredential,
      model: string,
      effort: string | undefined,
      signal?: AbortSignal,
    ): Promise<ProbeAttempt>;
  };
  account(): string | undefined;
  noteCredential(credential: WorkBuddyCredential | undefined): void;
}

export type ProbeRunResult =
  | { state: "ok"; validation: ProbeValidation; efforts: readonly string[]; requests: number }
  | { state: "unavailable"; reason: string };

/** One probe run per runtime at a time: sweeps share a serial queue. */
const queues = new WeakMap<object, Promise<unknown>>();

/** Run one manual probe. `manualConsent` must come from an explicit UI confirmation. */
export function runProbe(runtime: ProbeRuntime, modelId: string, manualConsent: boolean): Promise<ProbeRunResult> {
  const previous = queues.get(runtime) ?? Promise.resolve();
  const run = previous.then(() => runProbeNow(runtime, modelId, manualConsent));
  queues.set(
    runtime,
    run.catch(() => undefined),
  );
  return run;
}

async function runProbeNow(runtime: ProbeRuntime, modelId: string, manualConsent: boolean): Promise<ProbeRunResult> {
  if (!manualConsent) return { state: "unavailable", reason: "probing requires explicit confirmation" };
  const current = runtime.catalog.current().find((model) => model.id === modelId);
  if (current === undefined) return { state: "unavailable", reason: `unknown model: ${modelId}` };
  const reasoning = current.reasoning;
  if (reasoning?.supports !== true) return { state: "unavailable", reason: "model does not support reasoning" };
  if ((reasoning.supportedEfforts?.length ?? 0) > 0) {
    return { state: "unavailable", reason: "model already declares its efforts; detection is not needed" };
  }
  const account = runtime.account();
  if (account === undefined) return { state: "unavailable", reason: "no WorkBuddy credential" };
  const credential = await runtime.credentials.current();
  if (credential === undefined) return { state: "unavailable", reason: "no WorkBuddy credential" };
  runtime.noteCredential(credential);

  const outcome = await probeModel({
    send: (effort, signal) => runtime.client.probeEffort(credential, modelId, effort, signal),
    region: runtime.variant.region,
  });

  // An observation produced under one account must not be stored once another
  // account is in effect, however long the sweep took.
  if (runtime.account() !== account) {
    return { state: "unavailable", reason: "account changed during detection; result discarded" };
  }
  const record = runtime.probeStore.record(fingerprintModel(current), outcome.validation, outcome.efforts, account);
  runtime.probeStore.set(modelId, record);
  if (outcome.validation === "unknown") return { state: "unavailable", reason: outcome.reason };
  return {
    state: "ok",
    validation: outcome.validation,
    efforts: record.efforts.map(String),
    requests: outcome.requests,
  };
}
