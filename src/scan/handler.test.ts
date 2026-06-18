import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlaneAdapter } from "../control-plane";

// The BYOK-skip signal fires deep in the scan path (account resolved → paired key
// loaded → model runs). We drive it through a FAKE control-plane adapter (the public
// core's only coupling to a paid backend) plus a mocked `runScan`, so the flag logic
// is exercised deterministically with no provider call and no database.
const loadProviderKey = vi.fn();
const runScan = vi.fn();
const reserveCredits = vi.fn(async () => true as boolean | "error");
const settleDryRun = vi.fn(async () => null);

vi.mock("./run", () => ({ runScan: (...a: unknown[]) => runScan(...a) }));

const adapter: ControlPlaneAdapter = {
  isConfigured: () => true,
  // Account paired to a provider key; the request pins no model (→ default Anthropic).
  resolveCaller: async () => ({ accountId: "acc1", providerKeyId: "pk1", apiKeyId: "key1" }),
  reserveCredits: (...a: unknown[]) => reserveCredits(...(a as [])),
  settleScan: async () => null,
  settleDryRun: (...a: unknown[]) => settleDryRun(...(a as [])),
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

describe("POST /v1/scan — dry run billing (#114)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveCredits.mockResolvedValue(true);
    loadProviderKey.mockResolvedValue(null);
  });

  const dryRun = (extra: Record<string, unknown>) => ({
    scan_id: "scn_dry",
    status: "dry_run",
    would_rescue: [],
    scan_credits: 1,
    ...extra,
  });
  const dryPost = (pages?: string[]) =>
    app.request(
      "/v1/scan",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer prl_live_x" },
        body: JSON.stringify({
          schema: ["total"],
          image: "data:image/png;base64,AAAA",
          dry_run: true,
          ...(pages ? { pages } : {}),
        }),
      },
      {} as never,
    );

  it("gates the dry run: reserves a hold before running, 402 when out of credits", async () => {
    reserveCredits.mockResolvedValueOnce(false); // out of credits
    const res = await dryPost();
    expect(res.status).toBe(402);
    // The gate fires BEFORE the work — an ungated dry run could burn our OCR for free.
    expect(reserveCredits).toHaveBeenCalledWith(expect.anything(), "acc1", 1);
    expect(runScan).not.toHaveBeenCalled();
    expect(settleDryRun).not.toHaveBeenCalled();
  });

  it("settles the real OCR credits and refunds the rest of the hold", async () => {
    runScan.mockResolvedValue(dryRun({ ocr_credits: 0.11 }));
    const res = await dryPost();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "dry_run", ocr_credits: 0.11 });
    expect(settleDryRun).toHaveBeenCalledWith(expect.anything(), "acc1", {
      scanId: "scn_dry",
      held: 1,
      credits: 0.11,
    });
  });

  it("settles 0 credits when no OCR ran (passthrough / failed OCR)", async () => {
    runScan.mockResolvedValue(dryRun({})); // no ocr_credits on the result
    await dryPost();
    expect(settleDryRun).toHaveBeenCalledWith(expect.anything(), "acc1", {
      scanId: "scn_dry",
      held: 1,
      credits: 0,
    });
  });

  it("holds one credit per page: a 3-page dry run reserves 3", async () => {
    runScan.mockResolvedValue(dryRun({ ocr_credits: 0.3 }));
    await dryPost(["data:image/png;base64,BBBB", "data:image/png;base64,CCCC"]);
    expect(reserveCredits).toHaveBeenCalledWith(expect.anything(), "acc1", 3);
    expect(settleDryRun).toHaveBeenCalledWith(expect.anything(), "acc1", {
      scanId: "scn_dry",
      held: 3,
      credits: 0.3,
    });
  });
});
