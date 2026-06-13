import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type ControlPlaneAdapter, NO_CONTROL_PLANE } from "./control-plane";
import type { AppEnv } from "./env";
import { AppError, type ErrorBody } from "./errors";
import { createScanRoute } from "./scan/handler";

/**
 * Build a complete scan worker app: `/health`, `POST /v1/scan`, and the standard
 * error envelope. With no argument it's the zero-database self-host worker (env
 * allowlist auth, no accounts, no billing). Pass a `ControlPlaneAdapter` to add
 * metered accounts, BYO-key pairing, credits and scan tokens, then mount your own
 * routes on the returned app.
 */
export function createScanApp(adapter: ControlPlaneAdapter = NO_CONTROL_PLANE): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/v1", createScanRoute(adapter));

  app.notFound((c) =>
    c.json<ErrorBody>({ error: { code: "not_found", message: "Not found." } }, 404),
  );
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json<ErrorBody>(err.toBody(), err.status as ContentfulStatusCode);
    }
    console.error("Unhandled error:", err);
    return c.json<ErrorBody>({ error: { code: "internal", message: "Internal error." } }, 500);
  });

  return app;
}
