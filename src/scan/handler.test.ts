import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlaneAdapter } from "../control-plane";

// The BYOK-skip signal fires deep in the scan path (account resolved → paired key
// loaded → model runs). We drive it through a FAKE control-plane adapter (the public
// core's only coupling to a paid backend) plus a mocked `runScan`, so the flag logic
// is exercised deterministically with no provider call and no database.
const loadProviderKey = vi.fn();
const runScan = vi.fn();

vi.mock("./run", () => ({ runScan: (...a: unknown[]) => runScan(...a) }));

const adapter: ControlPlaneAdapter = {
  isConfigured: () => true,
  // Account paired to a provider key; the request pins no model (→ default Anthropic).
  resolveCaller: async () => ({ accountId: "acc1", providerKeyId: "pk1", apiKeyId: "key1" }),
  reserveCredits: async () => true,
  settleScan: async () => null,
  loadProviderKey: (...a: unknown[]) => loadProviderKey(...a),
};

const { createScanApp } = await import("../app");
const app = createScanApp(adapter);

const baseMeta = {
  engine: "vision",
  model: "claude-haiku-4-5",
  ocr_backend: null,
  latency_ms: 1,
  scan_credits: 1,
  total_credits: 3,
};
const envelope = (meta: Record<string, unknown>) => ({
  scan_id: "scn_test",
  status: "ok",
  fields: { total: 10 },
  confidence: {},
  needs_review: [],
  raw_text: "x",
  meta,
});
const post = () =>
  app.request(
    "/v1/scan",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer prl_live_x" },
      body: JSON.stringify({
        schema: ["total"],
        ocr: { backend: "passthrough", text: "Total: 10" },
      }),
    },
    {} as never,
  );

describe("POST /v1/scan — BYOK skip signal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flags provider_mismatch and does NOT inject the key when providers differ + a model ran", async () => {
    loadProviderKey.mockResolvedValue({ key: "sk-openai", provider: "openai" });
    runScan.mockResolvedValue(
      envelope({ ...baseMeta, tokens: { input: 1, output: 1, credits: 2 } }),
    );
    const res = await post();
    expect((await res.json()).meta.byok_skipped).toBe("provider_mismatch");
    // The mismatched key must not have been handed to the model.
    expect((runScan.mock.calls[0][0] as { model_key?: string }).model_key).toBeUndefined();
  });

  it("flags decrypt_failed when the paired key can't be decrypted + a model ran", async () => {
    loadProviderKey.mockResolvedValue(null);
    runScan.mockResolvedValue(
      envelope({ ...baseMeta, tokens: { input: 1, output: 1, credits: 2 } }),
    );
    expect((await (await post()).json()).meta.byok_skipped).toBe("decrypt_failed");
    // Nothing to inject (the key never decrypted), so the model ran on our key.
    expect((runScan.mock.calls[0][0] as { model_key?: string }).model_key).toBeUndefined();
  });

  it("uses the key with no flag when the provider matches the model", async () => {
    loadProviderKey.mockResolvedValue({ key: "sk-ant", provider: "anthropic" });
    runScan.mockResolvedValue(
      envelope({ ...baseMeta, tokens: { input: 1, output: 1, provider_cost_usd: 0.01 } }),
    );
    const res = await post();
    expect((await res.json()).meta.byok_skipped).toBeUndefined();
    expect((runScan.mock.calls[0][0] as { model_key?: string }).model_key).toBe("sk-ant");
  });

  it("does NOT flag a mismatch when no model ran (deterministic scan)", async () => {
    loadProviderKey.mockResolvedValue({ key: "sk-openai", provider: "openai" });
    runScan.mockResolvedValue(envelope(baseMeta)); // no meta.tokens
    expect((await (await post()).json()).meta.byok_skipped).toBeUndefined();
  });
});
