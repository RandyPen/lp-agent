/**
 * Treasury HTTP API v2.
 *
 * Exposes treasury operations (user registration, balance lookup, signature-
 * verified charges) over a local HTTP interface backed by Bun.serve().
 *
 * Security model:
 *   - Bind-local by default (127.0.0.1). Never expose raw to public internet.
 *   - All mutating endpoints require a Sui personal-message signature.
 *   - Nonce-first audit: every charge attempt is logged before verification.
 *
 * Start: call startTreasuryHttpApi(cfg) after treasury is initialised.
 * Stop:  call the returned handle.stop().
 */

import { log } from "../lib/logger.ts";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import type { AppConfig } from "../config.ts";
import { registerUser } from "./registration.ts";
import { chargeForServiceWithSignature } from "./charges.ts";
import {
  findUserBySuiAddress,
  listDepositsForUser,
} from "./store.ts";
import type { DepositRecord } from "./types.ts";
import { matchWebRoute } from "../web/routes.ts";

const SUI_ADDR_RE = /^0x[0-9a-fA-F]{64}$/;
const MAX_BODY_BYTES = 16_384;

export interface TreasuryHttpApiHandle {
  stop(): void;
  port: number;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, jsonReplacer), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

function err(status: number, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...extra }, status);
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

async function readBody(req: Request): Promise<{ body: string } | Response> {
  const raw = await req.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) {
    return err(413, "request too large");
  }
  return { body: new TextDecoder().decode(raw) };
}

async function parseJsonBody<T = Record<string, unknown>>(
  req: Request,
): Promise<{ data: T } | Response> {
  const result = await readBody(req);
  if (result instanceof Response) return result;
  try {
    const data = JSON.parse(result.body) as T;
    return { data };
  } catch {
    return err(400, "invalid JSON");
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/users/register
 * Body: { suiAddress, messageB64, signature }
 * Signed message format: LiquidityManager:register:<suiAddress>:<timestampMs>
 */
async function handleRegister(req: Request): Promise<Response> {
  const parsed = await parseJsonBody<{
    suiAddress?: unknown;
    messageB64?: unknown;
    signature?: unknown;
  }>(req);
  if (parsed instanceof Response) return parsed;
  const { data } = parsed;

  const suiAddress = String(data.suiAddress ?? "");
  const messageB64 = String(data.messageB64 ?? "");
  const signature = String(data.signature ?? "");

  if (!SUI_ADDR_RE.test(suiAddress)) {
    return err(400, "invalid suiAddress format");
  }

  // Decode and validate message format: LiquidityManager:register:<suiAddress>:<timestampMs>
  let message: string;
  try {
    message = Buffer.from(messageB64, "base64").toString("utf-8");
  } catch {
    return err(400, "messageB64 is not valid base64");
  }

  const parts = message.split(":");
  const [prefix, action, addrPart, tsPart] = parts;
  if (
    parts.length !== 4 ||
    prefix !== "LiquidityManager" ||
    action !== "register" ||
    addrPart !== suiAddress ||
    !tsPart ||
    !/^\d+$/.test(tsPart)
  ) {
    return err(400, "invalid message format — expected LiquidityManager:register:<suiAddress>:<timestampMs>");
  }

  const timestampMs = Number(tsPart);
  const now = Date.now();
  if (Math.abs(now - timestampMs) > 300_000) {
    return err(400, "message timestamp is stale (>300s drift)");
  }

  // Verify signature.
  try {
    const msgBytes = new TextEncoder().encode(message);
    const publicKey = await verifyPersonalMessageSignature(msgBytes, signature);
    const recoveredAddress = publicKey.toSuiAddress();
    if (recoveredAddress !== suiAddress) {
      log.warn("treasury/httpApi: register sig mismatch", {
        suiAddress,
        recoveredAddress,
        sigPrefix: signature.slice(0, 8),
      });
      return err(401, "signature does not match suiAddress");
    }
  } catch {
    return err(401, "signature verification failed");
  }

  try {
    const user = registerUser(suiAddress);
    log.info("treasury/httpApi: register ok", { suiAddress });
    return json({
      suiAddress: user.suiAddress,
      depositAddress: user.depositAddress,
      credits: user.credits,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("treasury/httpApi: register unexpected error", { suiAddress, error: msg });
    return err(500, "internal server error");
  }
}

/**
 * GET /v1/users/:suiAddress
 * No auth. Returns user record or 404.
 */
function handleGetUser(suiAddress: string): Response {
  if (!SUI_ADDR_RE.test(suiAddress)) {
    return err(400, "invalid suiAddress format");
  }
  const user = findUserBySuiAddress(suiAddress);
  if (!user) {
    return err(404, "user not found");
  }
  return json({
    suiAddress: user.suiAddress,
    depositAddress: user.depositAddress,
    credits: user.credits,
    createdAtMs: user.createdAtMs,
  });
}

/**
 * GET /v1/users/:suiAddress/deposits?limit=50
 * No auth. Returns deposit array (bigints as strings).
 */
function handleGetDeposits(suiAddress: string, url: URL): Response {
  if (!SUI_ADDR_RE.test(suiAddress)) {
    return err(400, "invalid suiAddress format");
  }

  const user = findUserBySuiAddress(suiAddress);
  if (!user) {
    return err(404, "user not found");
  }

  const limitParam = url.searchParams.get("limit") ?? "50";
  const limitNum = Number(limitParam);
  if (!Number.isInteger(limitNum) || limitNum <= 0) {
    return err(400, "limit must be a positive integer");
  }
  const limit = Math.min(limitNum, 100);

  const deposits: DepositRecord[] = listDepositsForUser(suiAddress, limit);
  return json(deposits);
}

/**
 * POST /v1/charges
 * Body: { suiAddress, credits, nonce, messageB64, signature, memo? }
 */
async function handleCharge(req: Request): Promise<Response> {
  const parsed = await parseJsonBody<{
    suiAddress?: unknown;
    credits?: unknown;
    nonce?: unknown;
    messageB64?: unknown;
    signature?: unknown;
    memo?: unknown;
  }>(req);
  if (parsed instanceof Response) return parsed;
  const { data } = parsed;

  const suiAddress = String(data.suiAddress ?? "");
  const credits = data.credits;
  const nonce = String(data.nonce ?? "");
  const messageB64 = String(data.messageB64 ?? "");
  const signature = String(data.signature ?? "");
  const memo = data.memo != null ? String(data.memo) : undefined;

  if (!SUI_ADDR_RE.test(suiAddress)) {
    return err(400, "invalid suiAddress format");
  }
  if (!Number.isInteger(credits) || (credits as number) <= 0) {
    return err(400, "credits must be a positive integer");
  }
  if (!nonce || nonce.trim() === "") {
    return err(400, "nonce must be a non-empty string");
  }

  log.info("treasury/httpApi: charge request", {
    suiAddress,
    credits,
    nonce,
    sigPrefix: signature.slice(0, 8),
  });

  try {
    const result = await chargeForServiceWithSignature({
      suiAddress,
      credits: credits as number,
      messageB64,
      signature,
      nonce,
      memo,
    });

    if (result.ok) {
      return json({ ok: true, remainingCredits: result.remainingCredits });
    }

    const error = result.error ?? "rejected";
    if (error === "insufficient_credits") {
      return json({ error: "insufficient_credits", remainingCredits: result.remainingCredits }, 402);
    }
    if (error === "not_registered") {
      return err(400, "not_registered");
    }
    return err(400, error);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);

    if (msg === "bad_signature") {
      return err(401, "bad_signature");
    }
    if (msg.includes("nonce") && msg.includes("already")) {
      return err(409, "nonce_already_used");
    }
    if (msg.includes("nonce") && msg.includes("rejected")) {
      return err(409, "nonce_already_used");
    }
    if (msg.includes("message mismatch")) {
      return err(400, msg);
    }
    if (msg.includes("credits must be")) {
      return err(400, msg);
    }

    log.error("treasury/httpApi: charge unexpected error", { suiAddress, nonce, error: msg });
    return err(500, "internal server error");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function startTreasuryHttpApi(cfg: AppConfig): TreasuryHttpApiHandle {
  if (!cfg.treasury.http) {
    throw new Error("startTreasuryHttpApi: cfg.treasury.http is null (TREASURY_HTTP_ENABLED=false)");
  }
  const { host, port } = cfg.treasury.http;

  const server = Bun.serve({
    hostname: host,
    port,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const method = req.method;

      let response: Response;

      try {
        // POST /v1/users/register
        if (method === "POST" && pathname === "/v1/users/register") {
          response = await handleRegister(req);
        }

        // GET /v1/users/:suiAddress/deposits
        else if (method === "GET" && pathname.startsWith("/v1/users/") && pathname.endsWith("/deposits")) {
          const addr = pathname.slice("/v1/users/".length, -"/deposits".length);
          response = handleGetDeposits(addr, url);
        }

        // GET /v1/users/:suiAddress
        else if (method === "GET" && pathname.startsWith("/v1/users/")) {
          const addr = pathname.slice("/v1/users/".length);
          response = handleGetUser(addr);
        }

        // POST /v1/charges
        else if (method === "POST" && pathname === "/v1/charges") {
          response = await handleCharge(req);
        }

        // Read-only web routes (src/web/routes.ts) — then 404 fallback
        else {
          response = matchWebRoute(cfg, method, pathname, url) ?? err(404, "not found");
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error("treasury/httpApi: unhandled error", { method, pathname, error: msg });
        response = err(500, "internal server error");
      }

      log.info("treasury/httpApi: request", {
        method,
        path: pathname,
        status: response.status,
      });

      return response;
    },
  });

  // Bun.serve() assigns an OS port when port=0; server.port may be undefined
  // in the type declaration but is always set at runtime after serve() returns.
  const assignedPort: number = (server.port as number | undefined) ?? port;
  log.info("treasury/httpApi: listening", { host, port: assignedPort });

  return {
    stop(): void {
      server.stop();
      log.info("treasury/httpApi: stopped");
    },
    port: assignedPort,
  };
}
