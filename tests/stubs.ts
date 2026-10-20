/** Structural stand-ins for pi host types, so tests do not load the host package. */
import type { Api, Model, Provider as PiProvider } from "@earendil-works/pi-ai";

export type Provider = PiProvider;

export interface ExtensionAPI {
  registerProvider(provider: Provider): void;
  registerCommand(name: string, config: unknown): void;
  on(event: string, handler: unknown): () => void;
}

export type { Api, Model };
