/**
 * Readable-name facade over the vendored `workbuddy-core.mjs`.
 *
 * The vendored bundle (see `vendor/workbuddy-core.mjs`) exports tsdown's
 * minified single-letter aliases; this module re-exports the subset this
 * package uses under the upstream's documented names, so call sites never
 * touch the letters. Value exports live in `import * as raw`, instance types
 * come from `vendor/workbuddy-core.d.mts`.
 */
import * as raw from "../vendor/workbuddy-core.mjs";

// --- classes (constructor value + instance type) ---------------------------

export const WorkBuddyCredentialStore = raw.m;
export type WorkBuddyCredentialStore = raw.WorkBuddyCredentialStore;

export const WorkBuddyUpstreamClient = raw.O;
export type WorkBuddyUpstreamClient = raw.WorkBuddyUpstreamClient;

export const WorkBuddyCatalog = raw.d;
export type WorkBuddyCatalog = raw.WorkBuddyCatalog;

// --- values ----------------------------------------------------------------

/** OpenAI chat-completions body → upstream-normalized body (stream/developer/tool_choice). */
export const prepareChatBody = raw.P;
/** User-facing detail out of an upstream error body. */
export const extractDisplayErrorMessage = raw.A;
/** Trim a credits multiplier to a language-neutral display form (`"x0.79 credits"` → `"x0.79"`). */
export const normalizeCredits = raw.M;
/** Unmistakably non-canonical probe value. */
export const randomSentinel = raw.B;
/** Effort values a probe tests, in fixed order. */
export const PROBE_EFFORT_CANDIDATES = raw.R;
/** Probe one model (baseline → sentinel → level sweep). */
export const probeModel = raw.z;
/** Every WorkBuddy product variant. */
export const WORKBUDDY_VARIANTS = raw.C;
/** The CN variant. */
export const CN_VARIANT = raw.S;
/** The international variant. */
export const AI_VARIANT = raw.x;
/** Look up a variant by provider id. */
export const variantFor = raw.w;
/** Upstream region a credential's login domain belongs to. */
export const regionOf = raw.L;
/** Static CN roster served before the first successful fetch. */
export const FALLBACK_WORKBUDDY_MODELS = raw.u;
/** Static international roster served before the first successful fetch. */
export const FALLBACK_WORKBUDDY_AI_MODELS = raw.l;
/** Env var overriding the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = raw.p;
/** Platform-default desktop auth-file candidates for one variant. */
export const desktopAuthCandidatesFor = raw._;
/** First platform-default candidate, for diagnostics. */
export const defaultDesktopAuthPath = raw.g;
/** The at-rest protector-key provider (spawns the app's Electron) for one variant. */
export const atRestKeyProviderFor = raw.b;
/** Version of the vendored core (matches dsh-workbuddy-connect's release). */
export const WORKBUDDY_CONNECT_VERSION = raw.c;
/** Resolve the App-version used in the international catalog User-Agent. */
export const resolveAppVersion = raw.Q;
/** The installed international App's version, when readable. */
export const installedAppVersion = raw.X;

// --- types -----------------------------------------------------------------

export type {
  AppVersionInfo,
  ChatIdentity,
  ProbeAttempt,
  ProbeModelOptions,
  ProbeOutcome,
  ProbeRegion,
  ProbeSender,
  WorkBuddyAtRestKeyProvider,
  WorkBuddyAuthStatus,
  WorkBuddyCatalogFetch,
  WorkBuddyChatResult,
  WorkBuddyCredential,
  WorkBuddyCredentialStoreOptions,
  WorkBuddyCreditAccount,
  WorkBuddyCreditExpiry,
  WorkBuddyCredits,
  WorkBuddyEffort,
  WorkBuddyExpiringCredits,
  WorkBuddyModelBilling,
  WorkBuddyModelReasoning,
  WorkBuddyPromotion,
  WorkBuddyRefreshOutcome,
  WorkBuddyRegion,
  WorkBuddySignedOutReasonCode,
  WorkBuddyUpstreamClientOptions,
  WorkBuddyUpstreamErrorKind,
  WorkBuddyUpstreamModel,
  WorkBuddyVariant,
} from "../vendor/workbuddy-core.mjs";
