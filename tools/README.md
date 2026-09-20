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

| F15 | myocardial ischaemia cannot be healed by any treatment | 0/4 |

F15 is the v4.37 finding. Coronary supply was diastolic pressure alone, so HR
only touched the demand side; slowing the heart cut demand and supply together
and imbalance never went negative, so the scenario's own recommended treatments
were inert. The fix adds a diastolic-time factor (`HR_REF/HR`) to supply. The
probe checks untreated builds and holds, sustained rate control heals and holds,
analgesia that leaves the heart fast does *not* heal, and — as a mechanism
check — that supply rises as HR falls at fixed DBP.

| F16 | salbutamol causes no tachycardia and barely bronchodilates | 0/4 |

F16 is the v4.38 finding. Both salbutamol effect terms divided `salbCe` by a
hardcoded `0.05` while the PK delivers a peak Ce ~37× lower, so both the
tachycardia and the bronchodilation ran ~37× too weak. The fix references both to
`SALB_CE_REF` (the real peak). The probe's first check is the key regression
guard — that `SALB_CE_REF` tracks the PK-delivered peak — plus a dose-dependent
tachycardia and a real drop in airway resistance.

| F17 | neostigmine / dexmedetomidine / magnesium too weak or inert | 0/5 |

F17 is the v4.39 batch from the salbutamol-class drug audit. Neostigmine
reversed nothing (coefficient ~200× too weak), dexmedetomidine was inert (a
2-min PK half-life starved the effect site) and had no UI slider, and magnesium
was a ~6× too weak bronchodilator. The probe checks neostigmine reverses a
partial but not a dense block (sugammadex reverses dense), a dex infusion via
`setInf()` causes bradycardia + sedation, and magnesium gives modest
bronchodilation weaker than salbutamol.

| F18 | anaphylaxis barely presents, and treating it made it worse | 0/13 |

F18 is the v4.43 finding, and the largest single-scenario one so far. Measured
against an identical run with the event forced off, the whole untreated reaction
was worth MAP -15.5, HR +5.5 and SpO2 -3.3 at its worst, then cleared itself by
145s and drifted up to MAP 107 — doing nothing was the winning strategy. Five
causes: a trap #1 per-tick push for the "sympathetic surge" (worth +2.2 bpm, and
because `alphaTone` raises SVR it *lifted* MAP by 5.5); a vasoplegia depth cut in
v3.75 and never re-measured after the model's baseline rose ~25 mmHg; no
capillary leak at all, while the scenario's own objectives taught volume
resuscitation; an adrenaline hook that advanced `anaphylaxisTimer` forward into
peak vasoplegia, so 100mcg at t=30s dropped MAP 86 → 70 within five seconds; and
a co-triggered bronchospasm reaching a quarter of the model's own severity that
then never resolved. The 13 checks pin each of those, plus the monotonicity of
the new adrenaline dose-response, that fluid given is *retained* (a floor-based
leak drained it straight back out), that the surge leaves headroom below
`BETA_CLAMP`, and an oscillation guard — `ANAPHYLAXIS_BRONCH_PROB` is 999, so
without a one-shot latch the new release path and the co-trigger flip the event
every tick until the heap dies.

| F19 | ischaemia never moves the BP, and its own treatment cannot heal it | 0/12 |

F19 is the v4.44 finding. The reported symptom was that the blood pressure never
falls even untreated, and it held up: `state.ischaemia` had exactly two consumers
in the whole model — the ECG morphology, and one contractility push-down capped at
0.20. MAP dipped 107 → 98 at t=74s and was back to 104 by t=600, ending *higher*
than its own trough, with cardiac output rising as the tachycardia compensated.
Three more findings came with it: the scenario never presented its briefed
"HR 105, BP 150/95" (SBP peaked at 139, while the event-off control reached
154/95 exactly — the briefing had been written against the non-ischaemic
haemodynamics); the score saturated at t=144s and then did nothing for seven and
a half minutes while the underlying imbalance went on climbing; and no
hint-derived plan could heal it. That last one was **not** a calibration problem
— esmolol is well calibrated and `ISCHAEMIA_HR_REF` is unchanged — but a bolus
wears off while the surgical stimulus does not, and hint 3 never said to repeat
it. **F15 had masked it since v4.37** by stacking two 50 mg boluses onto a
remifentanil rate of 0.5 at t=0: it proved the model *could* be healed while the
scenario's documented treatment left it pinned at 1.00. A cautionary example of a
probe that passes without testing the thing the scenario actually teaches.

| F20 | post-induction hypotension self-corrects in ten seconds | 0/8 |

F20 is the first of the v4.47+ six-scenario audit. The scenario's whole premise
did not exist: briefing and setupBrief promise "MAP sitting at 55 and not
improving", but MAP was 56 at t=1, 70 by t=10 and 83 by t=600. MAP 55 was a
startup transient - `scenarioReset()` snaps BP to the profile's `mapTarget`,
`alphaTone` starts at `ALPHA_REST`, and the tick drives it to its nociception-4
target over ~2s, so t=1 caught the trough on the way up. Objective 5's ">65
within 1-2 minutes" was met untreated at t=10, and the scenario's own
metaraminol + fluid then drove an already-recovered patient to MAP 108-118.
Fixed with nociception 4 -> 2, which is what objective 3 and the setup comment
both already claimed. The probe pins the pressure being a state rather than a
transient, the slow creep hint 5 promises, all four of objective 4's options
working, their speed ranking, the metaraminol-vs-ephedrine HR split, and that
the recommended management does not overshoot.

| F21 | haemorrhage bled at a constant rate, whatever the pressure | 0/9 |

F21 is the second of that audit, and the structural one. The tick drained
`p.bleedRate * dt` unconditionally, so a severe bleed was a fixed 25 mL/s tap
whether MAP was 95 or 22. That emptied the patient to the 0.5 L `centralVolume`
floor by t=130, but the real cost was the teaching: objective 2 ("the limits of
pressors without volume") and hints 4-5 are all about permissive hypotension,
and blood lost by t=300 was identical to two decimal places whether the trainee
held a mean MAP of 43 or of 76. Fixed by scaling the rate with MAP about
`BLEED_MAP_REF`, clamped to `BLEED_MAP_MIN_FRAC`..`BLEED_MAP_MAX_FRAC` - a named
severity is a rate *at a given pressure*, not a constant - with
`p.effectiveBleedRate` stored so the harness can integrate true loss. The same
scenario also failed to open at its briefed MAP 65 (61 for one tick, then a
climb to 74.7 by t=5), the same trap-1 startup transient F20 found; here the
nociception is correct, so the setup seeds `alphaTone`/`betaTone` at their
settled values instead of lowering the stimulus.

The probe pins the opening pressure and its direction, that an uncontrolled
bleed still produces profound shock, the monotonic blood-lost-vs-mean-MAP
ranking across three resuscitation plans, that resuscitating hard into an
uncontrolled bleed looks good at t=180 and fails by t=600, that early source
control plus volume holds, and that late rescue discriminates - source control
alone leaves MAP 22, fluid alone gives a transient that drains back out, only
the pair recovers.

| F22 | the septic patient woke up, and nothing in the scenario mentioned it | 0/12 |

F22 is the third of that audit and the first with **no physiology change at
all** — the model was right, the instructions were missing. The setup leaves
`vent.sevo = 0` and none of the three objectives mentioned anaesthesia, so a
trainee who did everything asked still watched BIS go 43 → 86. That wake then
caused an unannounced bronchospasm at t=431 (VT 450 → 67, etCO₂ 60 → 106) —
causation, not coincidence: sevo 1.5% from t=30 holds BIS at 33–41 and it never
fires. The septic profile's `airwayReactivity` 0.3 plus a light patient is
exactly what should spasm. Separately RR 14 × VT 450 could not hold etCO₂ at
`metabolicMultiplier` 1.5 (38 → 60 by t=420, before any spasm). Fixed with two
new objectives, four new hints, a corrected briefed BP (75/45 → the 70/43 it
actually holds), and sevo + RR added to sweep's `TREATMENTS`.

This is the probe class that guards **scenario text against the model**, which
is what CLAUDE.md's "scenario text is part of the model's contract" asks for —
several of its checks assert on `SCENARIOS.sepsis.objectives` and `.hints`
directly, so deleting the new text fails the probe. It also pins the causal
link (spasm fires untreated, never when anaesthetised), the trade-off that
makes objective 3 worth teaching (MAP 66 untreated vs 52 on sevo — if keeping
them asleep were free the objective would be empty), and that the full
recommended management now yields peak BIS 44, no spasm, etCO₂ 46 and MAP 92.

| F23 | severe bronchospasm relieved itself; briefed PIP 45 was mode-impossible | 0/12 |

F23 is the fourth of that audit and the one with the **widest blast radius —
it guards a global model change**. `bronchoRelaxFactor` credited the patient's
own reflex beta tone as bronchodilator relief, so an untreated "severe"
bronchospasm decayed from resistance 80 → 49 in under a minute (trapped gas
300 → 147 mL, Vt 128 → 192, MAP 66 → 92). That single decay made the briefed
Vt 150, objective 5 and hint 7 all unreachable. v4.43 had already rejected this
reasoning for anaphylaxis but scoped the fix to `anaphSurge`; v4.50 generalises
it to the whole endogenous `betaTarget` via `state.betaTargetEndo`.

**Every bronchospasm in the sim is now more severe** (bronchospasm 49 → 80,
sepsis 38 → 79, anaphylaxis 47 → 80, emergence 40 → 59, anaphBrewing 34 → 51,
aspiration 17 → 29 at t=600). So the probe deliberately pins **both halves**: a
refractory spasm must hold at 80 on ventilation alone, *and* sevoflurane,
salbutamol, ketamine, magnesium and adrenaline must each still work exactly as
before. If someone ever rewrites the discount against `betaTone` rather than
the endogenous target, the second half fails immediately.

It also pins the mode arithmetic — peak PIP stays under 32 in PCV at `pinsp`
20, and neither briefing text may claim 45 — that objective 1 teaches the
PCV/VCV split, and that gas trapping has a reachable haemodynamic cost (RR 8 →
autoPEEP 1.25 / MAP 93 vs RR 30 + pinsp 30 → autoPEEP 8.68 / MAP 75).

| F24 | the vagal scenario taught trainees to distrust atropine | 0/12 |

F24 closes the audit, and is the smallest — no physiology changed. The
best-calibrated presentation in the set (briefed HR ~48 / MAP ~50, measured
48.2 / 50.0, correctly not self-resolving over 30 minutes) was attached to a
hint that contradicted it: *"Atropine alone doesn't fix it"*. It does — 0.6 mg
with the event still running gives HR 79 / MAP 82 by t=180, **above** the
no-event control of 78/61.

The model turns out to be subtler than either the old hint or the complaint
against it: atropine works and then *stops* working (t=600 → 71/77, t=1200 →
48/50) because the stimulus is still applied, while release alone holds at
78/61 to t=1800. So objective 4 ("both source control AND pharmacology may be
needed") was right all along and only hint 4's phrasing was wrong. The probe
pins **both arms** — that atropine corrects, and that it then wears off — plus
the permanence of source control, the overshoot when both are done (peak HR
101), that hint 3 names a dose the cabinet actually offers, and that the dead
`VAGAL_DURATION` constant is gone.

It also serves as the **calibration target for a future refactor**: the vagal
block keeps a knowing instance of structural trap 2 (see CLAUDE.md), and this
probe's first two checks are what any retune has to reproduce.

| F25 | the emergence scenario never told anyone to take the tube out | 0/10 |

F25 closes the loop F22 opened — the emergence half of the same finding, and
the one v4.50 made urgent. The scenario fired an unannounced bronchospasm at
t=145, and after v4.50's global severity increase its *own* recommended plan
(sevo off, remi off, sugammadex) ended with an awake patient at SpO₂ 88.8,
etCO₂ 54.5 and MAP 133.

The physiology is right and rather good: the reactivity block fires on
`isLight && hasReactiveAirway && blunting > 0`, and this scenario builds
exactly that — consciousness 98 by t=100 with the tube still in. **Extubating
prevents it outright** (never fires at t=120, 180 or 240), while opioid cover
only delays it (t=292 → 407 → 448 as remifentanil goes up). The probe pins
both, because the second is what stops a trainee reaching for more opioid
instead of the laryngoscope.

Fixed in text only: new objective 5, seven new hints (the scenario had none),
a corrected briefing — the vaporiser sits at 0.4% and stays there, so "sevo
washing out" was false and BIS read a flat 80.2 for fifteen minutes — and
sweep's `TREATMENTS` now extubates to Mask and switches to Manual. The probe
also pins the post-extubation etCO₂ rise (peaks 79, settles to 54 as fentanyl
redistributes), which hint 6 warns about.

**Found while writing this probe, not fixed:** a patient with `airway: 'none'`
never breathes whatever their `respDrive`, because the ventilation block opens
with `if (disconnected || !hasAirwayDevice) { tidalVolume = 0 }` and
short-circuits the spontaneous branch. The LAST scenario is live on that path.
See CLAUDE.md's known items.

| F26 | the UI showed version 4.15 for thirty-seven releases | 0/5 |

F26 is the odd one out — not physiology, but the same failure shape. The About
modal carried a hardcoded `<div class="version">Version 4.15</div>` from v4.15
to v4.52, so anyone checking which build they had was told the wrong number.
It had already gone stale once and been hand-corrected (v3.78: *"Also corrects
the stale About-modal version"*), which is the tell: a literal buried in markup
that nobody passes on the way to a physiology change rots again however often
you fix it.

v4.53 made it `APP_VERSION` in a `[VERSION]` block, stamped into the modal at
startup. The probe anchors that constant to **the newest changelog banner** —
the right anchor because bumping it is the first convention in CLAUDE.md, so
it is the thing an author always touches. A forgotten constant now fails the
suite instead of shipping quietly.

Both failure modes were negative-tested and fail independently: drifting
`APP_VERSION` trips check 2 only; re-adding a literal to the About markup trips
check 4 only. `APP_VERSION` is published through `PUBLISH` in `harness.js` so
the probe reads the runtime value rather than re-parsing the file for it.

| F27 | no airway device meant apnoea; an arrested patient kept breathing | 0/10 |

F27 covers two bugs found one behind the other. The ventilation chain opened
`if (disconnected || !hasAirwayDevice) { tidalVolume = 0 }`, short-circuiting
the spontaneous branch — so a patient with no airway device never breathed
however strong their drive. (A second gate said the same independently: the FRC
oxygen refill was `if (p.airway !== 'none' && ...)`.) Live in **LAST**, whose
own objective says the patient is "breathing room air through an unprotected
airway" while they measured `respDrive` 0.78 and **Vt 0 from t=1**.

Fixing that immediately exposed the second: `respDrive` never read the
circulation, so the LAST patient sat in **VF at MAP 0 ventilating at RR 11, Vt
426, SpO₂ 99**. It had been masked by the first bug for exactly as long as both
existed.

The probe pins both, plus the boundary that keeps the fix honest: a device is
still required to *deliver* a breath (VCV with no airway gives PIP 0 and only
the patient's own tidal volume), room air applies whatever the FiO₂ dial says,
securing the tube takes `inspiredFiO2` 0.21 → 1.00, and ROSC restores the drive
because the cut-off is the pulse rather than a latch.

Worth noting what did **not** need changing: the display side was right all
along — etCO₂, RR, MAC, PIP and Vt already read `'--'` with no airway, alarms
already suppressed, waveforms already skipped. Losing the monitoring is what
happens when the circuit comes off; losing the physiology was the bug.

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
