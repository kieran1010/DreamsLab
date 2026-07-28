# Synapse voucher system — backend setup

The v4.33 voucher system locks the scenarios listed in `PREMIUM_SCENARIOS`
(in `index.html`, `[ENTITLEMENTS]` section) behind time-limited access codes.

**The repo ships with the system OFF.** `ENT_CONFIG` in `index.html` is empty,
so nothing is locked and the voucher UI is hidden — you can merge and deploy
v4.33 safely before doing any of the steps below. Filling in the two
`ENT_CONFIG` values is the switch that turns it on.

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
   - the **private key** → `supabase secrets set VOUCHER_SIGNING_KEY=<value>`

   Keep a copy of the private key somewhere safe (password manager). If you
   lose or regenerate it, every issued token stops verifying.

3. **Deploy the redeem function:**
   ```bash
   supabase functions deploy redeem --no-verify-jwt
   ```
   `--no-verify-jwt` is required — the sim calls it anonymously; the voucher
   code itself is the credential. Then set `ENT_CONFIG.redeemUrl` in
   `index.html` to `https://<project-ref>.supabase.co/functions/v1/redeem`.

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
