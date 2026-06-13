import type { RelayConfig, ScanEnvelope } from "@parserelay/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "./env";
import { type RelayMessage, handleRelayBatch } from "./relay";

const envelope = {
  scan_id: "scn_x",
  status: "ok",
  fields: {},
  confidence: {},
  needs_review: [],
  raw_text: "",
  meta: {
    engine: "ocr+rescue",
    model: null,
    ocr_backend: "mistral",
    latency_ms: 1,
    scan_credits: 1,
    total_credits: 1,
  },
} as ScanEnvelope;
const relay: RelayConfig = { url: "https://hook.example/x", idempotency_key: "idem-9" };

function batchOf(message: RelayMessage) {
  const msg = { body: message, ack: vi.fn(), retry: vi.fn() };
  return { batch: { messages: [msg] } as unknown as MessageBatch<RelayMessage>, msg };
}

afterEach(() => vi.restoreAllMocks());

describe("handleRelayBatch", () => {
  it("delivers, records the dedupe key, and acks", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const kv = { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) };
    const { batch, msg } = batchOf({ envelope, relay });

    await handleRelayBatch(batch, { DEDUPE: kv } as unknown as Bindings);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(relay.url);
    expect(kv.put).toHaveBeenCalledWith("relay:idem-9", "1", { expirationTtl: 86400 });
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("acks without re-delivering when the idempotency key was already seen", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const kv = { get: vi.fn().mockResolvedValue("1"), put: vi.fn() };
    const { batch, msg } = batchOf({ envelope, relay });

    await handleRelayBatch(batch, { DEDUPE: kv } as unknown as Bindings);

    expect(spy).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it("retries (does not ack) when delivery fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const { batch, msg } = batchOf({ envelope, relay });

    await handleRelayBatch(batch, {} as Bindings);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("retries when the webhook returns a non-2xx status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const { batch, msg } = batchOf({ envelope, relay });

    await handleRelayBatch(batch, {} as Bindings);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });
});
