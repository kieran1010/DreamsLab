# Dreams Lab / Synapse

An anaesthesia simulator for teaching. A patient monitor, a drug cabinet, a
ventilator and twenty clinical scenarios, driven by an integrated model of
cardiovascular, respiratory, neurological and pharmacological physiology.

Deployed to **synapse.hypnos.one** via GitHub Pages from `main`. **Pushing to
`main` deploys the live site** — there is no staging environment.

## The one structural fact

**Everything is in `index.html`.** ~15,500 lines: styles, markup and the entire
simulator in a single inline `<script>`. No build step, no bundler, no
dependencies, no framework. Open the file in a browser and it runs — with one
exception, the Resources tab, below.

This is deliberate — the whole app is one artefact a teacher can save, email or
open offline. Do not introduce a build step, split the script into modules, or
add a dependency without asking. The exceptions: `tools/` (test harness) and
`supabase/` (voucher backend) never ship to the browser; `admin.html` is a
second self-contained page (voucher administration) that deploys alongside the
sim but is not part of it; `resources/` (v4.40, reworked v4.41) holds static
files — PDFs and the like — plus `manifest.json`, the data behind the
Resources tab (see `resources/README.md`). Unlike `tools/`/`supabase/`, these
*do* ship, and unlike everything else here they knowingly give up a slice of
the "one artefact" guarantee: `index.html` fetches `manifest.json` at runtime
on every open of the Resources modal (so a new resource shows up without
redeploying `index.html` at all) rather than embedding the list, and `fetch()`
of a same-origin file fails outright under `file://` — verified, not
theoretical. So opening `index.html` by double-click runs the whole sim
normally, but the Resources tab itself shows a "couldn't load" message rather
than its list. Everything else stays fully offline-capable. Accepted tradeoff,
not an oversight.

## Where things are in index.html

Line numbers drift with edits; the `[SECTION]` banner comments are the reliable
anchors. Grep for `[CONFIG]`, `[PHYSIOLOGY TICK]`, `[SCENARIOS]` and so on.

| Region | Roughly | What it is |
|---|---|---|
| Changelog | 50–1700 | One HTML comment block per version, newest first |
| `[STYLES]` | 1700–4200 | All CSS |
| `[CONFIG]` | 4200–4720 | Every tunable constant. Start here for calibration |
| `[PROFILES]` | 4727 | Patient presets (adult, paed, elderly, obese, sepsis) |
| `[PK MODEL]` | 4865 | Per-drug `vd` / `k10` / `ke0` |
| `state` | 4904 | The single mutable state object |
| `[DRUG DB]` | 5188 | Bolus library; drives the drug buttons |
| `[PHYSIOLOGY TICK]` | 5486–7102 | **The model.** `physiologyTick()`, on a 100 ms `setInterval`. Named since v4.57 so `loadScenario()` can pre-roll it |
| `animate()` | 7124 | 60 fps waveform render, `requestAnimationFrame` |
| `[SCENARIOS]` | 8247 | The twenty scenarios, each `{name, briefing, objectives, hints, setup}` |
| `scenarioReset()` | 9512 | Clears state between scenarios |
| `loadScenario()` | 9642 | `scenarioReset()` → `setup()` → sync stimulus → briefing |
| `PHYS_GROUPS` | 10684 | The Physiology modal's gauges, and their ranges |
| `[ENTITLEMENTS]` | 11440 | v4.33 voucher gating (live v4.42): `ENT_CONFIG`, `PREMIUM_SCENARIOS`, offline token verify |
| `[RESOURCES]` | 11910 | v4.40/v4.41 Resources tab: fetches `resources/manifest.json` at runtime |

The voucher system (v4.33) **is live as of v4.42**: `ENT_CONFIG` carries this
deployment's real `redeemUrl` and `publicKeyJwk`, so `PREMIUM_SCENARIOS`
(`tiva`, `sepsis`, `haemorrhage`, `bronchospasm`, `anaphylaxis`, `aspiration`,
`ischaemia`, `pulmEmbolism` - a content decision, edit freely) are genuinely
locked behind a voucher. It shipped dormant from v4.33 through v4.41 specifically
so it could be merged and deployed safely before the backend existed - with
`ENT_CONFIG` empty nothing is locked and its UI is hidden, which
`tools/voucher-probe.js`'s first check still covers (by explicitly re-emptying
`ENT_CONFIG`, since the committed config is no longer empty). The gate lives
in `pickScenario()` (UI), never `loadScenario()`, so the harness can always
drive every scenario regardless. Backend setup lives in `supabase/README.md`;
keys come from `tools/make-voucher-keys.js`. The `redeem` Edge Function itself
was deployed via the Supabase dashboard's Edge Functions editor, not the CLI -
see `supabase/README.md` for that path too.

The tick is one long function, ordered: PK → **anaphylaxis envelopes** →
bronchospasm → volume/preload → autonomic tone → drug pushes → event blocks →
baroreflex → tone clamps → haemodynamics → ventilation → gas exchange → SpO₂ →
etCO₂ → alarms. **Order matters a lot** — see the traps below.

The anaphylaxis envelopes (v4.43) sit deliberately out of order, near the top
rather than with the other event blocks, because everything that consumes the
reaction — the bronchospasm hysteresis, the capillary leak, the autonomic
targets, the SVR formula, the HR calculation — is downstream of that point.
`state.anaphSeverity` is one 0..1 number all of them read, like `mhSeverity`.
Only the bronchospasm co-trigger and release stayed with the event blocks.

**A score and its consequence are not the same number.** v4.44 split
`state.ischaemiaStun` out of `state.ischaemia`: the score drives the ECG
immediately, the stun follows it over `ISCHAEMIA_STUN_TAU` and is what drives
contractility. They were one number until then, so the stunned myocardium
arrived at the same instant as the ST depression and blunted the scenario's own
presentation from t=0. Ask, for any new pathology, whether the *sign* and the
*consequence* should share a clock.

## Testing

`tools/` runs the real simulator headlessly in a Node `vm` sandbox with a
stubbed DOM and a virtual clock. `index.html` is not modified or duplicated;
the actual `CONFIG`, `PK`, `SCENARIOS` and tick execute as they do in a browser.

```bash
node tools/sweep.js     # all 20 scenarios, untreated + treated  (~2 min)
node tools/scan.js      # flag anomalies in what sweep recorded
node tools/probes.js    # one targeted check per known bug
node tools/voucher-probe.js         # entitlement sign/verify/gating, offline
node tools/trace.js bronchospasm    # full parameter table for one scenario
```

Run sweep/scan/probes after any model change; run voucher-probe too if you
touched `[ENTITLEMENTS]` or `pickScenario()`. Current baseline: **probes 173/173,
voucher-probe 15/15, scan 0 BUG-level findings, 0 runtime errors.**

`sweep.js` shifts every treatment plan by `ONSET_LEAD_IN` (see `planFor()`), so
the treated runs treat a pathology that has actually declared. `induction` is
exempt — nothing is wrong with that patient.
`tools/README.md` has the detail.

**CI runs all four on every pull request, and on pushes to `main`** —
`.github/workflows/physiology.yml`, added v4.57. (Both triggers, rather than a
bare `push`: a bare one fires alongside `pull_request` on any branch with a PR
open, which ran the suite twice per push. Confirmed on the workflow's own first
run.) It takes about two minutes, and `concurrency` cancels a superseded run. Nothing to install: no build
step, no dependencies, just Node 20. All four honour `DL_STRICT=1` to exit
non-zero (`scan` gates on BUG-level findings only; `CLIN`/`WARN`/`INFO`
describe sick patients behaving correctly, and gating on those would require
the patients to be well for the build to go green). The workflow does not
deploy — Pages publishes from `main` separately.

What CI does **not** cover is worth knowing. The render path is invisible to it
for the reason below. And nothing asserts that a scenario still uses the
anaesthetic its own text describes: during v4.57 a scripted edit aimed at
`asthma` silently changed `maintenance`'s sevoflurane from 2% to 0.8%, and it
was caught by reading the diff, not by a probe. Green CI means no *known*
regression, not a correct scenario.

Two things to know before extending the harness:

- Top-level `const`/`let` in `index.html` are **not** properties of the vm
  global. To reach something new, add it to the `PUBLISH` list in
  `harness.js` (which builds the `EPILOGUE`). `APP_VERSION` was added this way
  in v4.53.
- `requestAnimationFrame` is a no-op, so `animate()` never runs. **Nothing in
  the render path is covered** — verify waveform and canvas changes in a
  browser.

The tick calls `Math.random()` in four places, so the sandbox supplies a seeded
generator (`DL_SEED`). `sweep.js` output is byte-identical between runs, which
is what makes it usable as a regression check. Use `boot({ seed: null })` for
real randomness.

## Structural traps

These caused most of the defects found in the v4.29 audit. Each one is silent —
nothing throws, the number just quietly ends up wrong.

**1. `TONE_DECAY_TAU` is a per-tick blend factor, not a time constant in
seconds.** It is 0.05, applied at 10 Hz, so tones converge on their targets in
about two seconds. Any code that *assigns* `alphaTone`/`betaTone`/
`parasympTone`, or pushes them a little each tick, is fighting a relaxation that
wins. A per-tick push of `k` settles only `k/0.05` above target.

This independently broke four things: the aneurysm scenario's "massive
sympathetic surge" (gone in ~2 s), MH's tachycardia (a 0.04/tick push produced
~2 bpm), the esmolol curve, and — found in v4.43, having survived the v4.29 sweep
— anaphylaxis's catecholamine surge, a 0.03/tick push on both `alphaTone` and
`betaTone` that delivered +0.046 of tone, i.e. +2.2 bpm. That one had a second
sting: because `alphaTone` raises SVR, the reaction's opening act *lifted* MAP by
5.5 mmHg, so the patient looked better as the anaphylaxis began.
**Sustained states must drive the targets** — see `sahSurge`, `MH_BETA_DRIVE`,
`ANAPHYLAXIS_SYMP_BETA` and the beta-blockade term in `betaTarget`.

The subtler failure is a push that is *too strong*, not too weak: it settles at
`REST + k/0.05`, i.e. **20× the per-tick step**, and silently saturates against
the tone's clamp. The v4.36 finding — the opioids' vagal drive was a per-tick
push on `parasympTone`, so `PARASYMP_REMI_GAIN` 0.8 delivered 1.6 of tone and
pinned it at the 1.0 clamp for any remifentanil above ~0.2 mcg/kg/min, flattening
the dose-response and masking every other vagal drive. Fixed by building a
saturating `parasympTarget` (via `saturate()`) the tone relaxes toward, like
`alphaTarget`/`betaTarget`. `parasympTone` was the last autonomic tone still
driven by raw pushes; all three now use targets.

**1b. A patient's own reflex catecholamines must not treat their own
pathology.** `bronchoRelaxFactor` credited raw `betaTone` as bronchodilator
relief, so a bronchospasm's own stress response bronchodilated the patient and
every spasm in the sim quietly self-relieved (the scenario went resistance
80 → 49, Vt 128 → 192, MAP 66 → 92 in under a minute, untreated). v4.43 spotted
this for anaphylaxis and subtracted `anaphSurge` specifically; v4.50 generalised
it. The threshold is now `state.betaTargetEndo` — the previous tick's
`betaTarget`, which is built only from endogenous drives — so only drug-driven
beta *above* that target relieves anything. Adrenaline, ephedrine,
noradrenaline, ketamine and salbutamol all push `betaTone` after the relaxation,
so they are unaffected; the patient's own reflex is. Ask this of any new
pathology whose own response feeds a term that treats it.

**1c. A gate that means "cannot be measured" is not the same as "is not
happening".** The ventilation chain opened `if (disconnected || !hasAirwayDevice)
{ tidalVolume = 0 }` under the comment "no effective ventilation path", which
short-circuited the spontaneous branch below — so for years a patient with no
airway device never breathed whatever their respiratory drive (v4.54). The
display side had it right all along: `etCO2`, RR, MAC, PIP and Vt already read
`'--'` with no airway, their alarms were already suppressed, and the PAW/CO₂
waveforms were already skipped. Losing the *monitoring* is what happens when you
take the circuit away; losing the *physiology* is a different claim, and the
model should keep simulating what it cannot show you.

**2. Multiplying a tone per tick compounds.** `betaTone *= (1 - f)` at 10 Hz
against a 0.05 relaxation settles at `0.05·T·(1-f) / (0.05 + 0.95f)` of target —
so `f = 0.29` cut beta tone to **11%** of target, and even `f = 0.05` halved it.
Ask whether an effect belongs on the *target* or the *value*.

One instance survives on purpose: the vagal block's
`betaTone *= (1 - sympWithdraw * dt)`. `VAGAL_SYMP_WITHDRAW` 1.8 gives `f = 0.18`
and therefore about 18.5% of target (measured 0.057 against 0.262, 22%) — so the
constant delivers roughly a fifth of its nominal value and does not mean what its
name says. It is left alone because it was tuned *through* the compounding to land
HR ~48 / MAP ~50, exactly what that scenario's briefing promises. v4.51 documented
it at the line rather than refactoring; probe F24 pins the presentation if anyone
does. Do not "fix" it without retuning to those numbers.

**3. Scenario setups can assign state the tick immediately overwrites.**
`state.nociception` without `nociceptionTarget` was the worst case: the tick
eases nociception toward the target, which `scenarioReset()` had just zeroed, so
15 of 20 scenarios lost their surgical stimulus within ten seconds — while
`syncScenarioUI()` went on displaying the intended value on the header slider.
`loadScenario()` now syncs the target centrally, so setups only set
`state.nociception`.

**4. Post-clamp writes.** The tone clamps sit mid-tick, but cough, movement and
hypoxia blocks run after them. There is now a second clamp at the end of the
tick so stored state is never out of range when the gauges read it. If you add
an event block that touches tones, put it before that final clamp or rely on it.

**5. `state.machine.pumps.<drug>` is a number.** `pumps.remi.rate = 0.08` is a
silent no-op in non-strict mode — two scenarios ran with no infusion for months.
Assign `state.machine.pumps.remi = 0.08` directly (and seed `Cp`/`Ce` if the
scenario represents a steady state), or call `setInf()`.

**6. `state.etco2` is lowercase.** `state.etCO2` creates a dead property.

**7. `PROFILES` entries used to be handed out by reference.** `setProfile()` now
copies, so a scenario may safely tweak `state.profile`. Do not reintroduce the
alias.

**8. Gauge ranges and thresholds must resolve from the constants the model uses.**
`PHYS_GROUPS` `min`/`max`/`base` and the v4.34 `warnLow`/`dangerLow`/`warnHigh`/
`dangerHigh` all accept functions for exactly this. Hardcoding a number that
disagrees miscalibrates the bar fill, can make a colour literally unreachable,
and — the v4.34 finding — can make it permanently *reached* for a patient whose
normal is not the 70 kg adult's. A threshold has to pass both halves: fire on a
sick patient, stay silent on a well 20 kg child *and* a well 130 kg adult. Probe
F13 checks both halves for every profile.

**9. A fraction-of-span colour rule assumes the resting value sits at one end.**
`'ceiling'` and `'floor'` are shorthands for "dangerous at the top/bottom of the
bar". They are wrong for any variable whose danger sits mid-span (circulating
volume, cardiac output — hence `'band'` plus explicit thresholds), and they break
silently when a per-profile `max` is pulled down close to `base`: the elderly and
sepsis `preloadCeiling`s put the 75% mark *below* the baseline, so a euvolaemic
patient's gauge read amber. `physStatus()` now re-measures the ceiling rule
against the headroom above `base` when that happens, but prefer explicit
thresholds for anything where the resting value is not near an end.

**10. A scenario that opens at its final presentation has no onset to teach.**
Before v4.57 each scenario started its pathology whenever its own `setup()`
happened to. `bronchospasm` assigned `p.bronchResistance = 80`, so SpO₂ read 86
and Vt 127 *before the first tick ran*; `last` sat flat for 60 s and then
stepped MAP 98 → 0 in one tick; `asthma` promised a bronchospasm and produced
none in thirty minutes. The spread was 0–60 s with nothing deciding it.

There is now one contract, in `[CONFIG]`: `ONSET_LEAD_IN` (20 s of the
patient's own normal) then `ONSET_TAU` (25 s first-order build). Use
`onsetGate()` for a pathology that already has a first-order build downstream —
gate its *target* and the existing lag gives you the ramp — and `onsetRamp()`
where the severity *is* the number everything reads. Both reach 1, so settled
presentations are unaffected.

`ONSET_TAU` is a default, not a rule. A pathology with a clinically dictated
rate keeps it and takes only the lead-in — MH still ramps over three minutes.
What is shared is the moment things start.

**Use `onsetRampFor(evt)` / `onsetGateFor(evt)`, not the bare form, for anything
driven by an event flag.** The window belongs to the scenario, never the user:
`state.onsetArmed` records what `setup()` armed and `toggleEvent()` drops an
event from it. Get this wrong and the window reaches into every probe and every
Events-panel toggle — it did, and F15/F16/F17/F23 all measured a hand-toggled
bronchospasm at resistance 12 instead of 80.

**11. A lead-in is worthless if the first ten seconds are a loading artefact.**
`scenarioReset()` leaves the tones at rest and the tick then relaxes them to
target (~2 s), equilibrates preload (`TAU_FLUID_BUFFER` 30 s) and settles the
stimulus lag. Measured, 8–12 s, during which MAP moved 16 mmHg in `maintenance`
and 28 in `bronchospasm`. `loadScenario()` now pre-rolls `physiologyTick()` for
`ONSET_SETTLE` (12 s) with `log()` silenced, then zeroes both clocks.

**The pre-roll must run *after* the v4.29 nociception sync.** Placed next to
`setup()` it drives the surgical stimulus to zero — the tick eases nociception
toward a target `scenarioReset()` has just zeroed — and the sync then copies the
zero back into the target. That is structural trap 3 reintroduced by the fix for
a different problem, and it cost `maintenance` 32 mmHg. `ONSET_SETTLE` must also
stay below `ONSET_LEAD_IN`, or the pathology starts during the pre-roll; F29
checks it.

**12. A seeded drug level that is not its infusion's steady state makes the
scenario drift.** v4.56 found ten scenarios seeding remifentanil 2–3× what their
own pump sustains, from a guessed reference line; `maintenance` ran MAP 62 → 89
over ten untreated minutes as it washed out. v4.57 found the same thing in that
scenario's induction fentanyl and rocuronium, seeded fresh in a case whose own
text says "30 minutes since induction". Derive the value:

```
remiCe_ss = rate / (70 * vdScale)     rate in mcg/kg/min
propCe_ss = rate / (3.6 * vdScale)    rate in mg/kg/hr
```

both independent of weight. For a bolus that is *supposed* to be decaying, seed
it and say so.

## Conventions

- **Changelog.** Each version gets an HTML comment block at the top of
  `index.html`, newest first: version, a short quoted title, then what changed
  and why. Bump the version when you change behaviour — **and bump
  `APP_VERSION` in the `[VERSION]` block with it.** That constant is what the
  About modal displays; probe F26 asserts it equals the newest changelog
  banner, so forgetting it fails the suite. (It is a constant because the
  modal's hardcoded literal sat at "Version 4.15" for thirty-seven releases,
  having already been hand-corrected once in v3.78.)
- **Inline comments carry the reasoning.** The codebase explains *why* a
  constant has its value and what was tried before — `// v3.37: 0.59->0.97
  (revert v3.36); calibrated for resting MAP 90`. Match that. When changing a
  tuned constant, say what it was, what it is, and what the old value did wrong.
- **Physiology is deliberately simplified** for teaching. Clinical plausibility
  in the ranges that matter to a trainee beats textbook completeness.
- **Scenario text is part of the model's contract.** If a briefing says BP
  200/110 or "SpO₂ starting to fall", the sim must actually do that. When they
  disagree, fix one or the other — do not leave them inconsistent.

## Known open items

- **The eye-opening alarm is gated on intent, not just depth** (v4.58). It
  fires only when a hypnotic is actually acting (`consciousness` below
  `CONFIG.BIS_BASE`) **or** there is surgical stimulus. An awake undrugged
  patient with nothing being done to them gets the event and the log entry but
  no alarm — the sim used to shriek at the `induction` scenario's own opening
  state, which trains students to ignore the one alarm that should never be
  ignored. If you add another hypnotic, make sure it feeds the BIS `pushDown`
  term, or the gate will read your anaesthetised patient as merely awake.

- **Three scenarios cannot hold their etCO₂, independent of any pathology.**
  Found during the v4.57 onset audit and deliberately not fixed, because it is
  a ventilation-calibration question rather than an onset one. With the
  pathology gated off entirely, `paedLap` runs etCO₂ 38 → 122, `aspiration`
  38 → 113 and `pulmEmbolism` 38 → 22: the seeded 38 is nowhere near what each
  scenario's own minute ventilation produces, so etCO₂ moves by tens of mmHg
  from the first tick whatever else is happening. `ONSET_SETTLE`'s 12 s cannot
  absorb it — etCO₂'s time constant is minutes — and it must stay under
  `ONSET_LEAD_IN` anyway. paedLap and aspiration are both spontaneously
  ventilating at a tidal volume the model reads as severe hypoventilation
  (Vt 102 in a 20 kg child, 142 in a 70 kg adult), which is the real finding.
  Probe F29 therefore excludes etCO₂ from its lead-in check and says why.
  Same family as v4.56's remifentanil seeds: a seeded value that is not a
  steady state.
- **`paedLap` promises a desaturation it never produces.** Its briefing says
  "Watch the SpO₂ — small reserve" and SpO₂ holds 99 for thirty untreated
  minutes while etCO₂ climbs to 129. The claim is presumably about what happens
  if the trainee stops the patient breathing, which is a different thing from
  what the briefing appears to say. Not touched in v4.57; a content decision,
  and tangled with the etCO₂ item above.
- **`asthma` lands milder than its name.** v4.57 made it actually produce the
  bronchospasm it always advertised, but with 1 MAC of sevoflurane on board
  `bronchoRelaxFactor` caps it at resistance 22 of a possible 80 — PIP 12 → 20,
  SpO₂ 99 → 96. That is pharmacologically correct and is now taught explicitly
  (objective 2, hints 2 and 3, contrasting it with the TIVA-background
  bronchospasm scenario), but "Acute severe asthma" still overpromises. The
  lever would be reducing the scenario's background sevo, which changes what
  the scenario is about. Left as a content decision.
- **`p.airwayReactivity` does not scale spasm severity.** It drives
  `reactivityRisk`, i.e. how likely a spasm is to be *triggered*, and nothing
  reads it in the `bronchTarget` formula. So the asthma scenario's elevated 1.6
  makes its patient more likely to spasm but not more severely — which is why
  arming the event was the fix rather than raising reactivity. Defensible, but
  the constant does not mean what its name suggests.

- **The model has no perfusion-driven arrest pathway.** An exsanguinated
  patient asymptotes at MAP ~22 with a cardiac output of ~1.1 L/min and stays
  there indefinitely; the haemorrhage scenario runs its full 30 minutes without
  the patient ever arresting. Only two pathways move `state.rhythm` on their
  own - the LAST progression (sinus -> VT pulseless -> VF) and the hypoxic
  arrest at `HYPOXIA_ARREST_SPO2` - and neither reads perfusion. The second
  cannot rescue the first here: `state.spo2` is still 99 at MAP 22 and a
  cardiac output of 1.1 L/min, so the hypoxia branch never arms. **v4.55 did
  not change this.** That version made the oximeter lose its *trace* in low
  output, which is a display and alarm change; the underlying `state.spo2` the
  hypoxia branch reads is deliberately untouched, because arterial saturation
  really is preserved in low output. Surfaced by the v4.48 haemorrhage audit;
  left as-is deliberately, since an arrest pathway is a sizeable piece of
  physiology and every other teaching point in that scenario lands well before
  the patient would arrest.
- **Resolved in v4.55, with etCO2.** `state.perfusionFactor` (this patient's
  cardiac output against their own baseline, flat above `PERFUSION_CO_REF_FRAC`
  0.40 and ramping to 0 at no output) now drives both the oximeter's trace
  validity and the etCO2 target. The oximeter **loses its trace** rather than
  reading a false low, because arterial saturation really is preserved in low
  output and it is the measurement that fails — so the display and alarm gate
  on `spo2TraceValid` while `state.spo2` keeps being computed. etCO2 collapses
  in arrest instead of climbing, which makes the ROSC rise teachable. The 0.40
  threshold was measured across all forty sweep runs: only LAST (0%) and
  haemorrhage (18%) fall below it, while vagal (49%) and rate-controlled
  ischaemia (53%) stay untouched. Probe F28 pins both halves *and* that
  boundary — it fails first if anyone raises the threshold.
- **etCO2's low-output coupling is a steady-state simplification.** The real
  etCO2–cardiac-output relationship is *acute*: etCO2 dips sharply when output
  falls and then largely recovers, because all the CO₂ produced must still be
  excreted — what changes is the arterial-venous gradient, not steady-state
  excretion. v4.55 deliberately uses a flat-above-40% curve rather than a linear
  proportionality for that reason (a linear term would also have cost sepsis its
  v4.49 etCO2 38 → 60 teaching, since it sits at 58% of baseline CO). Modelling
  the transient properly needs a second state variable for venous CO₂ content.
- **The pleth waveform and the SpO2 number gate on different things.** The
  waveform uses `hasPulse() && state.sys > 50` (perfusion *pressure* at the
  probe); the number uses the v4.55 CO-based factor (global *flow*). They agree
  everywhere except `anaphBrewing` untreated, where 104 of 121 samples show a
  flat trace from low pressure while cardiac output is preserved at 70% of
  baseline — so the trace is flat while the number reads normally. Pre-existing
  on the waveform side, and left alone because it is a render-path edit and
  `requestAnimationFrame` is a no-op in the harness, so a change there cannot be
  verified headlessly.

- **Resolved in v4.49 for sepsis.** The sepsis patient still wakes if left
  alone (consciousness → 86 by t=600) and the wake still triggers a
  bronchospasm at t=431, but both are now covered by the scenario's own
  objectives and hints rather than being unannounced. The physiology was never
  the bug: the septic profile's `airwayReactivity` 0.3 plus a light patient is
  exactly what should spasm, and sevo 1.5% from t=30 prevents both. Text-only
  fix — new objectives 3 and 4, four new hints, and sweep's `TREATMENTS` now
  starts sevo and raises RR.
- **Resolved in v4.52 for emergence**, completing the item v4.49 answered for
  sepsis. The spasm still fires if the tube is left in, but the scenario now
  says so: new objective 5, seven new hints (it had none), and sweep's
  `TREATMENTS` extubates. The finding was that **extubating prevents it
  outright** at any timing, while opioid cover only delays it (t=292 → 407 →
  448 as remi goes up) — there is no dose that holds it off with the tube in.
- **Fixed in v4.54.** A patient with no airway device now breathes room air
  for themselves, and an arrested patient stops breathing. Both were live in
  the LAST scenario. Mechanical and manual delivery still require a device;
  a disconnected circuit still stops everything. `p.inspiredFiO2` is what the
  patient inhales (0.21 with no device) as against `p.fio2`, the dial setting.
  Probe F27 pins both halves.
- **Resolved in v4.57.** The LAST scenario's `description` promised
  "seizure-like activity (brief BIS spike)" and there was no spike — BIS sat
  flat at 69–71 all run. The CNS phase was a per-tick push on `betaTone`
  (structural trap 1) that delivered nothing measurable, so the scenario was
  sixty flat seconds followed by a single-tick step to arrest. It now drives
  `alphaTarget`/`betaTarget` and a BIS excursion off `state.lastCnsSeverity`
  (`LAST_CNS_BETA`/`ALPHA`/`BIS_SPIKE`): HR 81 → 96, MAP 90 → 120, BIS 69 → 92
  over ~100 s before `LAST_ARREST_TIME` (60 → 120).
- **Six of twenty scenarios have no `hints` array at all**: `anaphBrewing`,
  `paedLap`, `aneurysm`, `autonomicDysreflexia`, `last` and `mh`. (It was
  eight; emergence was the eighth until v4.52, asthma the seventh until v4.57.
  `maintenance` has only two, which is thin but not empty.) Not a bug, but the hints are where a
  scenario's teaching actually lives — every text-vs-model finding in the
  September 2026 audit came from reading objectives and hints against measured
  behaviour, and a scenario without them cannot be checked that way.
- `state.mac` reads 0.00 for one tick after loading scenarios that set
  `etSevo` but not `mac`.
- The aneurysm scenario opens at ~170/105 rather than a textbook 200/110.
  Reaching 200 systolic would need `SVR_ALPHA_GAIN` raised globally, shifting
  every pressor in the sim; `SAH_SURGE_SVR` scales it locally if wanted.
- The Respiratory drive gauge (`'floor'`) reads danger for most of every case: a
  paralysed ventilated patient legitimately has no drive. Literally true,
  arguably noise. Left as-is in v4.34.
- Repeated adrenaline boluses overshoot: five 100mcg doses in the anaphylaxis
  scenario peak MAP at 180 with `alphaTone` and `betaTone` pinned at their 1.4
  clamps for minutes. This is adrenaline's own calibration, not the scenario's —
  100mcg IV in a stable maintenance patient takes MAP 66 → 152 — so retuning it
  would move every pressor in the sim. Same family as the aneurysm and
  salbutamol items.
- `anaphBrewing` shares the anaphylaxis event, so v4.43's deeper reaction applies
  there too, but its baseline is already MAP 53 (sevo 1.0 MAC + remifentanil
  maintenance) and it now bottoms out near 32 rather than 38. The reaction behaves
  identically in both scenarios; what differs is that scenario's starting
  pressure, which its own briefing calls "currently stable". A content decision:
  either lift its baseline or accept it as the harder of the two.
- **FiO₂ cannot improve SpO₂ anywhere in the model.** `spo2Ceiling` is built from
  the shunt terms only, and FiO₂ enters the SpO₂ block solely through the
  `effectiveAlveolarFiO2 >= SPO2_DESAT_THRESHOLD_FIO2` (0.13) branch — i.e. only
  under near-apnoea. Verified: FiO₂ 1.0 and FiO₂ 0.21 give identical SpO₂ (90.1)
  in the bronchospasm scenario. Defensible as a simplification, but it silently
  removes the first lever a trainee reaches for in any desaturation.
- In the ischaemia scenario's **treated** run `alphaTone` pins at its 1.4 clamp
  from ~t=120 onward (97 of 120 samples). Rate control to HR 65 plus a stunned
  myocardium puts MAP in the 60s against the elderly profile's `mapTarget` of 95,
  and the baroreflex answers maximally. Coherent, but a *second* pressor dose late
  in that case does nothing — the first, given before the tone pins, is what earns
  objective 4's improvement. The global `ALPHA_CLAMP` limit, not a scenario bug.
- The ischaemia scenario still cannot reach frank cardiogenic shock or an
  arrhythmia: the untreated fall stops where `ischaemiaStun` saturates (BP ~118/72,
  MAP ~91 from a 149/92 opening). Objective 1 names cardiogenic shock as the severe
  presentation, so v4.44 narrowed that gap without closing it.
  `ISCHAEMIA_CONTR_DROP` is the single constant that sets the depth.
- The haemorrhage bleed rate scales with MAP (v4.48) between
  `BLEED_MAP_MIN_FRAC` and `BLEED_MAP_MAX_FRAC` of nominal about
  `BLEED_MAP_REF` 75. The floor means a bleed never quite stops, so an
  untreated severe bleed still reaches the 0.5 L `centralVolume` floor - at
  t~190 rather than the old t=130. That floor is what the no-arrest item above
  is standing in for; the bleed itself is no longer inert, since late fluid,
  late source control and the two together all give measurably different
  outcomes from it.
- Salbutamol (v4.38) raises MAP ~+15-18 at 250mcg where real salbutamol is
  roughly BP-neutral. `betaTone` drives contractility as well as HR, so creating
  the tachycardia unavoidably adds inotropy; the beta2 vasodilation term
  (`SALB_VASODIL_GAIN`) only partially offsets it because `alphaTone` floors at 0
  and the baroreflex defends MAP. Accepted simplification — the model can't
  decouple chronotropy from inotropy through a single tone.
