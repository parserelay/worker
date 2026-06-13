import type {
  ConfidenceMap,
  DryRunFlag,
  FieldSourceMap,
  OcrUsage,
  ScanDryRun,
  ScanEnvelope,
  ScanMeta,
  ScanRequest,
  ScanStatus,
  TokenUsage,
} from "@parserelay/core";
import type { Bindings } from "../env";
import {
  DEFAULT_VISION_MODEL,
  type OcrProvider,
  type Provider,
  type Usage,
  resolveOcr as defaultResolveOcr,
  resolveProvider as defaultResolveProvider,
} from "../providers";
import { getEngine, resolveEngineName } from "./engines";
import { toFieldSpecs } from "./schema";

export type RunResult = ScanEnvelope | ScanDryRun;

/** Resolves an LLM provider for a model + optional BYO key. Injectable for tests. */
export type ResolveProviderFn = (
  model: string,
  modelKey: string | null,
  env: Bindings,
) => Promise<{ provider: Provider | null; error?: string }>;

/** Resolves an OCR backend. Injectable for tests. */
export type ResolveOcrFn = (
  backend: string,
  env: Bindings,
) => Promise<{ ocr: OcrProvider | null; error?: string }>;

// Credit pricing. Plumbing is 1 credit/scan (the always-present charge). Model
// usage converts to credits via the token→credit map: loaded cost ÷ credit value.
const CREDIT_USD = 0.002; // 1 credit = $0.002 (advertised plumbing rate)
const MODEL_TAX_MULT = 1.15; // provider sticker → our loaded cost (tax / fees)
const ESTIMATED_CALL_CREDITS = 3; // rough per-model-call estimate for dry runs

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function newScanId(): string {
  return `scn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

interface RunOpts {
  preview: boolean;
  env: Bindings;
  resolveProvider?: ResolveProviderFn;
  resolveOcr?: ResolveOcrFn;
}

/**
 * Run a scan. A single page runs the pipeline directly. A multi-page document
 * (`req.pages` set — caller-rendered page images) runs each page independently —
 * so each page's rescue reads its OWN image — then merges the per-page results
 * into one envelope (best value per field wins; credits/usage sum). The Worker
 * never renders PDFs; the caller supplies one image per page.
 */
export async function runScan(req: ScanRequest, opts: RunOpts): Promise<RunResult> {
  const extra = req.pages ?? [];
  if (extra.length === 0) return runOnePage(req, opts);

  const started = Date.now();
  const scanId = newScanId();
  const results = await Promise.all(
    [req.image, ...extra].map((image) => runOnePage({ ...req, image, pages: undefined }, opts)),
  );
  return opts.preview
    ? mergeDryRuns(results as ScanDryRun[], scanId)
    : mergeEnvelopes(results as ScanEnvelope[], scanId, started);
}

async function runOnePage(req: ScanRequest, opts: RunOpts): Promise<RunResult> {
  const started = Date.now();
  const scanId = newScanId();
  const specs = toFieldSpecs(req.schema);
  const docType = req.doc_type ?? "freeform";

  const backend = req.ocr?.backend ?? "auto";

  // 1. Get text. Passthrough supplies it; otherwise OCR the image (Mistral),
  //    unless the caller explicitly chose `vision` (which reads the image direct).
  let text: string | null = backend === "passthrough" ? (req.ocr?.text ?? null) : null;
  let ocrError: string | undefined;
  let ocrProviderId: string | null = null;
  let ocrUsage: Usage | undefined;
  let ocrUsd = 0;
  if (text === null && req.engine !== "vision" && req.image) {
    const resolveOcr = opts.resolveOcr ?? defaultResolveOcr;
    const { ocr, error } = await resolveOcr(backend, opts.env);
    if (ocr) {
      ocrProviderId = ocr.id;
      try {
        const r = await ocr.ocr(req.image);
        text = r.text || null;
        ocrUsage = r.usage;
        ocrUsd = r.costUsd ?? 0;
      } catch (e) {
        ocrError = e instanceof Error ? e.message : "OCR failed";
      }
    } else {
      ocrError = error;
    }
  }
  const hasText = text !== null && text.trim().length > 0;

  // OCR-first `auto`: a usable text layer → ocr+rescue, else vision.
  const engineName = resolveEngineName(req.engine, hasText);

  // 2. Resolve the LLM provider for engines that call a model (vision, and the
  //    ocr+rescue rescue pass). BYO `model_key` overrides the server key.
  let provider: Provider | null = null;
  let providerError: string | undefined;
  if (engineName === "vision" || engineName === "ocr+rescue" || engineName === "ocr+check") {
    const model = req.model ?? DEFAULT_VISION_MODEL;
    const resolve = opts.resolveProvider ?? defaultResolveProvider;
    const r = await resolve(model, req.model_key ?? null, opts.env);
    provider = r.provider;
    providerError = r.error;
  }

  const output = await getEngine(engineName).run({
    text,
    specs,
    docType,
    preview: opts.preview,
    image: req.image,
    provider,
    // Note source is engine-aware: vision reads the image directly (its error is
    // the provider key); text engines need OCR text first, so the OCR error wins.
    providerError: engineName === "vision" ? providerError : (ocrError ?? providerError),
  });

  const fields: Record<string, unknown> = {};
  const confidence: ConfidenceMap = {};
  const fieldSource: FieldSourceMap = {};
  const needsReview: string[] = [];
  const wouldRescue: DryRunFlag[] = [];
  let resolved = 0;

  for (const [name, f] of Object.entries(output.fields)) {
    fields[name] = f.value;
    confidence[name] = f.confidence;
    fieldSource[name] = f.source;
    if (f.value !== null && f.value !== undefined) resolved += 1;
    if (f.reason) {
      needsReview.push(name);
      wouldRescue.push({ field: name, reason: f.reason });
    }
  }

  const byok = typeof req.model_key === "string" && req.model_key.length > 0;
  const modelUsd = output.modelCostUsd ?? 0; // provider sticker cost of the model call(s)

  if (opts.preview) {
    return {
      scan_id: scanId,
      status: "dry_run",
      would_rescue: wouldRescue,
      // A real run would bill one plumbing credit; the model figure is a rough
      // estimate (we never call the model on a dry run). BYO runs the model on
      // the caller's key, so they carry zero model credits — never estimate them.
      scan_credits: 1,
      ...(wouldRescue.length > 0 && !byok
        ? { estimated_model_credits: ESTIMATED_CALL_CREDITS }
        : {}),
    } satisfies ScanDryRun;
  }

  let status: ScanStatus;
  if (specs.length === 0) status = "ok";
  else if (resolved === 0) status = "failed";
  else if (needsReview.length > 0 || resolved < specs.length) status = "partial";
  else status = "ok";

  // Report the OCR provider that actually ran (e.g. "mistral"); for the
  // passthrough path no provider ran, so fall back to the backend ("passthrough").
  const ocrBackend = engineName === "vision" ? null : hasText ? (ocrProviderId ?? backend) : null;

  // Plumbing: 1 credit/scan, 0 on failure. A failed scan burns nothing — not the
  // plumbing credit and not any model cost: if a model call ran but produced an
  // unusable result, we absorb its token cost rather than charge for a failure.
  const scanCredits = status === "failed" ? 0 : 1;

  // Model usage + its cost. On our keys we bill credits via the token→credit map
  // (loaded cost ÷ credit value; fractional). On BYO it's on your key, in dollars.
  let tokens: TokenUsage | undefined;
  let modelCredits = 0;
  if (output.usage) {
    if (byok) {
      tokens = { ...output.usage, provider_cost_usd: round(modelUsd) };
    } else {
      modelCredits = scanCredits === 0 ? 0 : round((modelUsd * MODEL_TAX_MULT) / CREDIT_USD);
      tokens = { ...output.usage, credits: modelCredits };
    }
  }

  // OCR backend usage. The OCR backend ALWAYS runs on our key — the caller's
  // `model_key` is the *model* provider's key, never the OCR backend's — so OCR
  // cost is always billed as credits (same loaded-cost map as the model), even
  // when the model itself runs on a BYO key. `0` on a failed scan (burns nothing).
  let ocrCredits = 0;
  let ocrUsageOut: OcrUsage | undefined;
  if (ocrUsage) {
    ocrCredits = scanCredits === 0 ? 0 : round((ocrUsd * MODEL_TAX_MULT) / CREDIT_USD);
    ocrUsageOut = {
      input: ocrUsage.inputTokens,
      output: ocrUsage.outputTokens,
      credits: ocrCredits,
    };
  }

  const meta: ScanMeta = {
    engine: engineName,
    model: output.model,
    ocr_backend: ocrBackend,
    latency_ms: Date.now() - started,
    ...(tokens ? { tokens } : {}),
    ...(ocrUsageOut ? { ocr_usage: ocrUsageOut } : {}),
    scan_credits: scanCredits,
    total_credits: scanCredits + modelCredits + ocrCredits,
    ...(output.note ? { note: output.note } : {}),
  };

  return {
    scan_id: scanId,
    status,
    fields,
    confidence,
    needs_review: needsReview,
    ...(Object.keys(fieldSource).length > 0 ? { field_source: fieldSource } : {}),
    ...(output.selfCheck ? { self_check: output.selfCheck } : {}),
    raw_text: output.rawText,
    meta,
  } satisfies ScanEnvelope;
}

/** Merge per-page dry runs: page-count plumbing + the summed model estimate. */
function mergeDryRuns(pages: ScanDryRun[], scanId: string): ScanDryRun {
  const wouldRescue: DryRunFlag[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    for (const w of p.would_rescue) {
      if (!seen.has(w.field)) {
        seen.add(w.field);
        wouldRescue.push(w);
      }
    }
  }
  const estimate = pages.reduce((s, p) => s + (p.estimated_model_credits ?? 0), 0);
  return {
    scan_id: scanId,
    status: "dry_run",
    would_rescue: wouldRescue,
    scan_credits: pages.length, // 1 plumbing credit per page
    ...(estimate > 0 ? { estimated_model_credits: estimate } : {}),
  } satisfies ScanDryRun;
}

function sumTokenUsage(list: (TokenUsage | undefined)[]): TokenUsage | undefined {
  const present = list.filter((t): t is TokenUsage => !!t);
  if (present.length === 0) return undefined;
  const out: TokenUsage = {
    input: present.reduce((s, t) => s + t.input, 0),
    output: present.reduce((s, t) => s + t.output, 0),
  };
  // All pages share the same billing mode (same model_key) — sum whichever cost is set.
  if (present.some((t) => t.credits !== undefined)) {
    out.credits = round(present.reduce((s, t) => s + (t.credits ?? 0), 0));
  }
  if (present.some((t) => t.provider_cost_usd !== undefined)) {
    out.provider_cost_usd = round(present.reduce((s, t) => s + (t.provider_cost_usd ?? 0), 0));
  }
  return out;
}

function sumOcrUsage(list: (OcrUsage | undefined)[]): OcrUsage | undefined {
  const present = list.filter((o): o is OcrUsage => !!o);
  if (present.length === 0) return undefined;
  return {
    input: present.reduce((s, o) => s + o.input, 0),
    output: present.reduce((s, o) => s + o.output, 0),
    credits: round(present.reduce((s, o) => s + (o.credits ?? 0), 0)),
  };
}

/**
 * Merge per-page envelopes into one. Each field takes the best value across pages
 * — a clean (un-flagged) high-confidence value beats a flagged one, which beats
 * null — so a field that lands cleanly on any page isn't dragged down by blank
 * pages. Credits + usage sum; raw_text concatenates.
 */
function mergeEnvelopes(pages: ScanEnvelope[], scanId: string, startedMs: number): ScanEnvelope {
  const names = [...new Set(pages.flatMap((p) => Object.keys(p.fields)))];
  const fields: Record<string, unknown> = {};
  const confidence: ConfidenceMap = {};
  const fieldSource: FieldSourceMap = {};
  const needsReview: string[] = [];
  let resolved = 0;

  for (const name of names) {
    const cands = pages
      .map((p) => ({
        value: p.fields[name],
        conf: p.confidence[name] ?? null,
        source: p.field_source?.[name],
        flagged: p.needs_review.includes(name),
      }))
      .filter((c) => c.value !== null && c.value !== undefined);
    const byConf = (a: { conf: number | null }, b: { conf: number | null }) =>
      (b.conf ?? 0) - (a.conf ?? 0);
    const clean = cands.filter((c) => !c.flagged).sort(byConf);
    const chosen = clean[0] ?? [...cands].sort(byConf)[0] ?? null;
    fields[name] = chosen?.value ?? null;
    confidence[name] = chosen?.conf ?? null;
    if (chosen?.source) fieldSource[name] = chosen.source;
    if (chosen?.value !== null && chosen?.value !== undefined) resolved += 1;
    if (!chosen || chosen.flagged) needsReview.push(name);
  }

  const scanCredits = pages.reduce((s, p) => s + p.meta.scan_credits, 0);
  const totalCredits = round(pages.reduce((s, p) => s + p.meta.total_credits, 0));
  const tokens = sumTokenUsage(pages.map((p) => p.meta.tokens));
  const ocrUsage = sumOcrUsage(pages.map((p) => p.meta.ocr_usage));

  const status: ScanStatus =
    names.length === 0
      ? "ok"
      : resolved === 0
        ? "failed"
        : needsReview.length > 0 || resolved < names.length
          ? "partial"
          : "ok";

  const head = pages[0]?.meta;
  const meta: ScanMeta = {
    engine: head?.engine ?? "ocr",
    model: head?.model ?? null,
    ocr_backend: head?.ocr_backend ?? null,
    latency_ms: Date.now() - startedMs,
    ...(tokens ? { tokens } : {}),
    ...(ocrUsage ? { ocr_usage: ocrUsage } : {}),
    scan_credits: scanCredits,
    total_credits: totalCredits,
  };

  return {
    scan_id: scanId,
    status,
    fields,
    confidence,
    needs_review: needsReview,
    ...(Object.keys(fieldSource).length > 0 ? { field_source: fieldSource } : {}),
    raw_text: pages
      .map((p) => p.raw_text)
      .filter(Boolean)
      .join("\n\n"),
    meta,
  } satisfies ScanEnvelope;
}
