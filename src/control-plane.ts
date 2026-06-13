import type { Bindings } from "./env";

/**
 * The control-plane seam.
 *
 * The scan core runs standalone (self-host): bring your own model/OCR keys, no
 * database, no accounts, no billing. A consumer that wants metered accounts, BYO-key
 * pairing, credit gating and single-use scan tokens implements a `ControlPlaneAdapter`
 * and passes it in — reusing this exact pipeline without any of that logic living in
 * the core.
 *
 * When `isConfigured(env)` is false (the self-host default, or any env where the
 * control plane's secrets aren't set), the scan handler never calls another adapter
 * method: it accepts the env-allowlist API key, runs the scan, and meters in memory.
 * When it's true the handler resolves the caller to an account, reserves a credit
 * before work, optionally runs on the account's BYO key, and settles each scan to the
 * durable store. It's a per-env predicate (not a static flag), so a single deployment
 * degrades to self-host behavior wherever the control plane is absent.
 */

/** The account context a scan runs under, resolved from an API key or a scan token. */
export interface ScanCaller {
  accountId: string;
  /** Paired BYO provider key id, or null → run on platform credits. */
  providerKeyId: string | null;
  apiKeyId: string;
}

/** Metadata recorded for one completed scan (history + credit reconciliation). */
export interface ScanSettlement {
  scanId: string;
  docType: string;
  engine: string;
  status: string;
  /** total_credits the scan cost (0 on a failed scan → the hold is refunded). */
  credits: number;
  fields: number;
}

/** A decrypted BYO provider key + which provider it's for (aligned with the model before use). */
export interface ProviderKey {
  key: string;
  provider: string;
}

/**
 * A settlement failure. `settleScan` is best-effort — a completed scan returns its
 * envelope even if the write hiccups — so this is for the handler to log, not throw.
 * A clean, backend-agnostic shape (not e.g. a specific backend's error type) so the published
 * adapter contract stays decoupled from any control-plane implementation.
 */
export interface SettleError {
  message: string;
}

export interface ControlPlaneAdapter {
  /** Per-request: is the control plane wired for this env? false → self-host path
   *  (no account resolution, no credit gate, in-memory metering). */
  isConfigured(env: Bindings): boolean;
  /** Resolve a presented credential (API key OR single-use scan token) to its account, or null if invalid. */
  resolveCaller(env: Bindings, presented: string): Promise<ScanCaller | null>;
  /** Atomically reserve `amount` credits (the gate). true = reserved, false = short (→402), "error" = DB blip (→500). */
  reserveCredits(env: Bindings, accountId: string, amount: number): Promise<boolean | "error">;
  /** Record a completed scan + reconcile the reserved hold. Returns a SettleError (logged) on failure, else null. */
  settleScan(env: Bindings, accountId: string, usage: ScanSettlement): Promise<SettleError | null>;
  /** Decrypt the BYO provider key paired to this account, or null → fall back to credits. */
  loadProviderKey(
    env: Bindings,
    providerKeyId: string,
    accountId: string,
  ): Promise<ProviderKey | null>;
}

/** The self-host default: no control plane. Methods are inert no-ops (never called while `isConfigured` is false). */
export const NO_CONTROL_PLANE: ControlPlaneAdapter = {
  isConfigured: () => false,
  resolveCaller: async () => null,
  reserveCredits: async () => true,
  settleScan: async () => null,
  loadProviderKey: async () => null,
};
