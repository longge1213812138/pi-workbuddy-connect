/**
 * Catalog row → pi-ai `Model` synthesis.
 *
 * This mirrors dsh-workbuddy-connect's `toPiModel`/`reasoningFields`: the
 * upstream's wire effort spellings map directly onto pi thinking levels, the
 * CN endpoint's `onlyReasoning` veto keeps `off` off that region, and the
 * display name carries the billing rate and promotion badges.
 */
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { WorkBuddyEffort, WorkBuddyRegion, WorkBuddyUpstreamModel } from "./core.ts";
import { normalizeCredits } from "./core.ts";
import type { ProbeRecord } from "./stores.ts";

/** The API implementation every WorkBuddy model is served through. */
export const WORKBUDDY_API = "openai-completions";

/**
 * Model `baseUrl`. Never dialed: the fetch adapter intercepts every request,
 * so the URL only has to look plausible to the OpenAI SDK client builder.
 */
export const SYNTHETIC_BASE_URL = "http://workbuddy.internal.invalid/v1";

/** pi-ai model cost is meaningless here — WorkBuddy bills in credits, shown in the name. */
export const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** What a probe observation contributes to capability resolution. */
export interface ObservedEfforts {
  validation: "validating";
  efforts: readonly WorkBuddyEffort[];
}

/** The usable observation for a model, or undefined. */
export function observedEffortsOf(record: ProbeRecord | undefined): ObservedEfforts | undefined {
  if (record === undefined || record.validation !== "validating" || record.efforts.length === 0) return undefined;
  return { validation: "validating", efforts: record.efforts };
}

/**
 * Resolve a WorkBuddy model's reasoning capability into pi-ai's shape.
 *
 * Two sources, strictly ordered: a declared `supportedEfforts` set always
 * wins, so a model that declares its levels is never answered from an
 * observation; an observation only fills in undeclared models. No set at all
 * means the model is served as non-reasoning and uses the upstream default.
 */
export function reasoningFields(
  info: WorkBuddyUpstreamModel,
  observed: ObservedEfforts | undefined,
  region: WorkBuddyRegion,
): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const reasoning = info.reasoning;
  if (reasoning === undefined || reasoning.supports !== true) return { reasoning: false };
  const declared = reasoning.supportedEfforts;
  const declaredSet = declared !== undefined && declared.length > 0;
  const efforts = declaredSet ? declared : observed !== undefined && observed.efforts.length > 0 ? observed.efforts : undefined;
  if (efforts === undefined) return { reasoning: false };
  return {
    reasoning: true,
    thinkingLevelMap: {
      // `off` needs an explicit upstream blessing: disabling thinking is a
      // separate capability, never something an observation may infer. The CN
      // endpoint additionally rejects `off` on `onlyReasoning` models.
      off:
        reasoning.canDisableThinking === true &&
        (region !== "cn" || reasoning.onlyReasoning !== true) &&
        declaredSet
          ? "off"
          : null,
      minimal: null,
      low: efforts.includes("low") ? "low" : null,
      medium: efforts.includes("medium") ? "medium" : null,
      high: efforts.includes("high") ? "high" : null,
      xhigh: efforts.includes("xhigh") ? "xhigh" : null,
      max: efforts.includes("max") ? "max" : null,
    },
  };
}

/**
 * The display name: model name, then the credits multiplier, then promotion
 * badges. A row whose rate was baked into a promotion that has since ended
 * reads "价格未知" rather than repeating a figure the upstream can no longer
 * stand behind — in particular it never keeps claiming the model is free.
 */
export function decorateName(info: WorkBuddyUpstreamModel): string {
  const parts = [info.name];
  const billing = info.billing;
  if (billing !== undefined) {
    if (billing.rateUnknown === true) {
      parts.push("价格未知");
    } else if (billing.credits !== undefined) {
      const bare = normalizeCredits(billing.credits);
      if (bare !== undefined && bare !== "") parts.push(bare);
    }
    for (const badge of billing.badges ?? []) parts.push(badge);
  }
  return parts.join(" · ");
}

/** Convert one live catalog row into a pi-ai chat model. */
export function toPiModel(
  info: WorkBuddyUpstreamModel,
  options: { providerId: string; region: WorkBuddyRegion; observed?: ObservedEfforts | undefined },
): Model<Api> {
  const model: Model<Api> = {
    id: info.id,
    name: decorateName(info),
    api: WORKBUDDY_API,
    provider: options.providerId,
    baseUrl: SYNTHETIC_BASE_URL,
    // Text-only models must never receive an image: over-claiming admits an
    // attachment the upstream then rejects after the message is durable.
    input: info.supportsImages ? ["text", "image"] : ["text"],
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    ...reasoningFields(info, options.observed, options.region),
  };
  return model;
}
