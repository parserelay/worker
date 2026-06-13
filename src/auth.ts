import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./env";
import { AppError } from "./errors";

/** Parse an `Authorization: Bearer <token>` header → the token, or null if absent/malformed.
 *  `|| null` collapses an all-whitespace token (e.g. "Bearer  ") to null, so the
 *  return contract is honestly `string | null` (never ""). */
export function extractBearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return (match ? match[1].trim() : "") || null;
}

/** Constant-time string equality, to avoid leaking the key via comparison timing.
 *  Runs the full XOR over max(len) so a length mismatch doesn't short-circuit
 *  (out-of-range charCodeAt is NaN; `|| 0` folds it to 0). */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * API-key auth. Expects `Authorization: Bearer <key>`.
 *
 * Self-host policy: if `API_KEYS` is configured, the key must be a member;
 * otherwise any non-empty key is accepted (local/dev). A consumer with a control
 * plane swaps this for a hashed key store via the `ControlPlaneAdapter`.
 */
export const auth = createMiddleware<AppEnv>(async (c, next) => {
  const key = extractBearerToken(c.req.header("authorization"));
  if (!key) {
    throw new AppError(
      "unauthorized",
      "Missing or malformed Authorization header. Use 'Authorization: Bearer <api_key>'.",
    );
  }

  const allowed = (c.env?.API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  // Constant-time membership check. A consumer with a control plane replaces this
  // plaintext allowlist with its own hashed key store looked up by hash; this env
  // allowlist remains the self-host / dev fallback.
  if (allowed.length > 0 && !allowed.some((k) => timingSafeEqual(k, key))) {
    throw new AppError("unauthorized", "Invalid API key.");
  }

  c.set("apiKey", key);
  await next();
});
