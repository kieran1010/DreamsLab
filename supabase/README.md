# Synapse voucher system — backend setup

The v4.33 voucher system locks the scenarios listed in `PREMIUM_SCENARIOS`
(in `index.html`, `[ENTITLEMENTS]` section) behind time-limited access codes.

**Status: live**, as of v4.42 (2026-09-17). `ENT_CONFIG` in `index.html`
carries this deployment's real `redeemUrl` and `publicKeyJwk`; the `redeem`
Edge Function is deployed (via the dashboard editor, not the CLI - see step 3)
with its `VOUCHER_SIGNING_KEY` secret set.

The steps below are still the reference for doing this from scratch (a new
deployment, or rotating the signing key). The design point that made this
safe to build incrementally: while `ENT_CONFIG` is empty, nothing is locked
and the voucher UI is hidden — v4.33 could be merged and deployed long before
any of the steps below were done, exactly as it shipped for several months.
Filling in the two `ENT_CONFIG` values is the switch that turns it on, and
`tools/voucher-probe.js` still exercises that unconfigured-state mechanism
even now that the committed config is live (by explicitly re-emptying it for
that one check).

None of this setup strictly requires the Supabase CLI - the dashboard has a
SQL editor (migrations), an Edge Functions code editor + deploy button
(step 3), and a Secrets page (step 2), all browser-based. The CLI commands
below are kept as the alternative for anyone who prefers them.

## How it fits together

```
student's browser                     Supabase project
┌─────────────────────┐  code   ┌──────────────────────────┐
│ index.html          │ ──────► │ Edge Function: redeem     │
│  [ENTITLEMENTS]     │ ◄────── │  → redeem_voucher() RPC   │
│  verifies token     │  signed │    (atomic seat check)    │
│  offline, WebCrypto │  token  │  → signs token (ECDSA)    │
└─────────────────────┘         ├──────────────────────────┤
┌─────────────────────┐  auth + │ Postgres: vouchers,       │
│ admin.html          │ ──────► │ redemptions (RLS: only    │
│  create/revoke codes│  REST   │ authenticated users)      │
└─────────────────────┘         └──────────────────────────┘
```

- The token is `base64url(JSON payload).base64url(ECDSA-P256 signature)`.
  The sim trusts **the signing key, not the server**: it verifies every token
  locally before storing it, and re-verifies from localStorage on each load.
  After one online activation, everything works offline until the token expires.
- Revoking a voucher stops **new** redemptions. Tokens already issued keep
  working until they expire — that is deliberate (a classroom shouldn't die
  mid-course because the code leaked), and it's why access lengths matter.
- Gating is honesty-level: the scenario content ships in `index.html` and the
  repo is public. You are selling legitimate access, not DRM.

## One-time setup

1. **Create (or reuse) a Supabase project**, then apply the migration:
   ```bash
   supabase link --project-ref <your-project-ref>
   supabase db push          # applies supabase/migrations/*_vouchers.sql
   ```
   (Or paste the migration into the SQL editor in the dashboard.)

2. **Generate the signing keypair:**
   ```bash
   node tools/make-voucher-keys.js
   ```
   It prints two values and writes nothing to disk:
   - the **public JWK** → paste as `ENT_CONFIG.publicKeyJwk` in `index.html`
   - the **private key** → store as the `VOUCHER_SIGNING_KEY` secret, either
     `supabase secrets set VOUCHER_SIGNING_KEY=<value>` or, CLI-free, the
     dashboard's Edge Functions → Secrets page.

   Keep a copy of the private key somewhere safe (password manager). If you
   lose or regenerate it, every issued token stops verifying.

3. **Deploy the redeem function.** Either:
   ```bash
   supabase functions deploy redeem --no-verify-jwt
   ```
   or, CLI-free: dashboard → Edge Functions → Create a new function, name it
   `redeem`, paste in `supabase/functions/redeem/index.ts`'s contents, and
   turn **off** JWT verification before deploying (look for that option on
   the create screen or the function's own Settings tab afterward - dashboard
   layouts change, so check what's actually in front of you). Either way,
   `--no-verify-jwt` / JWT verification off is required - the sim calls this
   anonymously; the voucher code itself is the credential. Then set
   `ENT_CONFIG.redeemUrl` in `index.html` to
   `https://<project-ref>.supabase.co/functions/v1/redeem`.

4. **Create your admin login.** In the dashboard: Authentication → Users →
   *Add user* (your email + a strong password). Then **disable public
   sign-ups** (Authentication → Sign In / Up → email → disable sign-ups) —
   RLS grants full voucher access to *any* authenticated user, so sign-up
   being open would make everyone an admin.

5. **Configure `admin.html`:** fill in `SB_URL` and `SB_ANON` at the top of
   its script block (dashboard → Settings → API). The anon key is public by
   design; RLS is what protects the data. `admin.html` deploys with the site
   (synapse.hypnos.one/admin.html) — if you'd rather it weren't public, keep
   it out of the repo and open it locally; it works from `file://`.

6. **Pick the paid scenarios:** edit `PREMIUM_SCENARIOS` in `index.html`.
   The shipped list is a starting suggestion (basics free, crisis scenarios
   Pro) — it is purely a content decision.

7. **Test before pushing:** `node tools/voucher-probe.js` (offline logic),
   then open `index.html` locally, apply a real code from `admin.html`, and
   confirm the padlocks clear. Pushing to `main` deploys.

## Voucher semantics

Created in `admin.html`; stored uppercase without dashes (entry is
case/dash-insensitive):

| Field | Meaning |
|---|---|
| Seats (`max_redemptions`) | 1 = single use; N = classroom; blank = unlimited |
| Access length (`access_days`) | days of access counted from each student's redemption |
| Access ends (`access_until`) | hard end date; effective expiry is the **earlier** of the two |
| Redeemable until (`redeem_by`) | after this date the code can no longer be activated |
| Revoked | blocks new redemptions immediately; issued tokens run to expiry |

Every redemption is logged (`redemptions` table) with a random per-browser
`client_id` — a "30-seat" code showing 30 redemptions from 300 distinct
clients is how you spot a leak.

## Costs & limits

Everything here fits Supabase's free tier at classroom scale. The redeem
function runs once per student per activation — negligible. If the project
pauses from inactivity (free-tier behaviour), redemption stops working until
it wakes; already-activated users are unaffected because verification is
offline.
