// =============================================================================
// redeem - the one public endpoint of the Synapse voucher system.
// -----------------------------------------------------------------------------
// POST { code, clientId? }  ->  { token, tier, label, expires }
//
// Validates the code via the redeem_voucher() Postgres function (which is
// atomic - see the migration), then returns a signed entitlement token the
// simulator caches in localStorage and verifies OFFLINE with WebCrypto.
// Token format:  base64url(JSON payload) + "." + base64url(ECDSA-P256 sig)
// The signature is over the raw payload bytes, SHA-256, IEEE P1363 format -
// exactly what browser crypto.subtle.verify expects, no JWT library needed.
//
// Secrets (supabase secrets set):
//   VOUCHER_SIGNING_KEY  base64 PKCS8 ECDSA P-256 private key
//                        (generate with tools/make-voucher-keys.js)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// Deploy with:  supabase functions deploy redeem --no-verify-jwt
// (--no-verify-jwt because the simulator calls this anonymously; the voucher
// code itself is the credential.)
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Import the signing key once per isolate, not per request.
let keyPromise: Promise<CryptoKey> | null = null;
function signingKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    const b64 = Deno.env.get("VOUCHER_SIGNING_KEY");
    if (!b64) throw new Error("VOUCHER_SIGNING_KEY secret not set");
    const pkcs8 = Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
    keyPromise = crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  }
  return keyPromise;
}

// Messages shown verbatim in the simulator's voucher box.
const USER_ERRORS: Record<string, string> = {
  INVALID_CODE: "That code was not recognised. Check for typos and try again.",
  REVOKED: "This code has been deactivated. Contact whoever issued it.",
  EXPIRED: "This code's redemption window has closed.",
  FULLY_REDEEMED: "This code has already been used the maximum number of times.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await req.json().catch(() => ({}));
  const code = String(body.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length < 8 || code.length > 32) {
    return json({ error: USER_ERRORS.INVALID_CODE, code: "INVALID_CODE" }, 400);
  }
  const clientId = typeof body.clientId === "string" ? body.clientId.slice(0, 64) : null;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data, error } = await supabase.rpc("redeem_voucher", {
    p_code: code,
    p_client_id: clientId,
    p_user_agent: req.headers.get("user-agent")?.slice(0, 256) ?? null,
  });

  if (error) {
    const known = Object.keys(USER_ERRORS).find((k) => error.message?.includes(k));
    if (known) return json({ error: USER_ERRORS[known], code: known }, 400);
    console.error("redeem_voucher failed:", error);
    return json({ error: "Something went wrong on our end. Please try again.", code: "SERVER" }, 500);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.access_end) {
    console.error("redeem_voucher returned no row:", data);
    return json({ error: "Something went wrong on our end. Please try again.", code: "SERVER" }, 500);
  }

  const payload = {
    v: 1,
    tier: row.tier ?? "pro",
    label: row.label ?? null,
    iat: Date.now(),
    exp: new Date(row.access_end).getTime(),
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await signingKey(),
    payloadBytes,
  );
  const token = b64url(payloadBytes) + "." + b64url(new Uint8Array(sig));

  return json({ token, tier: payload.tier, label: payload.label, expires: row.access_end });
});
