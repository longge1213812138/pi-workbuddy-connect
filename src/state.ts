/**
 * State root and durable JSON helpers.
 *
 * Everything this package persists lives under `~/.pi/agent/workbuddy/` (or
 * `$PI_CODING_AGENT_DIR/workbuddy/`), one file set per WorkBuddy variant.
 * Files are written atomically with mode `0o600`, and every read is forgiving:
 * a missing or malformed document reads as "nothing saved" rather than
 * throwing, because a corrupt state file must never be able to stop the
 * extension from serving models.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** pi's agent directory (mirrors `getAgentDir()` in @earendil-works/pi-coding-agent). */
export function agentDir(): string {
  const envDir = process.env["PI_CODING_AGENT_DIR"];
  if (envDir !== undefined && envDir !== "") {
    return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
  }
  return join(homedir(), ".pi", "agent");
}

/** This package's state directory. */
export function stateRoot(): string {
  return join(agentDir(), "workbuddy");
}

/** Per-variant state file names under the state root. */
export function statePaths(root: string, variantId: string) {
  return {
    root,
    auth: join(root, `auth-${variantId}.json`),
    catalog: join(root, `catalog-${variantId}.json`),
    probe: join(root, `probe-${variantId}.json`),
    visibility: join(root, `visibility-${variantId}.json`),
    config: join(root, "config.json"),
    appVersionCn: join(root, `app-version-cn.json`),
    appVersionAi: join(root, `app-version-ai.json`),
  };
}

export type StatePaths = ReturnType<typeof statePaths>;

/** Read and parse a JSON document; missing/malformed content reads as undefined. */
export function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Read a JSON document as an object; anything else reads as undefined. */
export function readJsonObject(path: string): Record<string, unknown> | undefined {
  const parsed = readJson(path);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * Write a JSON document through a temporary sibling and rename, so a crash
 * mid-write cannot leave a half-parsed file. Mode `0o600`: state may name
 * accounts and models, and none of it is for other users.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const payload = JSON.stringify(value, null, 2);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, payload, { mode: 0o600 });
  renameSync(tmp, path);
}

// --- config ----------------------------------------------------------------

export interface WorkBuddyConfig {
  /** Use the largest declared context window on the international catalog. */
  useMaximumContextWindowAI: boolean;
}

export const DEFAULT_CONFIG: WorkBuddyConfig = {
  useMaximumContextWindowAI: true,
};

/** Read the package config; missing/malformed reads as the defaults. */
export function readConfig(paths: StatePaths): WorkBuddyConfig {
  const doc = readJsonObject(paths.config);
  if (doc === undefined) return { ...DEFAULT_CONFIG };
  return {
    useMaximumContextWindowAI:
      typeof doc["useMaximumContextWindowAI"] === "boolean"
        ? (doc["useMaximumContextWindowAI"] as boolean)
        : DEFAULT_CONFIG.useMaximumContextWindowAI,
  };
}

/** Persist one config field. Throws when the write fails so the caller can report it. */
export function writeConfig(paths: StatePaths, patch: Partial<WorkBuddyConfig>): WorkBuddyConfig {
  const next = { ...readConfig(paths), ...patch };
  writeJsonAtomic(paths.config, { version: 1, ...next });
  return next;
}
