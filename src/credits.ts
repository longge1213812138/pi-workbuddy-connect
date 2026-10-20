/**
 * Credit balance reading and formatting.
 *
 * Credits are never polled: every read is a real billing query, so the status
 * bar reads once when a WorkBuddy model is selected and `/workbuddy balance`
 * re-reads on demand. Enterprise accounts (CN only — the international
 * enterprise endpoint is unverified) read the enterprise cycle quota.
 */
import type { WorkBuddyCredits } from "./core.ts";
import type { VariantRuntime } from "./runtime.ts";

/** Short balance prefix, matching the plugin's picker labels. */
export function balancePrefix(runtime: VariantRuntime): string {
  return runtime.variant.region === "cn" ? "WB" : "WB AI";
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

/** The one-glance total. `unlimited` wins over `total` — the flag means "no limit", not "nothing left". */
export function formatTotal(credits: WorkBuddyCredits): string {
  return credits.unlimited === true ? "∞" : formatNumber(credits.total);
}

/** Read the balance, or a short explanation of why it could not be read. */
export async function readBalance(runtime: VariantRuntime): Promise<{ ok: true; credits: WorkBuddyCredits } | { ok: false; reason: string }> {
  let credential;
  try {
    credential = await runtime.credentials.resolve();
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
  runtime.noteCredential(credential);
  try {
    const credits = await runtime.client.fetchCredits(credential);
    return { ok: true, credits };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

/** Status-bar text for one variant, e.g. `WB · 3,401 积分`. */
export async function readBalanceText(runtime: VariantRuntime): Promise<string> {
  const prefix = balancePrefix(runtime);
  const result = await readBalance(runtime);
  if (!result.ok) return `${prefix} · 积分读取失败`;
  return `${prefix} · ${formatTotal(result.credits)} 积分`;
}

/** Multi-line detail view of one credit answer. */
export function describeCredits(credits: WorkBuddyCredits): string[] {
  const lines = [`${credits.unlimited === true ? "企业额度无上限" : `剩余积分：${formatTotal(credits)}`}`];
  if (credits.cycleResetTime !== undefined) lines.push(`周期重置：${credits.cycleResetTime}`);
  for (const account of credits.accounts) {
    const limit = account.unlimited === true ? "∞" : formatNumber(account.size);
    const end = account.endTimeMs === undefined ? "" : `（至 ${new Date(account.endTimeMs).toLocaleString()}）`;
    lines.push(`  ${account.packageName}：${formatNumber(account.remain)} / ${limit}${end}`);
  }
  const expiry = credits.expiry;
  if (expiry !== undefined) {
    if (expiry.within24h.packages > 0) {
      lines.push(`⚠ ${expiry.within24h.packages} 个套餐的 ${formatNumber(expiry.within24h.total)} 积分将在 24 小时内失效`);
    } else if (expiry.within3d.packages > 0) {
      lines.push(`⚠ ${expiry.within3d.packages} 个套餐的 ${formatNumber(expiry.within3d.total)} 积分将在 3 天内失效`);
    } else if (expiry.within7d.packages > 0) {
      lines.push(`⚠ ${expiry.within7d.packages} 个套餐的 ${formatNumber(expiry.within7d.total)} 积分将在 7 天内失效`);
    }
  }
  return lines;
}
