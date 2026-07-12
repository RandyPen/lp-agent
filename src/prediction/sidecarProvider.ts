/**
 * SidecarPredictionProvider — HTTP client for the local Python inference sidecar.
 *
 * Implements `PredictionProvider` by POST-ing `MarketSnapshot` to the sidecar's
 * `/predict` endpoint and GET-ing `/health`. The sidecar runs on localhost and is
 * managed by a supervisor process (launchd / systemd / pm2).
 *
 * Fallback semantics (§3.2 / prediction-service-design.md §4.4):
 *   timeout        — AbortSignal fired before the sidecar responded
 *   sidecar_down   — network/connection error, non-200 HTTP status, or a
 *                    response body that fails the 7-key shape / type contract
 *   psi / missing  — sidecar returns these directly; passed through unchanged
 *   false          — normal inference, all fields from the sidecar
 *
 * Every degraded path:
 *   1. Sets `fallback` to the appropriate reason string.
 *   2. Emits a structured `warn` log with the reason and detail.
 *   3. Returns the NEUTRAL fallback response (widthSigma=0, pAbove=0,
 *      pBelow=0, featureCompleteness=0, psi=0).
 *      modelVersion is taken from the last successful /health call, or "unknown".
 *
 * The provider NEVER throws and NEVER fabricates a non-fallback response.
 *
 * pmRangeContext serialisation:
 *   If ctx.currentBins is non-empty, we compute lowerOffset / upperOffset as
 *   (min(currentBins) - activeBin) / 1  and  (max(currentBins) - activeBin) / 1
 *   (bin-unit offsets relative to activeBin). When currentBins is empty the field
 *   is omitted; the sidecar defaults to ±0.5 internally.
 *
 * See docs/prediction-service-design.md and implementation-plan-v1.md §3.2, W4.
 */

import { log } from "../lib/logger.ts";
import type { PredictionProvider } from "./provider.ts";
import type {
  MarketSnapshot,
  PmRangeContext,
  PredictionResponse,
  ProviderHealth,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** The 7 keys we expect from the sidecar's /predict response, all camelCase.
 * (centerOffset/centerQ10/centerQ90 were removed with the center head —
 * docs/decision-remove-center-prediction.md.) */
const REQUIRED_PREDICT_KEYS = [
  "widthSigma",
  "pAbove",
  "pBelow",
  "modelVersion",
  "featureCompleteness",
  "psi",
  "fallback",
] as const;
type RequiredKey = (typeof REQUIRED_PREDICT_KEYS)[number];

/** Shape returned by the sidecar for a successful /predict. */
interface RawPredictResponse {
  widthSigma: number;
  pAbove: number;
  pBelow: number;
  modelVersion: string;
  featureCompleteness: number;
  psi: number;
  fallback: false | "psi" | "missing" | "stale" | "sidecar_down" | "timeout";
}

/** Shape returned by the sidecar for GET /health. */
interface RawHealthResponse {
  status: string;
  model_version: string;
  loaded_at: string;
  psi_summary: { max: number; breached: string[]; n_obs?: number };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Minimal fetch signature that `SidecarPredictionProvider` requires.
 * Using a structural type rather than `typeof fetch` lets tests inject a plain
 * async function without having to implement Bun's `fetch.preconnect` method.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SidecarProviderOptions {
  /** Base URL of the local sidecar, e.g. "http://127.0.0.1:8377". No trailing slash. */
  baseUrl: string;
  /** Abort after this many milliseconds. Maps to fallback="timeout". */
  timeoutMs: number;
  /**
   * Injectable fetch implementation. Defaults to the global `fetch`.
   * Provided for tests so they can use a mock without any network I/O.
   */
  fetchImpl?: FetchLike;
  /**
   * Clock injection for tests. Defaults to `() => Date.now()`.
   * Not used in logic but useful for deterministic log timestamps.
   */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Verify that a raw response body contains all 10 required keys with the
 * correct runtime types.
 *
 * Returns null on success; returns an error description string on failure.
 */
function validatePredictBody(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return `expected object, got ${typeof body}`;
  }
  const obj = body as Record<string, unknown>;
  for (const key of REQUIRED_PREDICT_KEYS) {
    if (!(key in obj)) {
      return `missing key: ${key}`;
    }
  }

  // Type checks for numeric fields.
  const numericKeys: RequiredKey[] = [
    "widthSigma",
    "pAbove",
    "pBelow",
    "featureCompleteness",
    "psi",
  ];
  for (const key of numericKeys) {
    if (typeof obj[key] !== "number" || !Number.isFinite(obj[key] as number)) {
      return `${key} must be a finite number, got ${typeof obj[key]} ${JSON.stringify(obj[key])}`;
    }
  }

  // modelVersion must be a non-empty string.
  if (typeof obj["modelVersion"] !== "string" || (obj["modelVersion"] as string).length === 0) {
    return `modelVersion must be a non-empty string, got ${JSON.stringify(obj["modelVersion"])}`;
  }

  // fallback must be false or one of the documented string values.
  const fb = obj["fallback"];
  const validFallbacks = new Set([false, "psi", "missing", "stale", "sidecar_down", "timeout"]);
  if (!validFallbacks.has(fb as false | string)) {
    return `fallback has unrecognised value: ${JSON.stringify(fb)}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Neutral fallback response builder
// ---------------------------------------------------------------------------

/**
 * Return a neutral `PredictionResponse` for any degraded path.
 * The caller supplies the fallback reason; modelVersion comes from the last
 * successful /health poll or defaults to "unknown".
 */
function neutralFallback(
  reason: "timeout" | "sidecar_down",
  lastKnownModelVersion: string,
): PredictionResponse {
  return {
    widthSigma: 0,
    pAbove: 0,
    pBelow: 0,
    modelVersion: lastKnownModelVersion,
    featureCompleteness: 0,
    psi: 0,
    fallback: reason,
  };
}

// ---------------------------------------------------------------------------
// pmRangeContext serialisation
// ---------------------------------------------------------------------------

/**
 * Build the optional `pmRangeContext` payload the sidecar accepts.
 * The sidecar expects `{ lowerOffset, upperOffset }` in bin-unit offsets
 * relative to activeBin.
 *
 * We only include it when currentBins is non-empty; otherwise the sidecar
 * uses its own default of ±0.5.
 */
function buildPmRangeContext(
  ctx: PmRangeContext,
): { lowerOffset: number; upperOffset: number } | undefined {
  if (ctx.currentBins.length === 0) return undefined;
  const lowerOffset = Math.min(...ctx.currentBins) - ctx.activeBin;
  const upperOffset = Math.max(...ctx.currentBins) - ctx.activeBin;
  return { lowerOffset, upperOffset };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class SidecarPredictionProvider implements PredictionProvider {
  readonly name = "sidecar";

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  /** Last modelVersion seen from /health, used in neutral fallback responses. */
  private lastKnownModelVersion = "unknown";

  constructor(opts: SidecarProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl ?? ((globalThis.fetch as unknown) as FetchLike);
    this.now = opts.now ?? (() => Date.now());
  }

  // -------------------------------------------------------------------------
  // predict
  // -------------------------------------------------------------------------

  async predict(snapshot: MarketSnapshot, ctx: PmRangeContext): Promise<PredictionResponse> {
    const pmRangeContext = buildPmRangeContext(ctx);
    const body: MarketSnapshot & { pmRangeContext?: { lowerOffset: number; upperOffset: number } } =
      pmRangeContext !== undefined ? { ...snapshot, pmRangeContext } : snapshot;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      // AbortError from our own timer → timeout; anything else → sidecar_down.
      const isAbort =
        err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      if (isAbort) {
        log.warn("sidecarProvider: predict timed out", {
          baseUrl: this.baseUrl,
          timeoutMs: this.timeoutMs,
          fallback: "timeout",
        });
        return neutralFallback("timeout", this.lastKnownModelVersion);
      }
      log.warn("sidecarProvider: predict network error", {
        baseUrl: this.baseUrl,
        error: err instanceof Error ? err.message : String(err),
        fallback: "sidecar_down",
      });
      return neutralFallback("sidecar_down", this.lastKnownModelVersion);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      log.warn("sidecarProvider: predict non-200 status", {
        baseUrl: this.baseUrl,
        status: response.status,
        fallback: "sidecar_down",
      });
      return neutralFallback("sidecar_down", this.lastKnownModelVersion);
    }

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (err: unknown) {
      log.warn("sidecarProvider: predict body not valid JSON", {
        baseUrl: this.baseUrl,
        error: err instanceof Error ? err.message : String(err),
        fallback: "sidecar_down",
      });
      return neutralFallback("sidecar_down", this.lastKnownModelVersion);
    }

    const validationError = validatePredictBody(rawBody);
    if (validationError !== null) {
      log.warn("sidecarProvider: predict body contract violation", {
        baseUrl: this.baseUrl,
        detail: validationError,
        fallback: "sidecar_down",
      });
      return neutralFallback("sidecar_down", this.lastKnownModelVersion);
    }

    // Body is valid; cast is safe.
    const parsed = rawBody as RawPredictResponse;

    // Update our cached model version from each successful response.
    this.lastKnownModelVersion = parsed.modelVersion;

    // Sidecar-reported fallbacks (psi / missing / stale) are passed through
    // unchanged: the consumer (mlAgent) decides whether to discard.
    if (parsed.fallback !== false) {
      log.warn("sidecarProvider: sidecar-reported fallback", {
        baseUrl: this.baseUrl,
        fallback: parsed.fallback,
        modelVersion: parsed.modelVersion,
        psi: parsed.psi,
        featureCompleteness: parsed.featureCompleteness,
      });
    }

    return {
      widthSigma: parsed.widthSigma,
      pAbove: parsed.pAbove,
      pBelow: parsed.pBelow,
      modelVersion: parsed.modelVersion,
      featureCompleteness: parsed.featureCompleteness,
      psi: parsed.psi,
      fallback: parsed.fallback,
    };
  }

  // -------------------------------------------------------------------------
  // health
  // -------------------------------------------------------------------------

  async health(): Promise<ProviderHealth> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, detail };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch {
      return { ok: false, detail: "response body is not valid JSON" };
    }

    if (rawBody === null || typeof rawBody !== "object") {
      return { ok: false, detail: "unexpected health response shape" };
    }

    const obj = rawBody as Partial<RawHealthResponse>;
    const modelVersion = typeof obj.model_version === "string" ? obj.model_version : undefined;
    if (modelVersion) {
      this.lastKnownModelVersion = modelVersion;
    }

    const statusOk =
      typeof obj.status === "string" && obj.status.toLowerCase() === "ok";
    return {
      ok: statusOk,
      modelVersion,
      detail: statusOk ? undefined : `sidecar status: ${obj.status ?? "unknown"}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory (project convention: named factory over direct `new`)
// ---------------------------------------------------------------------------

/**
 * Create a `SidecarPredictionProvider` that POSTs to the local Python sidecar.
 *
 * ```ts
 * const provider = createSidecarPredictionProvider({
 *   baseUrl: cfg.prediction.sidecarUrl,
 *   timeoutMs: cfg.prediction.timeoutMs,
 * });
 * ```
 */
export function createSidecarPredictionProvider(
  opts: SidecarProviderOptions,
): SidecarPredictionProvider {
  return new SidecarPredictionProvider(opts);
}
