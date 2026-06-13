/**
 * `@parserelay/worker` — the public, self-hostable ParseRelay scan core.
 *
 * Two ways to use it:
 *   1. Deploy as-is (see wrangler.toml / src/worker.ts) — a complete scan worker.
 *   2. Import as a library and compose: build a richer worker around the scan
 *      pipeline by passing a `ControlPlaneAdapter` to `createScanApp` (or mounting
 *      `createScanRoute` onto your own Hono app), then add your own routes — e.g. to
 *      layer accounts, credits, or billing on top of the core.
 */

// Composition entry points
export { createScanApp } from "./app";
export { createScanRoute } from "./scan/handler";

// The control-plane seam
export {
  type ControlPlaneAdapter,
  type ScanCaller,
  type ScanSettlement,
  type ProviderKey,
  type SettleError,
  NO_CONTROL_PLANE,
} from "./control-plane";

// Reusable pieces (for a consumer worker that wires its own app)
export { auth, extractBearerToken } from "./auth";
export { AppError, type ErrorBody, type ErrorCode } from "./errors";
export type { AppEnv, Bindings } from "./env";
export { runScan, type RunResult } from "./scan/run";
export { validateScanRequest } from "./scan/validate";
export {
  handleRelayBatch,
  deliverRelay,
  signPayload,
  type RelayMessage,
} from "./relay";
export {
  DEFAULT_VISION_MODEL,
  providerForModel,
  resolveOcr,
  resolveProvider,
} from "./providers";
