/**
 * Provider authentication: "attach the desktop app's sign-in".
 *
 * WorkBuddy has no API login — the identity authority is the desktop app's
 * auth file. So this auth is ambient by design: `resolve()` reports the live
 * desktop credential (refreshing the access token on demand through the
 * credential store), and `login()` is an attach flow that verifies the desktop
 * sign-in and stores a *non-secret* marker in pi's `auth.json`. `/logout`
 * removes the marker; the desktop app keeps its sign-in, exactly like the
 * plugin's `logout`.
 */
import type { ApiKeyAuth, ApiKeyCredential, AuthCheck, AuthResult, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { WorkBuddyCredential } from "./core.ts";
import type { VariantRuntime } from "./runtime.ts";

/** Display name shown in `/login`. */
export const AUTH_SOURCE_LABEL = "WorkBuddy 桌面登录";
/** The non-secret key stored in `auth.json` once a desktop sign-in is attached. */
export const AUTH_MARKER_KEY = "workbuddy-desktop";
/** Env field on the stored marker carrying the account identity. */
export const AUTH_ACCOUNT_ENV = "WORKBUDDY_ACCOUNT";

/**
 * The account a stored marker names. The marker is metadata only — the
 * credential itself always comes from the desktop file or our own copy.
 */
export function accountFromStoredCredential(credential: unknown): string | undefined {
  if (typeof credential !== "object" || credential === null) return undefined;
  const env = (credential as { env?: Record<string, unknown> }).env;
  if (typeof env !== "object" || env === null) return undefined;
  const account = env[AUTH_ACCOUNT_ENV];
  return typeof account === "string" && account !== "" ? account : undefined;
}

/** The marker written to `auth.json` for one account. */
export function authMarker(account: string | undefined): ApiKeyCredential {
  return {
    type: "api_key",
    key: AUTH_MARKER_KEY,
    env: account === undefined ? {} : { [AUTH_ACCOUNT_ENV]: account },
  };
}

function reasonText(credential: WorkBuddyCredential | undefined, reason: string | undefined): string {
  if (credential !== undefined) return "";
  return reason ?? "未检测到 WorkBuddy 桌面登录";
}

export function createWorkBuddyAuth(runtime: VariantRuntime): ApiKeyAuth {
  return {
    name: AUTH_SOURCE_LABEL,

    /** Attach flow: verify the desktop sign-in and store a non-secret marker. */
    login: async (interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> => {
      for (let attempt = 0; ; attempt += 1) {
        const status = await runtime.credentials.status();
        const credential = await runtime.credentials.current();
        runtime.noteCredential(credential);
        if (credential !== undefined) {
          interaction.notify({
            type: "info",
            message: `已接入 ${runtime.variant.appName} 登录${status.nickname === undefined ? "" : `（${status.nickname}）`}`,
          });
          return authMarker(accountFromCredential(credential));
        }
        if (attempt >= 1) {
          throw new Error(`${runtime.variant.appName} 桌面登录不可用：${reasonText(credential, status.reason)}`);
        }
        interaction.notify({
          type: "info",
          message: `请先在 ${runtime.variant.appName} 桌面 App 中登录（${reasonText(credential, status.reason)}）`,
        });
        await interaction.prompt({
          type: "text",
          signal: interaction.signal,
          message: `完成登录后按回车重试（回车继续，取消则放弃）`,
          placeholder: "回车继续",
        });
      }
    },

    /** Side-effect-free availability check: a usable desktop credential exists. */
    check: async (): Promise<AuthCheck | undefined> => {
      const credential = await runtime.credentials.current();
      runtime.noteCredential(credential);
      if (credential === undefined) return undefined;
      return { type: "api_key", source: AUTH_SOURCE_LABEL };
    },

    /**
     * Resolve request auth from the live credential. `store.resolve()`
     * refreshes the access token on demand (single-flight) and degrades to a
     * still-valid token when the refresh endpoint is unreachable.
     */
    resolve: async (): Promise<AuthResult | undefined> => {
      let credential: WorkBuddyCredential;
      try {
        credential = await runtime.credentials.resolve();
      } catch {
        runtime.noteCredential(undefined);
        return undefined;
      }
      runtime.noteCredential(credential);
      return {
        auth: { apiKey: credential.accessToken },
        source: AUTH_SOURCE_LABEL,
      };
    },
  };
}

/** The account identity a live credential belongs to, for the auth marker. */
export function accountFromCredential(credential: WorkBuddyCredential): string | undefined {
  if (credential.uid === "") return undefined;
  return `${credential.uid}:${credential.enterpriseId ?? ""}`;
}
