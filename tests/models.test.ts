import { describe, expect, it } from "vitest";
import { decorateName, observedEffortsOf, reasoningFields, toPiModel, SYNTHETIC_BASE_URL } from "../src/models.ts";
import type { ProbeRecord } from "../src/stores.ts";
import { makeReasoning, makeUpstreamModel } from "./helpers.ts";

const validating = (efforts: ProbeRecord["efforts"]): { validation: "validating"; efforts: readonly string[] } => ({
  validation: "validating",
  efforts,
});

describe("reasoningFields", () => {
  it("serves a model without reasoning metadata as non-reasoning", () => {
    expect(reasoningFields(makeUpstreamModel(), undefined, "cn")).toEqual({ reasoning: false });
  });

  it("serves a reasoning model with no declared efforts and no observation as non-reasoning", () => {
    const info = makeUpstreamModel({ reasoning: makeReasoning({ supportedEfforts: undefined }) });
    expect(reasoningFields(info, undefined, "cn")).toEqual({ reasoning: false });
  });

  it("prefers a declared effort set over an observation", () => {
    const info = makeUpstreamModel({
      reasoning: makeReasoning({ supportedEfforts: ["low", "high"] }),
    });
    const fields = reasoningFields(info, { validation: "validating", efforts: ["max"] }, "cn");
    expect(fields.reasoning).toBe(true);
    expect(fields.thinkingLevelMap?.high).toBe("high");
    expect(fields.thinkingLevelMap?.max).toBeNull();
  });

  it("fills an undeclared model from a validating observation", () => {
    const info = makeUpstreamModel({ reasoning: makeReasoning({ supportedEfforts: undefined }) });
    const fields = reasoningFields(info, { validation: "validating", efforts: ["low", "max"] }, "cn");
    expect(fields.reasoning).toBe(true);
    expect(fields.thinkingLevelMap?.low).toBe("low");
    expect(fields.thinkingLevelMap?.max).toBe("max");
    expect(fields.thinkingLevelMap?.medium).toBeNull();
  });

  it("never offers `off` on the CN endpoint for onlyReasoning models", () => {
    const info = makeUpstreamModel({
      reasoning: makeReasoning({ supportedEfforts: ["low", "high"], onlyReasoning: true }),
    });
    expect(reasoningFields(info, undefined, "cn").thinkingLevelMap?.off).toBeNull();
    // The international endpoint has no such veto.
    expect(reasoningFields(info, undefined, "global").thinkingLevelMap?.off).toBe("off");
  });

  it("keeps `off` off without an upstream blessing (canDisableThinking false)", () => {
    const info = makeUpstreamModel({
      reasoning: makeReasoning({ supportedEfforts: ["low"], canDisableThinking: false }),
    });
    expect(reasoningFields(info, undefined, "global").thinkingLevelMap?.off).toBeNull();
  });

  it("never infers `off` from an observation alone", () => {
    const info = makeUpstreamModel({ reasoning: makeReasoning({ supportedEfforts: undefined }) });
    const fields = reasoningFields(info, { validation: "validating", efforts: ["low"] }, "global");
    expect(fields.thinkingLevelMap?.off).toBeNull();
  });

  it("never offers `minimal` — it is absent from the upstream vocabulary", () => {
    const info = makeUpstreamModel({ reasoning: makeReasoning({ supportedEfforts: ["low", "medium"] }) });
    expect(reasoningFields(info, undefined, "cn").thinkingLevelMap?.minimal).toBeNull();
  });
});

describe("observedEffortsOf", () => {
  it("only reports validating observations with at least one effort", () => {
    expect(observedEffortsOf(undefined)).toBeUndefined();
    expect(observedEffortsOf({ fingerprint: "f", validation: "unknown", efforts: [], probedAtMs: 0, pluginVersion: "x", account: "a" })).toBeUndefined();
    expect(observedEffortsOf({ fingerprint: "f", validation: "validating", efforts: [], probedAtMs: 0, pluginVersion: "x", account: "a" })).toBeUndefined();
    const record: ProbeRecord = { fingerprint: "f", validation: "validating", efforts: ["low"], probedAtMs: 0, pluginVersion: "x", account: "a" };
    expect(observedEffortsOf(record)).toEqual(validating(["low"]));
  });
});

describe("decorateName", () => {
  it("appends the normalized credits multiplier", () => {
    expect(decorateName(makeUpstreamModel({ billing: { credits: "x0.79 credits", free: false } }))).toBe("GLM-5.3 · x0.79");
  });

  it("appends promotion badges", () => {
    expect(
      decorateName(makeUpstreamModel({ billing: { credits: "x0.00", free: true, badges: ["限时免费"] } })),
    ).toBe("GLM-5.3 · x0.00 · 限时免费");
  });

  it("reads 价格未知 instead of repeating an expired promotion's rate", () => {
    expect(
      decorateName(makeUpstreamModel({ billing: { credits: "x0.00", free: true, rateUnknown: true } })),
    ).toBe("GLM-5.3 · 价格未知");
  });

  it("keeps the bare name without billing metadata", () => {
    expect(decorateName(makeUpstreamModel())).toBe("GLM-5.3");
  });
});

describe("toPiModel", () => {
  it("maps catalog rows onto pi-ai models", () => {
    const model = toPiModel(makeUpstreamModel({ maxTokens: 4096 }), {
      providerId: "workbuddy",
      region: "cn",
    });
    expect(model.id).toBe("glm-5.3");
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("workbuddy");
    expect(model.baseUrl).toBe(SYNTHETIC_BASE_URL);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(4096);
  });

  it("gates images to models the upstream declares", () => {
    const model = toPiModel(makeUpstreamModel({ supportsImages: false }), { providerId: "workbuddy-ai", region: "global" });
    expect(model.input).toEqual(["text"]);
  });
});
