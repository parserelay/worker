import { Hono } from "hono";
import { auth } from "../auth";
import { type ControlPlaneAdapter, NO_CONTROL_PLANE } from "../control-plane";
import type { AppEnv } from "../env";
import { AppError } from "../errors";
import { meterScan } from "../metering";
import { DEFAULT_VISION_MODEL, providerForModel } from "../providers";
import { deliverRelay } from "../relay";
import { runScan } from "./run";
import { validateScanRequest } from "./validate";

/**
 * The `POST /v1/scan` route, parameterized by a control-plane adapter.
 *
 * Self-host (the default `NO_CONTROL_PLANE`): the env-allowlist API key is accepted,
 * the scan runs, usage is metered in memory — no accounts, no credits, no tokens.
 *
 * A consumer that passes a configured adapter gets the full metered path: the
 * credential MUST resolve to a live account, a credit is reserved before any work,
 * the scan optionally runs on the account's BYO provider key, and every scan is
 * settled to the durable store. The adapter is the ONLY coupling — none of that
 * logic lives in this core.
 */
export function createScanRoute(adapter: ControlPlaneAdapter = NO_CONTROL_PLANE): Hono<AppEnv> {
  const scanRoute = new Hono<AppEnv>();

  scanRoute.post("/scan", auth, async (c) => {
    const env = c.env ?? {};

    // Resolve the caller to an account when a control plane is wired for this env.
    // The `auth` middleware's env allowlist is the self-host fallback; with the
    // control plane configured the credential MUST map to a live, non-revoked
    // account — otherwise it's a 401, not a free scan. (The adapter resolves an API
    // key OR a single-use scan token.)
    const controlPlane = adapter.isConfigured(env);
    const account = controlPlane ? await adapter.resolveCaller(env, c.get("apiKey")) : null;
    if (controlPlane && !account) {
      throw new AppError("unauthorized", "Invalid API key or scan token.");
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError("bad_request", "Request body must be valid JSON.");
    }

    const req = validateScanRequest(body);

    // Credit gate. Atomically RESERVE a hold BEFORE doing any work — pay-per-scan
    // with no overdraft, no TOCTOU. One credit per page (multi-page = req.image +
    // req.pages). settleScan/settleDryRun reconciles the hold after the run.
    //
    // A dry run is gated too: it runs OCR for real (on our key) to compute
    // would_rescue, so it has a real cost — an ungated dry run is a free way to burn
    // our OCR budget. It bills only the OCR it consumes (settleDryRun refunds the
    // rest of the hold), never the plumbing or model.
    const held = 1 + (req.pages?.length ?? 0);
    if (account) {
      const reserved = await adapter.reserveCredits(env, account.accountId, held);
      // A DB error is a 500, NOT a false "out of credits" — don't tell a funded
      // account to top up because of a momentary blip.
      if (reserved === "error") throw new AppError("internal", "Could not reserve credits.");
      if (!reserved) {
        throw new AppError("payment_required", "Out of credits. Top up to keep scanning.");
      }
    }

    // BYOK: if this account is paired to a stored provider key, run the model on it
    // (decrypted Worker-side). An explicit `model_key` in the request wins — it's a
    // deliberate per-call override; the stored pairing is the account default.
    let scanReq = req;
    let byokSkipped: "provider_mismatch" | "decrypt_failed" | undefined;
    if (account?.providerKeyId && !req.model_key) {
      const byo = await adapter.loadProviderKey(env, account.providerKeyId, account.accountId);
      const model = req.model ?? DEFAULT_VISION_MODEL;
      if (byo && byo.provider === providerForModel(model)) {
        scanReq = { ...req, model_key: byo.key };
      } else if (byo) {
        byokSkipped = "provider_mismatch";
        // Paired and decrypted, but the key's provider doesn't match the model that
        // will run (e.g. an OpenAI key with the default Anthropic model). Injecting
        // it would call the wrong provider with the wrong key — fall back to credits
        // and surface the mismatch so the account holder can fix the pairing/model.
        console.warn("BYOK skipped: provider key does not match the model's provider", {
          account_id: account.accountId,
          provider_key_id: account.providerKeyId,
          key_provider: byo.provider,
          model,
        });
      } else {
        // Paired but we couldn't decrypt it (rotated/missing PROVIDER_KEY_ENC_KEY,
        // tampered ciphertext, or it was deleted between resolve and load). Fall back
        // to platform credits so the scan still runs — but that silently spends the
        // balance BYOK was meant to spare, so surface it rather than swallow it.
        byokSkipped = "decrypt_failed";
        console.warn("BYOK fallback: paired provider key could not be decrypted", {
          account_id: account.accountId,
          provider_key_id: account.providerKeyId,
        });
      }
    }

    const result = await runScan(scanReq, { preview: scanReq.dry_run === true, env });

    // dry_run takes precedence over relay: always inline, nothing posted.
    if (result.status === "dry_run") {
      // Reconcile the hold: charge the OCR the dry run actually ran, refund the rest.
      // Best-effort (like settleScan) — the preview still returns even if the write
      // hiccups; we log it. settleDryRun is idempotent on scan_id.
      if (account) {
        const err = await adapter.settleDryRun(env, account.accountId, {
          scanId: result.scan_id,
          held,
          credits: result.ocr_credits ?? 0,
        });
        if (err) console.error("dry run settle failed", err, { scan_id: result.scan_id });
      }
      return c.json(result, 200);
    }

    // Surface a skipped BYOK only when a model actually ran (meta.tokens present) —
    // i.e. the caller paid model credits their own key was meant to cover. For a
    // deterministic (no-model) scan the paired key was never needed, so don't flag.
    // Intentionally NOT gated on status: a failed scan that still ran the model on
    // our key is exactly where the caller most wants to know BYOK didn't apply.
    if (byokSkipped && result.meta.tokens) {
      result.meta.byok_skipped = byokSkipped;
    }

    // Settle usage. With an account, settle every completed (non-dry-run) scan —
    // including failures — recording history and reconciling the gate's hold
    // (`settle_scan` refunds it on a failed scan, so a failure burns nothing).
    // Best-effort: a completed scan still returns its envelope even if the write
    // hiccups — we log it rather than discard a valid result. Without an account
    // (self-host/test), fall back to the in-memory success counter.
    if (account) {
      const err = await adapter.settleScan(env, account.accountId, {
        scanId: result.scan_id,
        docType: req.doc_type ?? "freeform",
        engine: result.meta.engine,
        status: result.status,
        credits: result.meta.total_credits,
        fields: Object.keys(result.fields).length,
      });
      if (err) console.error("scan settle failed", err, { scan_id: result.scan_id });
    } else if (result.status !== "failed") {
      meterScan(c.get("apiKey"));
    }

    if (req.relay) {
      // Fire-and-forget: the full envelope (byte-identical) is delivered async.
      const { relay } = req;
      const { scan_id } = result;
      if (env.RELAY_QUEUE) {
        // Reliable path: the Queue handles retries/backoff + dead-lettering, and
        // the consumer dedupes by idempotency key + signs (relay.ts).
        await env.RELAY_QUEUE.send({ envelope: result, relay });
      } else {
        // Fallback: best-effort inline delivery (signed, byte-identical, no retries).
        const deliver = deliverRelay(env, relay, result).catch((err) => {
          console.error("relay delivery failed", err, { url: relay.url, scan_id });
        });
        try {
          c.executionCtx.waitUntil(deliver);
        } catch {
          void deliver; // no execution context (unit tests): fire-and-forget
        }
      }
      return c.json({ scan_id, status: "accepted" }, 202);
    }

    return c.json(result, 200);
  });

  return scanRoute;
}
