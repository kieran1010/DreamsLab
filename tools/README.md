# Physiology model test harness

Tools for exercising the Dreams Lab physiology engine **without a browser**, so
model changes can be checked against every scenario in a couple of minutes.

`index.html` holds the whole simulator in one inline `<script>`. `harness.js`
extracts that script and runs it in a Node `vm` sandbox with a stubbed DOM,
canvas and audio context, replacing the timers with a virtual clock so the
100 ms physiology tick can be driven deterministically and far faster than real
time.

Nothing in `index.html` is modified or duplicated. The real `CONFIG`,
`PROFILES`, `PK`, `SCENARIOS` and physiology tick execute exactly as they do in
the browser, and parameters are read through the Physiology tab's own
`PHYS_GROUPS` getters — so what these tools measure is what a user sees.

Requires Node 18+. No dependencies, no build step.

---

## Quick start

```bash
node tools/sweep.js      # run all 20 scenarios, untreated and treated  (~2 min)
node tools/scan.js       # flag anomalies in what sweep recorded
node tools/probes.js     # targeted checks for known bugs
```

`sweep.js` writes `tools/results.json`, which `scan.js` and `trace.js` read.
That file is generated and git-ignored.

---

## The tools

### `sweep.js` — record everything

Runs each scenario twice for 600 simulated seconds: once untreated (no user
action at all) and once applying that scenario's **own recommended treatment**,
transcribed from its `objectives` and `hints` in `index.html`. All 22 Physiology
gauges are sampled every 5 s, alongside non-gauge context (rhythm, PIP, drug
effect-site levels, active events, analgesia cover).

Treatments go through the same public functions a click would call —
`giveBolus()`, `setInf()`, `setVentParam()`, `setAirway()`, `setVentMode()`,
`toggleEvent()` — so the runs exercise real user paths.

```bash
node tools/sweep.js
DL_DURATION=1200 DL_SAMPLE=10 node tools/sweep.js
```

| variable | default | meaning |
|---|---|---|
| `DL_DURATION` | `600` | simulated seconds per run |
| `DL_SAMPLE` | `5` | seconds between samples |
| `DL_SEED` | `20260728` | PRNG seed (see *Determinism*) |
| `DL_HTML` | `../index.html` | test a different copy or revision |

**When you add or retune a scenario, update `TREATMENTS` in this file to match
its hints.** That mapping is the only thing here that duplicates knowledge from
`index.html`.

### `scan.js` — find anomalies

Reads `results.json` and reports, per scenario and per gauge:

| level | meaning |
|---|---|
| `BUG` | NaN values, or values outside the gauge's own declared `min`..`max` (the bar clips and the trend is lost) |
| `CLIN` | clinically implausible steady state at the end of the run |
| `WARN` | a gauge pinned at its floor or ceiling for most of the run |
| `INFO` | a gauge that never moves at all |

Gauge ranges are read from `PHYS_GROUPS` at runtime, so retuning a gauge is
picked up automatically. It also prints a treatment-effect table comparing the
end of the treated and untreated runs — which is where "the recommended
treatment makes it worse" shows up.

### `trace.js` — inspect one scenario

The debugging companion to `scan.js`. Prints every gauge at chosen timepoints
for both runs, plus the surrounding context.

```bash
node tools/trace.js                                   # list scenario keys
node tools/trace.js bronchospasm
node tools/trace.js ischaemia 0,30,60,90,150,300,600
```

### `probes.js` — regression checks for known bugs

Where `scan.js` looks broadly, this pins down one specific behaviour per audit
finding and states what it should be once fixed. Each probe isolates a single
variable, so the result is unambiguous.

```bash
node tools/probes.js              # all probes, always exits 0
node tools/probes.js F4           # one probe
DL_STRICT=1 node tools/probes.js  # exit 1 if any fail (for CI)
```

**Probes reporting `FAIL` describe bugs that are still open.** As each is fixed
the matching probe should flip to `PASS` — that makes this file the checklist.
Current state, from the July 2026 audit:

| id | finding | checks |
|---|---|---|
| F1 | scenario stimulus decays because setups don't set `nociceptionTarget` | 0/1 |
| F2 | opioid cover swamps the whole 0–10 stimulus scale | 0/2 |
| F3 | the LAST scenario self-cancels at 30 s and never reaches VT/VF | 0/1 |
| F4 | SpO₂ doesn't respond to hypoventilation (step function at MV 0.5 L/min) | 0/2 |
| F5 | SpO₂ floors at 70%; hypoxia has no haemodynamic consequence | 0/2 |
| F6 | pre-loaded autonomic tone is erased in ~2 s, so hypertensive scenarios never present | 0/2 |
| F7 | MH shows only rising etCO₂ — no tachycardia, no temperature model | 0/3 |
| F8 | three scenario setup lines are silent no-ops | 0/3 |
| F10 | scenario setups permanently mutate the shared `PROFILES` objects | 0/1 |
| F11 | `scenarioReset()` misses five drugs, which carry over | 0/1 |
| F12 | gauge ranges don't match the model limits behind them | 2/5 |
| F13 | gauges don't colour when the value falls dangerously low | 0/4 |
| F14 | opioid vagal drive pins parasympathetic tone at its clamp | 0/4 |

F14 is the v4.36 finding. The opioid vagal effect was a per-tick push on
`parasympTone`, which (against the `TONE_DECAY_TAU` blend) settles at 20× the
step and pinned the tone at its 1.0 clamp for any remifentanil above ~0.2
mcg/kg/min — a flat dose-response and a gauge stuck at danger. The probe checks
the dose-response climbs monotonically 0.2→0.5, a routine infusion leaves
headroom below the clamp, the opioid still causes sensible bradycardia, and a
vagal event still moves the tone on top of an opioid.

F13 is the v4.34 finding rather than an audit one. Its second check is the
interesting half: a threshold that fires on a sick patient is easy, but it must
also stay silent on a **well** patient of every profile, and a resting paed
cardiac output (3.2 L/min) or obese SVR tone (0.61) is far enough from the 70 kg
adult's that any hardcoded threshold flags one of them permanently.

### `voucher-probe.js` — the v4.33 entitlement system, end to end

Signs entitlement tokens with a throwaway ECDSA P-256 key exactly the way the
Supabase redeem function does, then drives the sim's real verification and
gating code in the sandbox: shipped-dormant behaviour, lock/unlock flips,
`pickScenario()` refusal, and rejection of expired / tampered / wrong-key /
garbage tokens. 15 checks; only `applyVoucher()`'s network fetch is out of
scope (the sandbox has no `fetch`, deliberately).

```bash
node tools/voucher-probe.js               # always exits 0
DL_STRICT=1 node tools/voucher-probe.js   # exit 1 on failure (for CI)
```

### `make-voucher-keys.js` — one-time key generation

Prints the voucher signing keypair (public JWK for `ENT_CONFIG` in
`index.html`, private PKCS8 for the `VOUCHER_SIGNING_KEY` Supabase secret) and
writes nothing to disk. See `supabase/README.md` for the full setup.

---

## Determinism

The physiology tick calls `Math.random()` in four places — the airway
reactivity roll, awareness event selection, the anaphylaxis bronchospasm
probability, and NIBP measurement error. Left alone, every run differs and you
cannot tell a real regression from noise.

The sandbox therefore supplies its own seeded `Math.random`, fixed by default,
so `sweep.js` produces a byte-identical `results.json` every time. To explore
the spread of stochastic outcomes instead, vary the seed:

```bash
DL_SEED=1 node tools/sweep.js && node tools/scan.js
DL_SEED=2 node tools/sweep.js && node tools/scan.js
```

In code, `boot({ seed: null })` restores real randomness.

---

## Writing your own check

```js
const { boot, give } = require('./tools/harness');

const sim = boot();                       // fresh sandbox, fixed seed
sim.dl.loadScenario('bronchospasm');
sim.advance(30_000);                      // 30 simulated seconds

give(sim.dl, 'salb', 0.25);               // salbutamol 250 mcg, as a click would
sim.advance(120_000);

console.log(sim.state.spo2, sim.state.tidalVolume);
console.log(sim.errors);                  // exceptions thrown inside the tick
```

`sim.dl` holds the simulator's published bindings — `state`, `CONFIG`,
`PROFILES`, `PK`, `SCENARIOS`, `drugDb`, `loadScenario`, `giveBolus`, `setInf`,
`setVentParam`, `setAirway`, `setVentMode`, `toggleEvent`, `calcMAP` and a few
more.

Two things to know about the sandbox:

- **Top-level `const`/`let` in `index.html` are not properties of the vm
  global.** To reach something not already exposed, add it to the `PUBLISH`
  list in `harness.js`. Each name goes through a `typeof` guard, so a name a
  given revision doesn't have is simply absent from `dl` — that matters because
  `DL_HTML` is meant to work against older copies, and publishing as one object
  literal made adding a binding throw a `ReferenceError` on every one of them.
- **`requestAnimationFrame` is a no-op**, so the waveform render loop never
  runs. Anything that only exists inside `animate()` won't be exercised here.

To read a parameter exactly as the Physiology tab displays it, go through the
gauge's own getter rather than reaching into `state`:

```js
const { gaugeSpecs, sampleGauges } = require('./tools/harness');
const specs = gaugeSpecs(sim.dl);
console.log(sampleGauges(specs));   // { circVol, preload, ..., bbBlock }
```
