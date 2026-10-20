/**
 * `/workbuddy` command family — the CLI surface of this package.
 *
 * Covers the plugin's `status` / `doctor` / `logout` CLI plus the operations
 * the DSH settings cards carried: credit balance, catalog refresh, per-account
 * model visibility, reasoning-effort detection, and the context-window
 * preference. Output goes through `ctx.ui.notify`; `--json` emits one
 * machine-readable document for `status` and `doctor`.
 */
import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { desktopAuthCandidatesFor, WORKBUDDY_CONNECT_VERSION, type WorkBuddyCredits } from "./core.ts";
import { describeCredits, readBalance } from "./credits.ts";
import { runProbe } from "./probe.ts";
import type { VariantRuntime } from "./runtime.ts";
import { writeConfig } from "./state.ts";

const SUBCOMMANDS = [
  "status",
  "balance",
  "refresh",
  "doctor",
  "logout",
  "hide",
  "show",
  "probe",
  "max-context",
] as const;

interface ParsedArgs {
  sub: string;
  positional: string[];
  provider?: string;
  json: boolean;
  clear: boolean;
}

export function parseArgs(input: string): ParsedArgs {
  const tokens = input.trim().split(/\s+/).filter((token) => token !== "");
  const sub = tokens.shift() ?? "";
  const positional: string[] = [];
  let provider: string | undefined;
  let json = false;
  let clear = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--json") json = true;
    else if (token === "--clear") clear = true;
    else if (token === "--provider") {
      const value = tokens[i + 1];
      if (value !== undefined) {
        provider = value;
        i += 1;
      }
    } else if (token.startsWith("--provider=")) provider = token.slice("--provider=".length);
    else positional.push(token);
  }
  return { sub, positional, provider, json, clear };
}

export function registerCommands(piExtension: { registerCommand: (name: string, config: { description: string; getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => void }, runtimes: readonly VariantRuntime[]): void {
  piExtension.registerCommand("workbuddy", {
    description: "WorkBuddy / WorkBuddy AI：状态、余额、目录刷新、模型显隐、推理档位检测",
    getArgumentCompletions: (prefix) => {
      const spaceIndex = prefix.lastIndexOf(" ");
      if (spaceIndex >= 0) return null;
      return SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim())).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      const runtime = selectRuntime(runtimes, parsed.provider);
      if (runtime === undefined) {
        notify(ctx.ui, `未知 provider：${parsed.provider}（可用：${runtimes.map((r) => r.variant.id).join(" / ")}）`, "error");
        return;
      }
      try {
        switch (parsed.sub) {
          case "status":
            return await cmdStatus(runtime, parsed, ctx.ui);
          case "balance":
            return await cmdBalance(runtime, ctx.ui);
          case "refresh":
            return await cmdRefresh(runtime, ctx);
          case "doctor":
            return await cmdDoctor(runtime, parsed, ctx.ui);
          case "logout":
            return await cmdLogout(runtime, ctx.ui);
          case "hide":
          case "show":
            return await cmdVisibility(runtime, parsed.sub, parsed, ctx.ui);
          case "probe":
            return await cmdProbe(runtime, parsed, ctx);
          case "max-context":
            return await cmdMaxContext(runtime, parsed, ctx.ui);
          default:
            notify(ctx.ui, HELP, "info");
        }
      } catch (error) {
        notify(ctx.ui, `workbuddy ${parsed.sub} 失败：${String(error)}`, "error");
      }
    },
  });
}

const HELP = [
  "用法：/workbuddy <子命令> [--provider workbuddy|workbuddy-ai]",
  "  status [--json]        登录状态、积分、目录来源",
  "  balance                手动重读积分",
  "  refresh                强制刷新模型目录",
  "  doctor [--json]        环境诊断",
  "  logout                 清理本包自留凭据副本",
  "  hide|show <model>      模型显隐（按账号保存）",
  "  probe <model>|--clear  推理档位检测 / 清空检测记录",
  "  max-context on|off     国际版「使用上游最大上下文窗口」",
].join("\n");

function selectRuntime(runtimes: readonly VariantRuntime[], provider: string | undefined): VariantRuntime | undefined {
  if (provider === undefined) return runtimes[0];
  return runtimes.find((runtime) => runtime.variant.id === provider);
}

function notify(ui: ExtensionUIContext, message: string, type: "info" | "warning" | "error"): void {
  ui.notify(message, type);
}

// --- status ------------------------------------------------------------------

interface StatusDocument {
  provider: string;
  app: string;
  signIn: string;
  reason?: string;
  reasonCode?: string;
  account?: string;
  nickname?: string;
  expiresAt?: number;
  credits?: { total: number | null; unlimited?: boolean; cycleResetTime?: string; packages: number };
  creditsError?: string;
  catalog: { origin: string; source?: string; fetchedAtMs?: number; error?: string; models: number };
  efforts: { declared: number; probed: number; none: number };
  desktopAuth?: { path?: string; present: boolean; format: string };
  stateDir: string;
  coreVersion: string;
}

async function buildStatus(runtime: VariantRuntime): Promise<{ document: StatusDocument; lines: string[]; credits?: WorkBuddyCredits }> {
  const status = await runtime.credentials.status();
  const credential = await runtime.credentials.current();
  runtime.noteCredential(credential);
  const account = runtime.account();

  const balance = await readBalance(runtime);
  const credits = balance.ok ? balance.credits : undefined;

  let declared = 0;
  let probed = 0;
  let none = 0;
  for (const info of runtime.catalog.current()) {
    if (info.reasoning?.supportedEfforts !== undefined && info.reasoning.supportedEfforts.length > 0) declared += 1;
    else if (runtime.observedFor(info.id) !== undefined) probed += 1;
    else if (info.reasoning?.supports === true) none += 1;
  }

  const desktopPath = (await runtime.credentials.resolvedDesktopAuthPath()) ?? runtime.credentials.desktopAuthPath();
  const document: StatusDocument = {
    provider: runtime.variant.id,
    app: runtime.variant.appName,
    signIn: status.state,
    ...(status.reason === undefined ? {} : { reason: status.reason }),
    ...(status.reasonCode === undefined ? {} : { reasonCode: status.reasonCode }),
    ...(account === undefined ? {} : { account }),
    ...(status.nickname === undefined ? {} : { nickname: status.nickname }),
    ...(status.expiresAtMs === undefined ? {} : { expiresAt: status.expiresAtMs }),
    ...(credits === undefined
      ? { creditsError: balance.ok ? "no data" : (balance as { reason: string }).reason }
      : {
          credits: {
            total: credits.unlimited === true ? null : credits.total,
            ...(credits.unlimited === true ? { unlimited: true } : {}),
            ...(credits.cycleResetTime === undefined ? {} : { cycleResetTime: credits.cycleResetTime }),
            packages: credits.accounts.length,
          },
        }),
    catalog: {
      origin: runtime.catalogMeta.origin,
      ...(runtime.catalogMeta.source === undefined ? {} : { source: runtime.catalogMeta.source }),
      ...(runtime.catalogMeta.fetchedAtMs === undefined ? {} : { fetchedAtMs: runtime.catalogMeta.fetchedAtMs }),
      ...(runtime.catalogMeta.error === undefined ? {} : { error: runtime.catalogMeta.error }),
      models: runtime.models().length,
    },
    efforts: { declared, probed, none },
    desktopAuth: {
      ...(desktopPath === undefined ? {} : { path: desktopPath }),
      present: await runtime.credentials.desktopFilePresent(),
      format: await runtime.credentials.desktopAuthFormat(),
    },
    stateDir: runtime.paths.root,
    coreVersion: WORKBUDDY_CONNECT_VERSION,
  };

  const lines = [
    `${runtime.variant.displayName}（${runtime.variant.id}）`,
    `登录：${status.state === "signed-in" ? `已登录${status.nickname === undefined ? "" : ` · ${status.nickname}`}` : `未登录${status.reason === undefined ? "" : ` · ${status.reason}`}`}`,
  ];
  if (account !== undefined) lines.push(`账号：${account}`);
  if (status.expiresAtMs !== undefined) lines.push(`令牌有效期至：${new Date(status.expiresAtMs).toLocaleString()}`);
  if (credits !== undefined) lines.push(...describeCredits(credits));
  else lines.push(`积分读取失败：${document.creditsError}`);
  lines.push(
    `目录：${describeOrigin(runtime.catalogMeta.origin)}${
      runtime.catalogMeta.source === undefined ? "" : `（${runtime.catalogMeta.source}）`
    }${runtime.catalogMeta.fetchedAtMs === undefined ? "" : ` · ${new Date(runtime.catalogMeta.fetchedAtMs).toLocaleString()}`}`,
  );
  if (runtime.catalogMeta.error !== undefined) lines.push(`最近目录错误：${runtime.catalogMeta.error}`);
  lines.push(`模型：${document.catalog.models} 个 · 档位：声明 ${declared} / 探测 ${probed} / 默认 ${none}`);
  return { document, lines, ...(credits === undefined ? {} : { credits }) };
}

function describeOrigin(origin: string): string {
  if (origin === "live") return "实时目录";
  if (origin === "saved") return "已保存目录";
  return "内置兜底目录";
}

async function cmdStatus(runtime: VariantRuntime, parsed: ParsedArgs, ui: ExtensionUIContext): Promise<void> {
  const { document, lines } = await buildStatus(runtime);
  notify(ui, parsed.json ? JSON.stringify(document, null, 2) : lines.join("\n"), "info");
}

async function cmdBalance(runtime: VariantRuntime, ui: ExtensionUIContext): Promise<void> {
  const balance = await readBalance(runtime);
  if (!balance.ok) {
    notify(ui, `积分读取失败：${balance.reason}`, "error");
    return;
  }
  notify(ui, describeCredits(balance.credits).join("\n"), "info");
}

async function cmdRefresh(runtime: VariantRuntime, ctx: ExtensionCommandContext): Promise<void> {
  const result = await ctx.modelRegistry.refresh({ providers: [runtime.variant.id], force: true });
  const error = result.errors.get(runtime.variant.id);
  if (error !== undefined) {
    notify(ctx.ui, `目录刷新失败（沿用现有列表）：${String(error)}`, "warning");
    return;
  }
  notify(
    ctx.ui,
    `目录已刷新：${describeOrigin(runtime.catalogMeta.origin)}${
      runtime.catalogMeta.source === undefined ? "" : `（${runtime.catalogMeta.source}）`
    } · ${runtime.models().length} 个模型`,
    "info",
  );
}

// --- doctor ------------------------------------------------------------------

async function cmdDoctor(runtime: VariantRuntime, parsed: ParsedArgs, ui: ExtensionUIContext): Promise<void> {
  const status = await runtime.credentials.status();
  const desktopPath = (await runtime.credentials.resolvedDesktopAuthPath()) ?? runtime.credentials.desktopAuthPath();
  const desktopFormat = await runtime.credentials.desktopAuthFormat();
  const helperPath = runtime.keyProvider.helperPath();

  let upstream: string;
  try {
    const credential = await runtime.credentials.resolve();
    runtime.noteCredential(credential);
    await runtime.client.fetchModels(credential);
    upstream = `可达（${runtime.client.lastCatalog?.source ?? "live"}）`;
  } catch (error) {
    upstream = `不可达：${String(error)}`;
  }

  const document = {
    provider: runtime.variant.id,
    signIn: status.state,
    ...(status.reasonCode === undefined ? {} : { reasonCode: status.reasonCode }),
    ...(status.reason === undefined ? {} : { reason: status.reason }),
    desktopAuth: {
      candidates: desktopAuthCandidatesFor(runtime.variant),
      resolved: desktopPath ?? null,
      present: await runtime.credentials.desktopFilePresent(),
      format: desktopFormat,
      ownCopy: runtime.credentials.ownAuthPath(),
    },
    electronHelper: helperPath ?? null,
    upstream,
    stateDir: runtime.paths.root,
    coreVersion: WORKBUDDY_CONNECT_VERSION,
  };

  const lines = [
    `${runtime.variant.displayName} 诊断`,
    `登录：${status.state}${status.reason === undefined ? "" : ` · ${status.reason}`}`,
    `桌面凭据文件：${desktopPath ?? "未找到"}（${desktopFormat}${document.desktopAuth.present ? "" : "，不存在"}）`,
    `解密程序：${helperPath ?? `未解析（可用 ${runtime.variant.electron?.envVar ?? "环境变量"} 显式指定）`}`,
    `自留凭据副本：${runtime.credentials.ownAuthPath()}`,
    `上游：${upstream}`,
    `状态目录：${runtime.paths.root}`,
    `核心版本：dsh-workbuddy-connect@${WORKBUDDY_CONNECT_VERSION}（vendored）`,
  ];
  notify(ui, parsed.json ? JSON.stringify(document, null, 2) : lines.join("\n"), status.state === "signed-in" ? "info" : "warning");
}

// --- logout / visibility / probe / prefs -------------------------------------

async function cmdLogout(runtime: VariantRuntime, ui: ExtensionUIContext): Promise<void> {
  await runtime.credentials.logout();
  notify(
    ui,
    [
      "已删除本包自留的凭据副本；桌面 App 的登录不受影响。",
      "若曾通过 /login 接入，请再执行 /logout 移除 auth.json 中的标记。",
    ].join("\n"),
    "info",
  );
}

async function cmdVisibility(
  runtime: VariantRuntime,
  action: "hide" | "show",
  parsed: ParsedArgs,
  ui: ExtensionUIContext,
): Promise<void> {
  const modelId = parsed.positional[0];
  if (modelId === undefined) {
    notify(ui, "用法：/workbuddy hide|show <model-id>", "warning");
    return;
  }
  const credential = await runtime.credentials.current();
  runtime.noteCredential(credential);
  const account = runtime.account();
  if (account === undefined) {
    notify(ui, "无法确定当前账号（缺少 uid 的凭据不支持按账号显隐）", "warning");
    return;
  }
  runtime.visibilityStore.setVisible(account, modelId, action === "show");
  notify(
    ui,
    `${action === "hide" ? "已隐藏" : "已恢复"} ${modelId}（仅影响模型选择器；正在使用该模型的会话不受影响）`,
    "info",
  );
}

async function cmdProbe(runtime: VariantRuntime, parsed: ParsedArgs, ctx: ExtensionCommandContext): Promise<void> {
  if (parsed.clear) {
    runtime.probeStore.clear();
    notify(ctx.ui, "已清空本变体的推理档位检测记录", "info");
    return;
  }
  const modelId = parsed.positional[0];
  if (modelId === undefined) {
    notify(ctx.ui, "用法：/workbuddy probe <model-id>（或 --clear 清空记录）", "warning");
    return;
  }
  const ok = ctx.hasUI
    ? await ctx.ui.confirm(
        "检测推理档位",
        `将向 ${modelId} 发送少量请求以确认 reasoning_effort 档位，可能消耗积分。是否继续？`,
      )
    : false;
  if (!ok) {
    notify(ctx.ui, "已取消检测", "info");
    return;
  }
  const result = await runProbe(runtime, modelId, true);
  if (result.state === "ok") {
    notify(
      ctx.ui,
      [
        `检测完成：${modelId} → ${result.validation}`,
        result.efforts.length > 0 ? `可用档位：${result.efforts.join(" / ")}` : "",
        `请求次数：${result.requests}`,
        "结果仅表示上游当前接受该档位，不承诺一定改变推理效果或积分消耗。",
      ]
        .filter((line) => line !== "")
        .join("\n"),
      "info",
    );
    return;
  }
  notify(ctx.ui, `检测未完成：${result.reason}`, "warning");
}

async function cmdMaxContext(runtime: VariantRuntime, parsed: ParsedArgs, ui: ExtensionUIContext): Promise<void> {
  const value = parsed.positional[0];
  if (value !== "on" && value !== "off") {
    notify(ui, "用法：/workbuddy max-context on|off", "warning");
    return;
  }
  const enabled = value === "on";
  writeConfig(runtime.paths, { useMaximumContextWindowAI: enabled });
  runtime.catalog.setUseMaximumContextWindow(enabled);
  notify(ui, `已${enabled ? "启用" : "停用"}「使用上游声明的最大上下文窗口」（持久化）`, "info");
}

