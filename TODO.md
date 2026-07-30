# TODO — drug calibration follow-ups

Open items from the **salbutamol-class drug audit** (v4.38–v4.39), which swept all
27 modelled drugs for effect terms scaled against a concentration far from what
the PK actually delivers. The clear breaks were fixed; the items below are the
milder finds — real discrepancies, none broken, some possibly intentional. Each
needs a calibration decision before touching.

## How to verify / re-measure

The headless harness measures what a user sees. Quick effect check for any drug:

```js
const { boot, give } = require('./tools/harness');
const sim = boot(); const dl = sim.dl; dl.setProfile('adult');
give(dl, 'morph', 10);                       // or dl.state.machine.pumps.<drug> = rate
for (let i=0;i<18000;i++) sim.advance(100);  // watch dl.state.* over 30 min
```

Two angles (see the audit report and `tools/probes.js` F16/F17 for the pattern):
- **Reference audit:** measure peak `<drug>Ce` at a clinical dose; compare to the
  `Ce / REF` denominator in the tick. A big mismatch = salbutamol-class.
- **Effect audit:** give a clinical dose, measure the change in what the drug
  targets (HR / MAP / BIS / analgesia cover / …) vs the intent stated in comments.

Baseline to keep green: **probes 45/45, voucher-probe 15/15, scan 0 BUG.**

## Open items

| drug | finding | measured | intent | likely lever | confidence |
|---|---|---|---|---|---|
| Morphine | analgesia ~2× weaker than its own comment | 10 mg → peak Ce 0.013 @19 min → `morphE` 0.52; cover rises ~⅓ of fentanyl's | comment predicts `morphE ~0.9` | reconcile `morphCe/0.025` reference vs delivered Ce, **or** fix the comment | medium |
| Alfentanil | mildly weaker than its comment | 1 mg → peak Ce 0.013 → `alfE` 0.66 | comment predicts `alfE ~0.9` | `alfCe/0.020` reference vs delivered ~0.013 | low–medium |
| Midazolam | light sedation | 5 mg → BIS 98→81; peak Ce 0.083 → `midaE` 0.41 | 5 mg IV should sedate more (BIS ~70) | `midaCe/0.2` reference — **but** it is *meant* to be weaker than propofol, so decide intended potency first | low (may be intentional) |
| Vasopressin | weak pressor on a normal adult | 2 U/hr → MAP +4, 4 U/hr → +8 | more effect, esp. in vasoplegia | `SVR_VASO_GAIN`; **test in the sepsis/vasoplegic profile** where it's actually used before changing | low |
| Adrenaline | steep dose–response | 10 mcg → MAP +6, 100 mcg → +63, 500 mcg → +86 | 100 mcg is a big bolus, so +63 may be fine | check the low-dose end (`adrCe/0.05` + `ALPHA/BETA_ADR_GAIN`); may not be a bug | low |

### Notes per item

- **Morphine / alfentanil** share a pattern: the code comment predicts an
  effect-site level (`~0.022`, `~0.018`) the PK does not reach (`~0.013` each).
  Either the reference should track the real peak (making both stronger) or the
  comments are aspirational and should be corrected. Morphine is genuinely
  slow-onset (peak ~19 min) — keep that; it's the *magnitude* in question.
- **Midazolam** is the one most likely to be deliberate. Confirm the intended
  co-induction / sedation potency before nudging.
- **Vasopressin** is context-dependent by design (V1 effect is bigger when the
  vasculature is dilated). Measure it in the **sepsis** profile / a vasoplegic
  state, not just a normal adult, before deciding.
- **Adrenaline** may simply have a steep, saturating curve that's clinically
  reasonable. Sanity-check 10–50 mcg boluses specifically.

## For context

**Fixed in the audit:** salbutamol (v4.38 — tachycardia + bronchodilation),
neostigmine, dexmedetomidine (+ wired to a UI infusion slider), magnesium
(v4.39). See `tools/probes.js` F16/F17.

**Cleared as fine (18):** propofol, ketamine, fentanyl, remifentanil, ephedrine,
metaraminol, phenylephrine, atropine, glycopyrrolate, esmolol, GTN, calcium,
rocuronium, sugammadex, noradrenaline, dobutamine, furosemide, dantrolene.
