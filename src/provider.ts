/**
 * The native provider: one complete pi-ai `Provider` per WorkBuddy variant.
 *
 * This module must not import a *value* from `@earendil-works/pi-ai`. Pi does
 * not install dependencies for git-sourced packages, and shipping a physical
 * copy of a host-provided module would bypass Pi's module mapping. Type-only
 * imports are erased at runtime, so the provider is safely structural: it
 * satisfies the `Provider` interface while its streaming comes from the local
 * zero-dependency implementation in `stream.ts`.
 */
import type {
  Api,
  ApiStreamOptions,
  AssistantMessageEventStream,
  Credential,
  Model,
  Provider,
  RefreshModelsContext,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createWorkBuddyAuth } from "./auth.ts";
import { filterByVisibility, refreshCatalog } from "./catalog.ts";
import { createWorkBuddyFetch } from "./fetch-adapter.ts";
import type { VariantRuntime } from "./runtime.ts";
import { streamOpenAiCompletions, type AssistantEventStream, type ModelInfo, type StreamOptions } from "./stream.ts";

type AnyModel = Model<Api>;
type AnyContext = TranscriptContext;

export function createWorkBuddyProvider(runtime: VariantRuntime): Provider {
  const workbuddyFetch = createWorkBuddyFetch({
    store: runtime.credentials,
    client: runtime.client,
    onCredential: (credential) => runtime.noteCredential(credential),
  });

  function stream(model: AnyModel, context: AnyContext, options?: ApiStreamOptions<Api>): AssistantMessageEventStream {
    return streamFor(model, context, options) as unknown as AssistantMessageEventStream;
  }

  function streamSimple(
    model: AnyModel,
    context: AnyContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    return streamFor(model, context, options) as unknown as AssistantMessageEventStream;
  }

  /**
   * One implementation for both entry points: Pi normalizes the transcript
   * before dispatching, so `stream` and `streamSimple` differ only in which
   * optional knobs they received.
   */
  function streamFor(model: AnyModel, context: AnyContext, options?: unknown): AssistantEventStream {
    const messages = (context as unknown as { messages: readonly unknown[] }).messages;
    const forwarded = (options ?? {}) as unknown as StreamOptions;
    return streamOpenAiCompletions(
      model as unknown as ModelInfo,
      messages as never,
      { ...forwarded, fetch: workbuddyFetch, apiKey: undefined },
      runtime.variant.id,
    );
  }


  return {
    id: runtime.variant.id,
    name: runtime.variant.displayName,
    auth: { apiKey: createWorkBuddyAuth(runtime) },
    /** The complete synchronous catalog; credential gating lives in `filterModels`. */
    getModels: () => runtime.models() as readonly AnyModel[],
    refreshModels: (context: RefreshModelsContext): Promise<void> => refreshCatalog(runtime, context),
    filterModels: (models: readonly AnyModel[], credential: Credential | undefined) =>
      filterByVisibility(runtime, models, credential),
    stream,
    streamSimple,
  };
}
