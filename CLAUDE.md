# Dreams Lab / Synapse

An anaesthesia simulator for teaching. A patient monitor, a drug cabinet, a
ventilator and twenty clinical scenarios, driven by an integrated model of
cardiovascular, respiratory, neurological and pharmacological physiology.

Deployed to **synapse.hypnos.one** via GitHub Pages from `main`. **Pushing to
`main` deploys the live site** — there is no staging environment.

## The one structural fact

**Everything is in `index.html`.** ~13,400 lines: styles, markup and the entire
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
| `[PHYSIOLOGY TICK]` | 5486–7102 | **The model.** One 100 ms `setInterval` |
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
touched `[ENTITLEMENTS]` or `pickScenario()`. Current baseline: **probes 123/123,
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

- **The model has no perfusion-driven arrest pathway.** An exsanguinated
  patient asymptotes at MAP ~22 with a cardiac output of ~1.1 L/min and stays
  there indefinitely; the haemorrhage scenario runs its full 30 minutes without
  the patient ever arresting. Only two pathways move `state.rhythm` on their
  own - the LAST progression (sinus -> VT pulseless -> VF) and the hypoxic
  arrest at `HYPOXIA_ARREST_SPO2` - and neither reads perfusion. The second
  cannot rescue the first here, because of the SpO2 item below: at MAP 22 and
  a cardiac output of 1.1 L/min, SpO2 is still 99, so the hypoxia branch never
  arms. Surfaced by the v4.48 haemorrhage audit; left as-is deliberately, since
  an arrest pathway is a sizeable piece of physiology and every other teaching
  point in that scenario lands well before the patient would arrest.
- **SpO2 is blind to circulatory collapse.** It reads 99 for the whole
  haemorrhage scenario, including 30 minutes at a cardiac output of 1.0-1.3
  L/min. `spo2Ceiling` is built from the shunt terms and the alveolar oxygen
  path only - nothing in the SpO2 block reads cardiac output, circulating
  volume or perfusion. Clinically a pulse oximeter on a patient at MAP 22 would
  lose its trace or read low; here it stays reassuring. Same family as the FiO2
  item below: a lever a trainee watches that the model does not connect.

- **Resolved in v4.49 for sepsis.** The sepsis patient still wakes if left
  alone (consciousness → 86 by t=600) and the wake still triggers a
  bronchospasm at t=431, but both are now covered by the scenario's own
  objectives and hints rather than being unannounced. The physiology was never
  the bug: the septic profile's `airwayReactivity` 0.3 plus a light patient is
  exactly what should spasm, and sevo 1.5% from t=30 prevents both. Text-only
  fix — new objectives 3 and 4, four new hints, and sweep's `TREATMENTS` now
  starts sevo and raises RR.
- **Emergence** still fires a spontaneous bronchospasm its briefing never
  mentions, and **v4.50 made it materially worse** — resistance now holds at
  ~50 rather than ~40, so the scenario's *own* recommended plan ends with an
  awake patient (BIS 98) at SpO₂ 88.8, etCO₂ 54.5 and MAP 133. This is the
  emergence half of the item v4.49 answered for sepsis and it needs the same
  text-only pass: an objective and hints that name the spasm, plus a treatment
  plan that addresses it. **Next thing to do in this series.**
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
