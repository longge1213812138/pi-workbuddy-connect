/**
 * Per-variant assembly: one runtime owns the credential store, upstream
 * client, live catalog, and the three state stores of one WorkBuddy product.
 *
 * The two variants (CN `workbuddy`, international `workbuddy-ai`) are fully
 * separate here — same-named models exist on both endpoints but never share
 * billing, windows, probe records, or visibility preferences.
 */
import {
  AI_VARIANT,
  CN_VARIANT,
  FALLBACK_WORKBUDDY_AI_MODELS,
  FALLBACK_WORKBUDDY_MODELS,
  WORKBUDDY_CONNECT_VERSION,
  WorkBuddyCatalog,
  WorkBuddyCredentialStore,
  WorkBuddyUpstreamClient,
  atRestKeyProviderFor,
  resolveAppVersion,
  variantFor,
  type WorkBuddyAtRestKeyProvider,
  type WorkBuddyCredential,
  type WorkBuddyUpstreamClient as WorkBuddyUpstreamClientType,
  type WorkBuddyUpstreamModel,
  type WorkBuddyVariant,
} from "./core.ts";
import { observedEffortsOf, toPiModel, type ObservedEfforts } from "./models.ts";
import { CatalogStore, ProbeStore, VisibilityStore, accountKeyOf, fingerprintModel } from "./stores.ts";
import { readConfig, statePaths, stateRoot, type StatePaths, type WorkBuddyConfig } from "./state.ts";

/** Where the served catalog currently comes from, for `/workbuddy status`. */
export interface CatalogMeta {
  origin: "fallback" | "saved" | "live";
  /** Which upstream document answered, e.g. `workbuddy-ai:app`. */
  source?: string;
  /** When the live fetch last succeeded, epoch milliseconds. */
  fetchedAtMs?: number;
  /** Why the most recent live fetch failed, when it did. */
  error?: string;
}

export interface VariantRuntime {
  variant: WorkBuddyVariant;
  paths: StatePaths;
  config: WorkBuddyConfig;
  client: WorkBuddyUpstreamClientType;
  credentials: WorkBuddyCredentialStore;
  keyProvider: WorkBuddyAtRestKeyProvider;
  catalog: WorkBuddyCatalog;
  probeStore: ProbeStore;
  visibilityStore: VisibilityStore;
  savedCatalogs: CatalogStore;
  pluginVersion: string;
  /** Mutable provenance of the served catalog. */
  catalogMeta: CatalogMeta;
  /** The account currently in effect, as `uid:enterpriseId`, when known. */
  account(): string | undefined;
  /** Record the credential a request resolved, so availability filters can key on it. */
  noteCredential(credential: WorkBuddyCredential | undefined): void;
  /** The usable probe observation for one model, if any. */
  observedFor(modelId: string): ObservedEfforts | undefined;
  /** The full pi-ai model list this variant serves right now. */
  models(): readonly ReturnType<typeof toPiModel>[];
}

export interface CreateVariantRuntimeOptions {
  variant?: WorkBuddyVariant | string;
  /** State root override for tests. Defaults to `~/.pi/agent/workbuddy/`. */
  stateRoot?: string;
  /** Injected client for tests. */
  client?: WorkBuddyUpstreamClientType;
  /** Injected key provider for tests (spawns nothing). */
  keyProvider?: WorkBuddyAtRestKeyProvider;
  /** Clock injection for tests. */
  now?: () => number;
}

/** The static roster a variant serves before its first successful fetch. */
export function fallbackFor(variant: WorkBuddyVariant): readonly WorkBuddyUpstreamModel[] {
  return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS : FALLBACK_WORKBUDDY_AI_MODELS;
}

export function createVariantRuntime(options: CreateVariantRuntimeOptions = {}): VariantRuntime {
  const variant = resolveVariant(options.variant);
  const paths = statePaths(options.stateRoot ?? stateRoot(), variant.id);
  const config = readConfig(paths);
  const now = options.now ?? (() => Date.now());

  const client =
    options.client ??
    new WorkBuddyUpstreamClient({
      // Keep the App-version caches inside this package's state directory
      // instead of the vendored default (the harness home).
      resolveAppVersion: () => resolveAppVersion({ path: variant.id === CN_VARIANT.id ? paths.appVersionCn : paths.appVersionAi }),
    });
  const keyProvider = options.keyProvider ?? atRestKeyProviderFor(variant);
  const credentials = new WorkBuddyCredentialStore({
    variant,
    ownPath: paths.auth,
    keyProvider,
    refresh: (credential) => client.refreshToken(credential),
  });

  const catalog = new WorkBuddyCatalog(fallbackFor(variant));
  if (variant.id !== CN_VARIANT.id) catalog.setUseMaximumContextWindow(config.useMaximumContextWindowAI);

  const probeStore = new ProbeStore({ path: paths.probe, pluginVersion: WORKBUDDY_CONNECT_VERSION, now });
  const visibilityStore = new VisibilityStore({ path: paths.visibility });
  const savedCatalogs = new CatalogStore({ path: paths.catalog });

  let accountCache: string | undefined;

  const runtime: VariantRuntime = {
    variant,
    paths,
    config,
    client,
    credentials,
    keyProvider,
    catalog,
    probeStore,
    visibilityStore,
    savedCatalogs,
    pluginVersion: WORKBUDDY_CONNECT_VERSION,
    catalogMeta: { origin: "fallback" },
    account: () => accountCache,
    noteCredential: (credential) => {
      accountCache = credential === undefined ? undefined : accountKeyOf(credential);
    },
    observedFor: (modelId) => {
      const info = catalog.current().find((model) => model.id === modelId);
      if (info === undefined) return undefined;
      // A declared set always wins; observations only fill undeclared models.
      if (info.reasoning?.supportedEfforts !== undefined && info.reasoning.supportedEfforts.length > 0) return undefined;
      const account = accountCache;
      if (account === undefined) return undefined;
      return observedEffortsOf(probeStore.get(modelId, fingerprintModel(info), account));
    },
    models: () =>
      catalog.current().map((info) =>
        toPiModel(info, { providerId: variant.id, region: variant.region, observed: runtime.observedFor(info.id) }),
      ),
  };
  return runtime;
}

function resolveVariant(variant: CreateVariantRuntimeOptions["variant"]): WorkBuddyVariant {
  if (typeof variant === "object" && variant !== null) return variant;
  if (typeof variant === "string") {
    const found = variantFor(variant);
    if (found === undefined) throw new Error(`pi-workbuddy-connect: unknown provider id ${JSON.stringify(variant)}`);
    return found;
  }
  return CN_VARIANT;
}

/** Both variants, CN first — the plugin's long-standing default order. */
export function allVariants(): readonly WorkBuddyVariant[] {
  return [CN_VARIANT, AI_VARIANT];
}
