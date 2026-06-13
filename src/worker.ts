import { createScanApp } from "./app";
import type { Bindings } from "./env";
import { handleRelayBatch } from "./relay";

/**
 * The self-host Worker entrypoint (wrangler.toml → `main`). The public scan core
 * with NO control plane: `POST /v1/scan` runs on bring-your-own model/OCR keys,
 * no database. Plus the relay Queue consumer, active only when a RELAY_QUEUE
 * consumer is configured.
 */
const app = createScanApp();

export default {
  fetch: (request: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  queue: handleRelayBatch,
};
