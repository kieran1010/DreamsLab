# Dreams Lab / Synapse

An anaesthesia simulator for teaching. A patient monitor, a drug cabinet, a
ventilator and twenty clinical scenarios, driven by an integrated model of
cardiovascular, respiratory, neurological and pharmacological physiology.

Deployed to **synapse.hypnos.one** via GitHub Pages from `main`. **Pushing to
`main` deploys the live site** — there is no staging environment.

## The one structural fact

**Everything is in `index.html`.** ~11,400 lines: styles, markup and the entire
simulator in a single inline `<script>`. No build step, no bundler, no
dependencies, no framework. Open the file in a browser and it runs.

This is deliberate — the whole app is one artefact a teacher can save, email or
open offline. Do not introduce a build step, split the script into modules, or
add a dependency without asking. The exceptions: `tools/` (test harness) and
`supabase/` (voucher backend) never ship to the browser; `admin.html` is a
second self-contained page (voucher administration) that deploys alongside the
sim but is not part of it.

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
| `[PHYSIOLOGY TICK]` | 5486–7102 | **The model.** One 100 ms `setInterval` |
| `animate()` | 7124 | 60 fps waveform render, `requestAnimationFrame` |
| `[SCENARIOS]` | 8247 | The twenty scenarios, each `{name, briefing, objectives, hints, setup}` |
| `scenarioReset()` | 9512 | Clears state between scenarios |
| `loadScenario()` | 9642 | `scenarioReset()` → `setup()` → sync stimulus → briefing |
| `PHYS_GROUPS` | 10684 | The Physiology modal's gauges, and their ranges |
| `[ENTITLEMENTS]` | 11440 | v4.33 voucher gating: `ENT_CONFIG`, `PREMIUM_SCENARIOS`, offline token verify |

The voucher system (v4.33) **ships dormant**: with `ENT_CONFIG` empty nothing
is locked and its UI is hidden. Its gate lives in `pickScenario()` (UI), never
`loadScenario()`, so the harness can always drive every scenario. Backend setup
lives in `supabase/README.md`; keys come from `tools/make-voucher-keys.js`.

The tick is one long function, ordered: PK → bronchospasm → volume/preload →
autonomic tone → drug pushes → event blocks → baroreflex → tone clamps →
haemodynamics → ventilation → gas exchange → SpO₂ → etCO₂ → alarms. **Order
matters a lot** — see the traps below.

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
touched `[ENTITLEMENTS]` or `pickScenario()`. Current baseline: **probes 36/36,
voucher-probe 15/15, scan 0 BUG-level findings, 0 runtime errors.**
`tools/README.md` has the detail.

Two things to know before extending the harness:

- Top-level `const`/`let` in `index.html` are **not** properties of the vm
  global. To reach something new, add it to the `EPILOGUE` list in
  `harness.js`.
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

This independently broke three things: the aneurysm scenario's "massive
sympathetic surge" (gone in ~2 s), MH's tachycardia (a 0.04/tick push produced
~2 bpm), and the esmolol curve. **Sustained states must drive the targets** —
see `sahSurge`, `MH_BETA_DRIVE` and the beta-blockade term in `betaTarget`.

The subtler failure is a push that is *too strong*, not too weak: it settles at
`REST + k/0.05`, i.e. **20× the per-tick step**, and silently saturates against
the tone's clamp. The v4.36 finding — the opioids' vagal drive was a per-tick
push on `parasympTone`, so `PARASYMP_REMI_GAIN` 0.8 delivered 1.6 of tone and
pinned it at the 1.0 clamp for any remifentanil above ~0.2 mcg/kg/min, flattening
the dose-response and masking every other vagal drive. Fixed by building a
saturating `parasympTarget` (via `saturate()`) the tone relaxes toward, like
`alphaTarget`/`betaTarget`. `parasympTone` was the last autonomic tone still
driven by raw pushes; all three now use targets.

**2. Multiplying a tone per tick compounds.** `betaTone *= (1 - f)` at 10 Hz
against a 0.05 relaxation settles at `0.05·T·(1-f) / (0.05 + 0.95f)` of target —
so `f = 0.29` cut beta tone to **11%** of target, and even `f = 0.05` halved it.
Ask whether an effect belongs on the *target* or the *value*.

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

## Conventions

- **Changelog.** Each version gets an HTML comment block at the top of
  `index.html`, newest first: version, a short quoted title, then what changed
  and why. Bump the version when you change behaviour.
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

- The sepsis scenario's patient wakes (consciousness → 86) because nothing
  maintains anaesthesia and no objective tells the trainee to start it.
- Emergence and sepsis fire spontaneous bronchospasm their briefings never
  mention. The physiology is now coherent; whether they should fire it is a
  content decision.
- `state.mac` reads 0.00 for one tick after loading scenarios that set
  `etSevo` but not `mac`.
- The aneurysm scenario opens at ~170/105 rather than a textbook 200/110.
  Reaching 200 systolic would need `SVR_ALPHA_GAIN` raised globally, shifting
  every pressor in the sim; `SAH_SURGE_SVR` scales it locally if wanted.
- The Respiratory drive gauge (`'floor'`) reads danger for most of every case: a
  paralysed ventilated patient legitimately has no drive. Literally true,
  arguably noise. Left as-is in v4.34.
- Anaphylaxis only pushes SVR tone to ~0.72 of baseline, so it reads amber rather
  than red on its own; it takes a second vasodilator (tourniquet release, CO₂
  embolism) to reach the danger threshold. Same family as the aneurysm item — the
  vasodilatory pushdowns are modest, not the gauge.
