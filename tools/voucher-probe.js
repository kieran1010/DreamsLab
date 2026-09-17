/* =============================================================================
   VOUCHER PROBE  --  end-to-end check of the v4.33 entitlement system
   -----------------------------------------------------------------------------
   Signs entitlement tokens with a throwaway ECDSA P-256 key EXACTLY the way
   the Supabase redeem function does (WebCrypto, SHA-256, raw P1363 signature
   over the payload bytes), then drives the simulator's real verification and
   gating code inside the harness sandbox. What passes here is the same code
   path a browser runs; only the network fetch in applyVoucher() is out of
   scope (the sandbox deliberately has no fetch).

       node tools/voucher-probe.js        # always exits 0
       DL_STRICT=1 node tools/voucher-probe.js   # exit 1 on failure (CI)
   ============================================================================= */
'use strict';

const { boot } = require('./harness');
const { webcrypto: wc } = require('node:crypto');

let pass = 0, fail = 0;
function check(ok, label) {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
    if (ok) pass++; else fail++;
}

const b64u = buf => Buffer.from(buf).toString('base64url');

async function makeToken(privateKey, payload) {
    const bytes = Buffer.from(JSON.stringify(payload));
    const sig = await wc.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes);
    return b64u(bytes) + '.' + b64u(sig);
}

/* Boot a sim with the voucher system switched on for the given public key.
   Also pins PREMIUM_SCENARIOS to a known test list ('sepsis' locked,
   everything else free) rather than trusting whatever the real committed
   list currently is - that's a content decision (see [ENTITLEMENTS] in
   index.html) this probe shouldn't be coupled to. */
async function bootConfigured(jwk) {
    const sim = boot();
    sim.dl.ENT_CONFIG.redeemUrl = 'https://example.invalid/functions/v1/redeem';
    sim.dl.ENT_CONFIG.publicKeyJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    sim.dl.PREMIUM_SCENARIOS.length = 0;
    sim.dl.PREMIUM_SCENARIOS.push('sepsis');
    return sim;
}

(async () => {
    const pair = await wc.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await wc.subtle.exportKey('jwk', pair.publicKey);
    const DAY = 86400000;

    console.log('\nvoucher-probe: unconfigured state (mechanism, not current deployment state)');
    {
        /* v4.42: index.html now ships CONFIGURED for real (this deployment's
           live redeemUrl/publicKeyJwk are committed) - the system went live.
           So this no longer asserts anything about the committed config;
           instead it explicitly re-empties it, to keep covering the
           mechanism a fresh/unconfigured clone relies on: empty config must
           still mean nothing is locked. */
        const sim = boot();
        sim.dl.ENT_CONFIG.redeemUrl = '';
        sim.dl.ENT_CONFIG.publicKeyJwk = null;
        check(sim.dl.entConfigured() === false, 'empty ENT_CONFIG reads as unconfigured');
        check(sim.dl.PREMIUM_SCENARIOS.every(k => !sim.dl.isScenarioLocked(k)),
            'unconfigured build locks nothing (deploy-before-setup is a no-op)');
        sim.dl.pickScenario('sepsis');
        check(sim.dl.state.currentScenario === 'sepsis',
            'premium scenario loads normally while unconfigured');
    }

    console.log('\nvoucher-probe: configured, no token');
    {
        const sim = await bootConfigured(jwk);
        check(sim.dl.isScenarioLocked('sepsis') === true, 'premium scenario is locked');
        check(sim.dl.isScenarioLocked('induction') === false, 'free scenario stays open');
        sim.dl.pickScenario('sepsis');
        check(sim.dl.state.currentScenario !== 'sepsis', 'pickScenario refuses the locked scenario');
        sim.dl.pickScenario('induction');
        check(sim.dl.state.currentScenario === 'induction', 'pickScenario loads the free scenario');
    }

    console.log('\nvoucher-probe: valid token');
    {
        const sim = await bootConfigured(jwk);
        const token = await makeToken(pair.privateKey,
            { v: 1, tier: 'pro', label: 'probe', iat: Date.now(), exp: Date.now() + DAY });
        sim.context.localStorage.setItem('dl_entitlement', token);
        await sim.dl.entInit();
        check(sim.dl.hasPro() === true, 'correctly signed, in-date token grants Pro');
        check(sim.dl.isScenarioLocked('sepsis') === false, 'premium scenario unlocks');
        sim.dl.pickScenario('sepsis');
        check(sim.dl.state.currentScenario === 'sepsis', 'pickScenario now loads it');
    }

    console.log('\nvoucher-probe: rejects');
    {
        // Expired
        let sim = await bootConfigured(jwk);
        const expired = await makeToken(pair.privateKey,
            { v: 1, tier: 'pro', iat: Date.now() - 2 * DAY, exp: Date.now() - DAY });
        sim.context.localStorage.setItem('dl_entitlement', expired);
        await sim.dl.entInit();
        check(sim.dl.hasPro() === false, 'expired token rejected');
        check(sim.context.localStorage.getItem('dl_entitlement') === null,
            'expired token is cleared from storage');

        // Tampered payload (extend exp without re-signing)
        sim = await bootConfigured(jwk);
        const good = await makeToken(pair.privateKey,
            { v: 1, tier: 'pro', iat: Date.now(), exp: Date.now() + DAY });
        const [p, s] = good.split('.');
        const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
        payload.exp = Date.now() + 3650 * DAY;
        const forged = b64u(Buffer.from(JSON.stringify(payload))) + '.' + s;
        sim.context.localStorage.setItem('dl_entitlement', forged);
        await sim.dl.entInit();
        check(sim.dl.hasPro() === false, 'tampered payload rejected (signature mismatch)');

        // Signed by the wrong key
        sim = await bootConfigured(jwk);
        const rogue = await wc.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const wrongKey = await makeToken(rogue.privateKey,
            { v: 1, tier: 'pro', iat: Date.now(), exp: Date.now() + DAY });
        sim.context.localStorage.setItem('dl_entitlement', wrongKey);
        await sim.dl.entInit();
        check(sim.dl.hasPro() === false, 'token signed by a different key rejected');

        // Garbage
        sim = await bootConfigured(jwk);
        sim.context.localStorage.setItem('dl_entitlement', 'not-even-a-token');
        await sim.dl.entInit();
        check(sim.dl.hasPro() === false, 'garbage token rejected without throwing');
    }

    console.log(`\n${pass}/${pass + fail} checks pass.`);
    if (process.env.DL_STRICT === '1' && fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
