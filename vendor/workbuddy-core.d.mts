/**
 * Typings for the subset of `vendor/workbuddy-core.mjs` this package uses.
 *
 * The vendored bundle exports minified single-letter aliases (its tsdown
 * output); `src/core.ts` re-exports them under readable names. Interface names
 * here follow the upstream `lib/index.d.ts` documentation so behavior notes
 * travel with the types.
 */

// ---------------------------------------------------------------------------
// Credential & auth
// ---------------------------------------------------------------------------

export type WorkBuddyRegion = "cn" | "global";

export interface WorkBuddyCredential {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  domain: string;
  uid: string;
  enterpriseId?: string;
  nickname?: string;
  /** Which storage the credential was read from; refreshes are always `dsh`. */
  source: "desktop" | "dsh";
}

export type WorkBuddySignedOutReasonCode =
  | "no-credential"
  | "credential-region-mismatch"
  | "encrypted-credential-unreadable"
  | "electron-binary-not-found"
  | "electron-binary-ambiguous"
  | "electron-binary-unavailable"
  | "electron-path-invalid"
  | "electron-discovery-incomplete";

export interface WorkBuddyAuthStatus {
  state: "signed-in" | "signed-out";
  expiresAtMs?: number;
  refreshExpiresAtMs?: number;
  nickname?: string;
  domain?: string;
  source?: "desktop" | "dsh";
  reason?: string;
  reasonCode?: WorkBuddySignedOutReasonCode;
}

export interface WorkBuddyRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  domain?: string;
}

export interface WorkBuddyAtRestKeyProvider {
  protectorKeyFor(requested: readonly string[]): Promise<Buffer>;
  helperPath(): string | undefined;
}

export interface WorkBuddyCredentialStoreOptions {
  variant?: WorkBuddyVariant;
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string;
  /** Explicit plugin-owned copy path, defaulting under the harness home. */
  ownPath?: string;
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number;
  /** Resolver for WorkBuddy 5.6's at-rest protector key. Defaults to the real provider. */
  keyProvider?: WorkBuddyAtRestKeyProvider;
}

export interface WorkBuddyCredentialStore {
  /** Repoint the desktop file; a settings change applies on the next read. */
  setDesktopPath(path: string | undefined): void;
  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined;
  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string;
  /** Read the freshest stored credential without refreshing anything. */
  current(): Promise<WorkBuddyCredential | undefined>;
  /** The credential to send upstream: `current()`, refreshed on demand. */
  resolve(): Promise<WorkBuddyCredential>;
  /** Read-only sign-in summary; never refreshes and never throws. */
  status(): Promise<WorkBuddyAuthStatus>;
  /** Remove the plugin-owned copy; the desktop file is untouched. */
  logout(): Promise<void>;
  /** Classify the first desktop candidate that exists: `absent` | `plaintext` | `encrypted` | `unrecognized`. */
  desktopAuthFormat(): Promise<"absent" | "plaintext" | "encrypted" | "unrecognized">;
  /** The first desktop candidate the probe would actually read from. */
  resolvedDesktopAuthPath(): Promise<string | undefined>;
  /** Whether any desktop-file candidate exists as a regular file. */
  desktopFilePresent(): Promise<boolean>;
}

export interface WorkBuddyCredentialStoreConstructor {
  new (options: WorkBuddyCredentialStoreOptions): WorkBuddyCredentialStore;
}

// ---------------------------------------------------------------------------
// Upstream models & catalog
// ---------------------------------------------------------------------------

export type WorkBuddyEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkBuddyModelReasoning {
  /** Whether the model does any reasoning at all. */
  supports: boolean;
  /** Whether the model can only think. */
  onlyReasoning: boolean;
  /** Selectable effort values; absent means the model has no explicit set. */
  supportedEfforts?: readonly WorkBuddyEffort[];
  /** Default effort the upstream uses when none is chosen. */
  defaultEffort?: WorkBuddyEffort;
  /** Whether thinking can be switched off; false means it is always on. */
  canDisableThinking: boolean;
}

export interface WorkBuddyModelBilling {
  /** Credits multiplier, e.g. `"x0.00"` (free) or `"x0.79"`. */
  credits?: string;
  /** Promotional tags, e.g. `"限时免费"`, `"夜间折扣"`. */
  badges?: readonly string[];
  /** Whether the model is currently free (`x0.00` credits). */
  free: boolean;
  /** The rate cannot be stated for this model right now (expired promotion baked into `credits`). */
  rateUnknown?: boolean;
}

export interface WorkBuddyPromotion {
  /** The upstream's own fields vary; treated as opaque display data here. */
  readonly [key: string]: unknown;
}

export interface WorkBuddyUpstreamModel {
  id: string;
  name: string;
  contextWindow: number;
  /** The upstream's preferred window before an optional maximum is selected. */
  defaultContextWindow?: number;
  maxInputTokens?: number;
  supportedContextWindows?: readonly number[];
  promotions?: readonly WorkBuddyPromotion[];
  maxTokens: number;
  supportsImages: boolean;
  reasoning?: WorkBuddyModelReasoning;
  billing?: WorkBuddyModelBilling;
}

export interface WorkBuddyCatalogFetch {
  fetchedAtMs: number;
  /** Which document answered, e.g. `workbuddy-ai:app`. */
  source: string;
  appVersion?: AppVersionInfo;
}

export interface WorkBuddyCatalog {
  /** Current entries; empty while the variant has no usable credential. */
  current(): readonly WorkBuddyUpstreamModel[];
  /** Replace the list. */
  set(models: readonly WorkBuddyUpstreamModel[]): void;
  /** Whether this variant's models are exposed at all. */
  isVisible(): boolean;
  /** Show or hide the whole catalog. Returns whether the value changed. */
  setVisible(visible: boolean): boolean;
  /** Select the largest declared context window where the upstream offers one. */
  setUseMaximumContextWindow(useMaximum: boolean): boolean;
  /** Models to fall back to when the upstream fetch fails; ignores visibility. */
  fallback(): readonly WorkBuddyUpstreamModel[];
}

export interface WorkBuddyCatalogConstructor {
  new (initial?: readonly WorkBuddyUpstreamModel[]): WorkBuddyCatalog;
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

export interface WorkBuddyExpiringCredits {
  total: number;
  packages: number;
  earliestEndTimeMs?: number;
}

export interface WorkBuddyCreditExpiry {
  within24h: WorkBuddyExpiringCredits;
  within3d: WorkBuddyExpiringCredits;
  within7d: WorkBuddyExpiringCredits;
}

export interface WorkBuddyCreditAccount {
  packageName: string;
  remain: number;
  size: number;
  unlimited?: true;
  /** When the package's own cycle ends, in epoch milliseconds. */
  endTimeMs?: number;
}

export interface WorkBuddyCredits {
  total: number;
  accounts: readonly WorkBuddyCreditAccount[];
  /** The account's cycle quota is uncapped. Test before falling back to `total`. */
  unlimited?: true;
  cycleResetTime?: string;
  /** Credit lapsing soon. Absent when no account carried a usable end time. */
  expiry?: WorkBuddyCreditExpiry;
}

// ---------------------------------------------------------------------------
// Chat transport
// ---------------------------------------------------------------------------

export type WorkBuddyUpstreamErrorKind =
  | "hard_credit"
  | "soft_rate"
  | "session_dead"
  | "not_found"
  | "server"
  | "client";

/** Chat answer: either a live SSE response or a classified failure. */
export type WorkBuddyChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: WorkBuddyUpstreamErrorKind; message: string };

export interface WorkBuddyUpstreamClientOptions {
  /** App-version resolver for international catalog requests. */
  resolveAppVersion?: () => Promise<AppVersionInfo>;
  /** Chat-identity resolver for chat and probe requests. */
  resolveChatIdentity?: (region: WorkBuddyRegion) => Promise<ChatIdentity>;
}

export interface WorkBuddyUpstreamClient {
  /** Provenance of the most recent successful catalog fetch. */
  lastCatalog: WorkBuddyCatalogFetch | undefined;
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  chatStream(credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal): Promise<WorkBuddyChatResult>;
  /** POST the token-refresh endpoint; the caller merges the outcome. */
  refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome>;
  /** GET the personal model catalog (`/v3/config`, UA-split). */
  fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]>;
  /** POST the billing endpoint for the aggregated remaining credit. */
  fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits>;
  /** One probe request against the chat endpoint. */
  probeEffort(credential: WorkBuddyCredential, model: string, effort: string | undefined, signal?: AbortSignal): Promise<ProbeAttempt>;
}

export interface WorkBuddyUpstreamClientConstructor {
  new (options?: WorkBuddyUpstreamClientOptions): WorkBuddyUpstreamClient;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export interface ProbeAttempt {
  /** HTTP status, or 0 for a transport failure. */
  status: number;
  /** True when a parseable SSE event arrived. */
  streamed: boolean;
  /** `extError.code` from a JSON error body, when present. */
  errorCode?: string;
  /** Free-form detail for logs; never a capability claim. */
  detail?: string;
}

export type ProbeSender = (effort: string | undefined, signal: AbortSignal) => Promise<ProbeAttempt>;

export type ProbeRegion = "cn" | "global";

export type ProbeOutcome =
  | { validation: "validating"; efforts: readonly WorkBuddyEffort[]; requests: number }
  | { validation: "non-validating"; efforts: readonly []; requests: number }
  | { validation: "unknown"; efforts: readonly []; requests: number; reason: string };

export interface ProbeModelOptions {
  send: ProbeSender;
  sentinel?: () => string;
  candidates?: readonly WorkBuddyEffort[];
  timeoutMs?: number;
  region?: ProbeRegion;
}

// ---------------------------------------------------------------------------
// Identity & variants
// ---------------------------------------------------------------------------

export interface AppVersionInfo {
  version: string;
  source: "installed" | "saved" | "fallback";
  bundle?: string;
}

export interface ChatIdentity {
  /** Desktop App version; drives the desktop UA and `X-IDE-Version`. */
  clientVersion: string;
  /** Bundled agent-CLI version; absent drops the `CLI/…` UA token. */
  cliVersion?: string;
}

export interface WorkBuddyElectronProduct {
  productName: string;
  envVar: string;
  macOS: { bundleId: string; defaultPath: string };
  windows: {
    displayNamePattern: RegExp;
    exeBasename: string;
    defaultPathSegments?: readonly string[];
  };
}

export interface WorkBuddyVariant {
  /** Provider id registered with the host, e.g. `workbuddy-ai`. */
  id: string;
  /** Model-group heading and card title stem. */
  displayName: string;
  /** Desktop app name as users know it, for diagnostics and error copy. */
  appName: string;
  /** Which upstream region this variant's credentials must belong to. */
  region: WorkBuddyRegion;
  /** Env var overriding the desktop auth-file location. */
  env: string;
  electron?: WorkBuddyElectronProduct;
  desktopFilename: string;
  ownFilename: string;
  probeFilename: string;
  catalogFilename: string;
  visibilityFilename: string;
  statusPath: string;
  probePath: string;
}

// ---------------------------------------------------------------------------
// Module exports (minified aliases of the vendored bundle)
// ---------------------------------------------------------------------------

/** `extractDisplayErrorMessage(message)` — user-facing detail out of an error body. */
export declare const A: (message: string) => string | undefined;
/** `randomSentinel()` — unmistakably non-canonical probe value. */
export declare const B: () => string;
/** `WORKBUDDY_VARIANTS` */
export declare const C: readonly WorkBuddyVariant[];
/** `regionOf(domain)` */
export declare const L: (domain: string) => WorkBuddyRegion;
/** `normalizeCredits(credits?)` — trim to a language-neutral display form. */
export declare const M: (credits?: string) => string | undefined;
/** `WorkBuddyUpstreamClient` */
export declare const O: WorkBuddyUpstreamClientConstructor;
/** `prepareChatBody(source)` — OpenAI body → upstream-normalized body. */
export declare const P: (source: string) => string;
/** `resolveAppVersion(options?)` */
export declare const Q: (options?: { path?: string; installed?: () => Promise<{ version: string; bundle: string } | undefined> }) => Promise<AppVersionInfo>;
/** `PROBE_EFFORT_CANDIDATES` */
export declare const R: readonly WorkBuddyEffort[];
/** `CN_VARIANT` */
export declare const S: WorkBuddyVariant;
/** `installedAppVersion()` */
export declare const X: () => Promise<{ version: string; bundle: string } | undefined>;
/** `desktopAuthCandidatesFor(variant)` */
export declare const _: (variant: WorkBuddyVariant) => readonly string[];
/** `atRestKeyProviderFor(variant)` */
export declare const b: (variant: WorkBuddyVariant) => WorkBuddyAtRestKeyProvider;
/** `WORKBUDDY_CONNECT_VERSION` */
export declare const c: string;
/** `WorkBuddyCatalog` */
export declare const d: WorkBuddyCatalogConstructor;
/** `defaultDesktopAuthPath(variant?)` */
export declare const g: (variant?: WorkBuddyVariant) => string | undefined;
/** `FALLBACK_WORKBUDDY_AI_MODELS` */
export declare const l: readonly WorkBuddyUpstreamModel[];
/** `WorkBuddyCredentialStore` */
export declare const m: WorkBuddyCredentialStoreConstructor;
/** `WORKBUDDY_AUTH_FILE_ENV` */
export declare const p: string;
/** `FALLBACK_WORKBUDDY_MODELS` */
export declare const u: readonly WorkBuddyUpstreamModel[];
/** `variantFor(id)` */
export declare const w: (id: string) => WorkBuddyVariant | undefined;
/** `AI_VARIANT` */
export declare const x: WorkBuddyVariant;
/** `probeModel(options)` */
export declare const z: (options: ProbeModelOptions) => Promise<ProbeOutcome>;
