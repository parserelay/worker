import type { RelayMessage } from "./relay";

/**
 * Cloudflare bindings for the scan core — the self-host surface. Everything is
 * optional: the worker falls back to in-memory stubs when a binding is absent, so
 * it runs locally and in tests without real resources. Bring your own model/OCR
 * keys; no database is required.
 *
 * A consumer that adds a control plane (accounts, billing, key storage) extends this
 * interface with its own bindings and injects a `ControlPlaneAdapter`.
 */
export interface Bindings {
  /** Comma-separated API keys the worker accepts. Omit to accept any non-empty key (dev). */
  API_KEYS?: string;
  /** HMAC secret used to sign relay webhook payloads. */
  RELAY_HMAC_SECRET?: string;
  /** Provider keys for the worker's default models (set via `wrangler secret put`). */
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Z.AI key — the preferred (GLM-OCR) OCR backend; powers `auto`. */
  GLM_OCR_API_KEY?: string;
  /** Mistral key — fallback OCR backend (free tier). */
  MISTRAL_API_KEY?: string;
  /** KV set for relay idempotency dedupe. Optional: dedupe is skipped when absent (the queue consumer still delivers). */
  DEDUPE?: KVNamespace;
  /** Queue for async webhook delivery (retries + DLQ). Optional: inline best-effort when absent. */
  RELAY_QUEUE?: Queue<RelayMessage>;
}

/** Hono environment for the scan route: bindings + per-request variables. */
export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    /** The authenticated caller's API key (scan route). */
    apiKey: string;
  };
};
