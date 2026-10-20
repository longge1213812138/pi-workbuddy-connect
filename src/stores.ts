/**
 * Durable per-account state: probe observations, model visibility, and saved
 * catalogs.
 *
 * Behavior rules follow dsh-workbuddy-connect's documented semantics:
 * everything is keyed by the stable account identity `uid:enterpriseId`;
 * probe records expire (14 days) and are invalidated by a catalog fingerprint
 * change; a transient `unknown` never erases a decisive observation; reads are
 * forgiving (a corrupt file reads as empty) while visibility writes propagate
 * failures so a preference that did not persist is never reported as hidden.
 */
import { createHash } from "node:crypto";
import type { WorkBuddyCredential, WorkBuddyEffort, WorkBuddyUpstreamModel } from "./core.ts";
import { readJsonObject, writeJsonAtomic } from "./state.ts";

/**
 * The account key state is stored under: the stable identity, but only when it
 * carries a uid. A credential with no `uid` would otherwise share one bucket
 * between every such account; those accounts get no per-account state at all.
 */
export function accountKeyOf(credential: Pick<WorkBuddyCredential, "uid" | "enterpriseId">): string | undefined {
  if (credential.uid === "") return undefined;
  return `${credential.uid}:${credential.enterpriseId ?? ""}`;
}

/**
 * Fingerprint the catalog fields a probe depends on.
 *
 * Deliberately excludes display-only fields (`name`, `billing`, `contextWindow`)
 * so a rename or a promo badge does not throw away a valid observation, and
 * deliberately includes the whole reasoning object so any change to the
 * declared shape re-probes.
 */
export function fingerprintModel(info: Pick<WorkBuddyUpstreamModel, "id" | "reasoning" | "supportsImages">): string {
  const basis = JSON.stringify({
    id: info.id,
    reasoning: info.reasoning ?? null,
    supportsImages: info.supportsImages ?? null,
  });
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Probe records
// ---------------------------------------------------------------------------

/** How the model's effort parameter is actually validated. */
export type ProbeValidation = "validating" | "non-validating" | "unknown";

/** One model's recorded observation, scoped to the account that produced it. */
export interface ProbeRecord {
  /** Fingerprint of the catalog row this observation was made against. */
  fingerprint: string;
  validation: ProbeValidation;
  /** Efforts verified as accepted; only ever non-empty for `validating`. */
  efforts: readonly WorkBuddyEffort[];
  /** When the probe ran, epoch milliseconds. */
  probedAtMs: number;
  /** Package version that produced the record. */
  pluginVersion: string;
  /** The account this observation was made under, as `uid:enterpriseId`. */
  account: string;
}

export interface ProbeStoreOptions {
  path: string;
  /** Observation lifetime; default 14 days. */
  ttlMs?: number;
  /** Package version stamped into new records. */
  pluginVersion: string;
  /** Clock injection for tests. */
  now?: () => number;
}

const DEFAULT_PROBE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export class ProbeStore {
  private readonly path: string;
  private readonly ttlMs: number;
  private readonly pluginVersion: string;
  private readonly now: () => number;
  private records: Record<string, Record<string, ProbeRecord>>;

  constructor(options: ProbeStoreOptions) {
    this.path = options.path;
    this.ttlMs = options.ttlMs ?? DEFAULT_PROBE_TTL_MS;
    this.pluginVersion = options.pluginVersion;
    this.now = options.now ?? (() => Date.now());
    this.records = this.load();
  }

  filePath(): string {
    return this.path;
  }

  private load(): Record<string, Record<string, ProbeRecord>> {
    const doc = readJsonObject(this.path);
    if (doc === undefined) return {};
    const raw = doc["records"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, Record<string, ProbeRecord>> = {};
    for (const [modelId, bucket] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket)) continue;
      const accounts: Record<string, ProbeRecord> = {};
      for (const [account, value] of Object.entries(bucket as Record<string, unknown>)) {
        const record = asProbeRecord(value);
        if (record !== undefined) accounts[account] = record;
      }
      if (Object.keys(accounts).length > 0) out[modelId] = accounts;
    }
    return out;
  }

  /**
   * The usable record for one account and model, or undefined when there is
   * none, it is expired, it was taken against a different catalog row, or it
   * belongs to a different account.
   */
  get(modelId: string, fingerprint: string, account: string): ProbeRecord | undefined {
    const record = this.records[modelId]?.[account];
    if (record === undefined) return undefined;
    if (record.account !== account) return undefined;
    if (record.fingerprint !== fingerprint) return undefined;
    if (this.now() - record.probedAtMs > this.ttlMs) return undefined;
    return record;
  }

  /**
   * Store one observation under the account stamped on it. Only a decisive
   * answer replaces an existing decisive record of the same account: a
   * transient `unknown` must not erase knowledge the user already paid for.
   */
  set(modelId: string, record: ProbeRecord): void {
    const bucket = (this.records[modelId] ??= {});
    const existing = bucket[record.account];
    if (existing !== undefined && existing.validation !== "unknown" && record.validation === "unknown") return;
    bucket[record.account] = record;
    this.persist();
  }

  /** Drop every record of every account. */
  clear(): void {
    this.records = {};
    this.persist();
  }

  /** Every record currently held, grouped by account then model id. */
  all(): Record<string, Record<string, ProbeRecord>> {
    return structuredClone(this.records);
  }

  /** Build a record stamped with this store's clock, version, and account. */
  record(
    fingerprint: string,
    validation: ProbeValidation,
    efforts: readonly WorkBuddyEffort[],
    account: string,
  ): ProbeRecord {
    return {
      fingerprint,
      validation,
      efforts: [...efforts],
      probedAtMs: this.now(),
      pluginVersion: this.pluginVersion,
      account,
    };
  }

  private persist(): void {
    writeJsonAtomic(this.path, { version: 1, records: this.records });
  }
}

function asProbeRecord(value: unknown): ProbeRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const doc = value as Record<string, unknown>;
  if (typeof doc["fingerprint"] !== "string" || typeof doc["account"] !== "string") return undefined;
  const validation = doc["validation"];
  if (validation !== "validating" && validation !== "non-validating" && validation !== "unknown") return undefined;
  const efforts = Array.isArray(doc["efforts"])
    ? (doc["efforts"] as unknown[]).filter((e): e is WorkBuddyEffort =>
        e === "low" || e === "medium" || e === "high" || e === "xhigh" || e === "max",
      )
    : [];
  return {
    fingerprint: doc["fingerprint"],
    validation,
    efforts,
    probedAtMs: typeof doc["probedAtMs"] === "number" ? doc["probedAtMs"] : 0,
    pluginVersion: typeof doc["pluginVersion"] === "string" ? doc["pluginVersion"] : "",
    account: doc["account"],
  };
}

// ---------------------------------------------------------------------------
// Model visibility
// ---------------------------------------------------------------------------

/**
 * Per-account hidden-model lists. A disabled list, deliberately not an enabled
 * whitelist: a new account and a model the upstream adds both start visible.
 */
export class VisibilityStore {
  private readonly path: string;
  private accounts: Record<string, string[]>;

  constructor(options: { path: string }) {
    this.path = options.path;
    this.accounts = this.load();
  }

  filePath(): string {
    return this.path;
  }

  private load(): Record<string, string[]> {
    const doc = readJsonObject(this.path);
    if (doc === undefined) return {};
    const raw = doc["accounts"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, string[]> = {};
    for (const [account, value] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        out[account] = value.filter((item): item is string => typeof item === "string");
      }
    }
    return out;
  }

  /** The model ids one account has hidden; empty when it never hid any. */
  disabled(account: string): readonly string[] {
    return this.accounts[account] ?? [];
  }

  /**
   * Show or hide one model for one account, persisting before committing.
   * Throws when the write fails, leaving the in-memory state untouched so a
   * re-read cannot lie about what was persisted.
   */
  setVisible(account: string, model: string, visible: boolean): void {
    const current = this.accounts[account] ?? [];
    const next = visible ? current.filter((id) => id !== model) : current.includes(model) ? current : [...current, model];
    const previous = this.accounts;
    // Re-showing the last hidden model removes the entry entirely.
    this.accounts = { ...this.accounts };
    if (next.length === 0) delete this.accounts[account];
    else this.accounts[account] = next;
    try {
      this.persist();
    } catch (error) {
      this.accounts = previous;
      throw error;
    }
  }

  private persist(): void {
    writeJsonAtomic(this.path, { version: 1, accounts: this.accounts });
  }
}

// ---------------------------------------------------------------------------
// Saved catalogs
// ---------------------------------------------------------------------------

/** One saved catalog: the account it belonged to, and the models it listed. */
export interface SavedCatalog {
  /** `uid:enterpriseId` the catalog was fetched for. */
  account: string;
  /** Which document answered, so provenance survives a restart. */
  source: string;
  /** When the fetch succeeded, epoch milliseconds. */
  fetchedAtMs: number;
  models: readonly WorkBuddyUpstreamModel[];
  /** App version used as the UA, when the variant needed one. */
  appVersion?: string;
}

/**
 * The last successful catalog per account. Malformed content reads as
 * "nothing saved": this file is an optimization for the offline and
 * first-seconds cases, and a corrupt one must never stop the extension from
 * serving models.
 */
export class CatalogStore {
  private readonly path: string;
  private entries: Record<string, SavedCatalog>;

  constructor(options: { path: string }) {
    this.path = options.path;
    this.entries = this.load();
  }

  filePath(): string {
    return this.path;
  }

  private load(): Record<string, SavedCatalog> {
    const doc = readJsonObject(this.path);
    if (doc === undefined) return {};
    const raw = doc["entries"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, SavedCatalog> = {};
    for (const [account, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = asSavedCatalog(value);
      if (entry !== undefined) out[account] = entry;
    }
    return out;
  }

  /** The saved catalog for one account, or undefined when there is none. */
  get(account: string): SavedCatalog | undefined {
    return this.entries[account];
  }

  /**
   * Remember a catalog for an account. A failed write is swallowed: the
   * models have already been served, and losing the memory of them is not
   * worth surfacing.
   */
  set(account: string, catalog: Omit<SavedCatalog, "account">): void {
    this.entries = { ...this.entries, [account]: { ...catalog, account } };
    try {
      this.persist();
    } catch {
      /* best-effort */
    }
  }

  /** Forget one account's catalog — used when that account signs out. */
  delete(account: string): void {
    if (!(account in this.entries)) return;
    const previous = this.entries;
    this.entries = { ...this.entries };
    delete this.entries[account];
    try {
      this.persist();
    } catch {
      this.entries = previous;
    }
  }

  private persist(): void {
    writeJsonAtomic(this.path, { version: 1, entries: this.entries });
  }
}

function asSavedCatalog(value: unknown): SavedCatalog | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const doc = value as Record<string, unknown>;
  if (typeof doc["account"] !== "string" || typeof doc["source"] !== "string") return undefined;
  const models = Array.isArray(doc["models"])
    ? (doc["models"] as unknown[]).filter(isUpstreamModel)
    : undefined;
  if (models === undefined) return undefined;
  return {
    account: doc["account"],
    source: doc["source"],
    fetchedAtMs: typeof doc["fetchedAtMs"] === "number" ? doc["fetchedAtMs"] : 0,
    models,
    ...(typeof doc["appVersion"] === "string" ? { appVersion: doc["appVersion"] } : {}),
  };
}

function isUpstreamModel(value: unknown): value is WorkBuddyUpstreamModel {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  return (
    typeof doc["id"] === "string" &&
    typeof doc["name"] === "string" &&
    typeof doc["contextWindow"] === "number" &&
    typeof doc["maxTokens"] === "number" &&
    typeof doc["supportsImages"] === "boolean"
  );
}
