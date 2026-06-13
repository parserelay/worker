import type { ScanRequest } from "@parserelay/core";
import { parseScanRequest } from "@parserelay/core/schema";
import { AppError } from "../errors";
import { assertSafeRelayUrl } from "./relay-url";

/**
 * Validate an untrusted request body into a `ScanRequest`, or throw AppError.
 *
 * Shape validation is delegated to the canonical `ScanRequestSchema` in
 * `@parserelay/core/schema` — one definition, shared. The SSRF guard
 * on `relay.url` stays here: it's deployment policy (which hosts may be called),
 * not request shape, so it doesn't belong in the portable contract schema.
 */
export function validateScanRequest(body: unknown): ScanRequest {
  const r = parseScanRequest(body);
  if (!r.ok) throw new AppError("bad_request", r.message);
  if (r.data.relay) assertSafeRelayUrl(r.data.relay.url.trim());
  // Runtime-validated above; the cast bridges the loose-JsonSchema type gap
  // (the schema validates `schema` as unknown — see the module note there).
  return r.data as ScanRequest;
}
