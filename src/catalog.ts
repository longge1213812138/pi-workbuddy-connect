/**
 * Catalog lifecycle and availability filtering.
 *
 * `refreshModels` restores → fetches → degrades (last saved catalog of this
 * account → built-in fallback), recording provenance for `/workbuddy status`.
 * `filterModels` is the credential gate *and* the per-account visibility
 * filter: hiding is a listing concern only — `getModels()` keeps serving the
 * full catalog so a hidden model stays resolvable in sessions already using
 * it, exactly as the plugin behaves.
 */
import type { Api, Credential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { accountFromStoredCredential } from "./auth.ts";
import type { WorkBuddyCredential, WorkBuddyUpstreamModel } from "./core.ts";
import type { VariantRuntime } from "./runtime.ts";
import { accountKeyOf } from "./stores.ts";

/** Restore the saved catalog of the current account and publish it. */
async function restoreSaved(runtime: VariantRuntime, context: RefreshModelsContext): Promise<void> {
  const account = runtime.account();
  const saved = account === undefined ? undefined : runtime.savedCatalogs.get(account);
  if (saved !== undefined) {
    await context.publish({
      update: () => {
        runtime.catalog.set(saved.models);
        runtime.catalogMeta = { origin: "saved", source: saved.source, fetchedAtMs: saved.fetchedAtMs };
      },
    });
    return;
  }
  await context.publish({
    update: () => {
      runtime.catalog.set(runtime.catalog.fallback());
      runtime.catalogMeta = { origin: "fallback" };
    },
  });
}

/** Fetch the live catalog for the current credential and publish it. */
async function fetchLive(runtime: VariantRuntime, context: RefreshModelsContext): Promise<void> {
  let credential: WorkBuddyCredential;
  try {
    credential = await runtime.credentials.resolve();
  } catch (error) {
    runtime.catalogMeta = { ...runtime.catalogMeta, error: String(error) };
    return;
  }
  runtime.noteCredential(credential);
  try {
    const models = await runtime.client.fetchModels(credential, context.signal);
    const fetchedAtMs = Date.now();
    const source = runtime.client.lastCatalog?.source ?? "live";
    const appVersion = runtime.client.lastCatalog?.appVersion?.version;
    await context.publish({
      update: () => {
        runtime.catalog.set(models);
        runtime.catalogMeta = { origin: "live", source, fetchedAtMs };
      },
    });
    const account = accountKeyOf(credential);
    if (account !== undefined) {
      runtime.savedCatalogs.set(account, {
        source,
        fetchedAtMs,
        models: [...models] as WorkBuddyUpstreamModel[],
        ...(appVersion === undefined ? {} : { appVersion }),
      });
    }
  } catch (error) {
    // Keep whatever the restore phase left in place (saved or fallback).
    runtime.catalogMeta = { ...runtime.catalogMeta, error: String(error) };
  }
}

/** The full `refreshModels` contract: restore first, fetch on top, never lose the old list. */
export async function refreshCatalog(runtime: VariantRuntime, context: RefreshModelsContext): Promise<void> {
  await restoreSaved(runtime, context);
  if (!context.allowNetwork) return;
  await fetchLive(runtime, context);
}

/**
 * Credential- and account-specific availability. No usable account → the
 * group hides entirely (an empty catalog is how a provider disappears without
 * unregistering); otherwise hide this account's hidden model ids only.
 */
export function filterByVisibility<TModel extends Model<Api>>(
  runtime: VariantRuntime,
  models: readonly TModel[],
  credential: Credential | undefined,
): readonly TModel[] {
  const account = accountFromStoredCredential(credential) ?? runtime.account();
  if (account === undefined) return [];
  const hidden = runtime.visibilityStore.disabled(account);
  if (hidden.length === 0) return models;
  const hiddenSet = new Set(hidden);
  return models.filter((model) => !hiddenSet.has(model.id));
}
