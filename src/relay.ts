import type { RelayConfig, ScanEnvelope } from "@parserelay/core";
import type { Bindings } from "./env";

/** What we enqueue for async delivery: the exact sync envelope + its relay target. */
export interface RelayMessage {
  envelope: ScanEnvelope;
  relay: RelayConfig;
}

/** HMAC-SHA256 signature header value (`sha256=<hex>`) over the raw payload. */
export async function signPayload(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

/**
 * Deliver the envelope to the caller's webhook.
 *
 * Inline delivery: a best-effort POST, HMAC-signed, carrying the idempotency
 * key. The payload is `JSON.stringify(envelope)` — byte-identical to the sync
 * response (the guardrail). When a RELAY_QUEUE is bound, delivery moves instead
 * onto a Cloudflare Queue with exponential backoff, idempotency-key dedupe, and a
 * dead-letter queue.
 */
export async function deliverRelay(
  env: Bindings,
  relay: RelayConfig,
  envelope: ScanEnvelope,
): Promise<void> {
  const payload = JSON.stringify(envelope);
  const signature = env.RELAY_HMAC_SECRET
    ? await signPayload(env.RELAY_HMAC_SECRET, payload)
    : "unsigned-dev";
  const res = await fetch(relay.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-parserelay-signature": signature,
      "x-parserelay-idempotency-key": relay.idempotency_key,
    },
    body: payload,
    // Don't follow 3xx: a redirect could bounce delivery to an internal address
    // that the URL allowlist (validate.ts) already rejected.
    redirect: "manual",
  });
  // A non-2xx (or an unfollowed 3xx) is a failed delivery: throw so the queue
  // consumer retries / dead-letters instead of silently acking it as delivered.
  if (!res.ok) throw new Error(`relay target returned ${res.status}`);
}

/**
 * Queue consumer: deliver each enqueued envelope, with idempotency-key dedupe so
 * a retried message never double-posts. Retries (exponential backoff) and
 * dead-lettering are handled by the Queue config (max_retries + DLQ) — a thrown
 * delivery just calls `msg.retry()`.
 */
export async function handleRelayBatch(
  batch: MessageBatch<RelayMessage>,
  env: Bindings,
): Promise<void> {
  for (const msg of batch.messages) {
    const { envelope, relay } = msg.body;
    const dedupeKey = `relay:${relay.idempotency_key}`;
    try {
      if (env.DEDUPE && (await env.DEDUPE.get(dedupeKey))) {
        msg.ack(); // already delivered for this key — never double-post
        continue;
      }
      await deliverRelay(env, relay, envelope);
      try {
        await env.DEDUPE?.put(dedupeKey, "1", { expirationTtl: 86_400 });
      } catch (putErr) {
        // Delivery already succeeded — a failed dedupe write must NOT trigger a
        // retry (that would guarantee a double-post). Ack and accept the rare
        // chance this one key goes un-deduped.
        console.warn("dedupe key write failed; acking without dedupe", putErr);
      }
      msg.ack();
    } catch (err) {
      console.error("relay delivery failed; will retry", err, {
        url: relay.url,
        scan_id: envelope.scan_id,
      });
      msg.retry(); // backoff; after max_retries → dead-letter queue
    }
  }
}
