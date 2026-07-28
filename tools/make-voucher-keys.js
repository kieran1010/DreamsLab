/* =============================================================================
   make-voucher-keys -- generate the ECDSA P-256 keypair for the voucher system
   -----------------------------------------------------------------------------
   The private key signs entitlement tokens in the Supabase `redeem` Edge
   Function; the public key is pasted into ENT_CONFIG in index.html so the
   simulator can verify tokens offline.

   Usage:  node tools/make-voucher-keys.js

   Prints both keys to stdout and writes NOTHING to disk (so a key can never
   be committed by accident). Run once, store the two values, done. If you
   ever regenerate, every previously issued token stops verifying.

   Requires Node 18+. No dependencies.
   ============================================================================= */
'use strict';

const { webcrypto } = require('node:crypto');

(async () => {
    const pair = await webcrypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
    );
    const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
    // Public JWKs exported from a signing pair carry key_ops/ext fields that
    // just add noise; the sim only needs kty/crv/x/y.
    const jwk = { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y };
    const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');

    console.log('=== Synapse voucher signing keypair ===================================');
    console.log('');
    console.log('1) PUBLIC key -- paste as ENT_CONFIG.publicKeyJwk in index.html:');
    console.log('');
    console.log('    publicKeyJwk: ' + JSON.stringify(jwk) + ',');
    console.log('');
    console.log('2) PRIVATE key -- store as a Supabase secret (never commit it):');
    console.log('');
    console.log('    supabase secrets set VOUCHER_SIGNING_KEY=' + pkcs8);
    console.log('');
    console.log('=======================================================================');
})().catch(e => { console.error(e); process.exit(1); });
