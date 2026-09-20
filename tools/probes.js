/* =============================================================================
   PROBES  --  targeted regression checks for the July 2026 audit findings
   -----------------------------------------------------------------------------
   Where sweep.js/scan.js look for anomalies broadly, this file pins down one
   specific behaviour per known finding and states what it should be once fixed.
   Each probe isolates a single variable so the result is unambiguous.

   Every probe currently reports FAIL -- they encode bugs that have not been
   fixed yet. As each is addressed the corresponding probe should flip to PASS,
   which makes this the checklist for the audit.

       node tools/probes.js            # run all, always exits 0
       node tools/probes.js F4         # run one probe
       DL_STRICT=1 node tools/probes.js   # exit 1 if any probe fails (for CI)

   Findings are numbered as in the audit report.
   ============================================================================= */
'use strict';

const { boot, resolve, give, gaugeSpecs } = require('./harness');

/* -----------------------------------------------------------------------------
   tiny check framework
   -------------------------------------------------------------------------- */
const results = [];
let current = null;

function probe(id, title, fn) {
    const only = process.argv[2];
    if (only && only.toUpperCase() !== id) return;
    current = { id, title, checks: [] };
    results.push(current);
    console.log('\n' + '='.repeat(78));
    console.log(`${id}  ${title}`);
    console.log('='.repeat(78));
    fn();
}

/** Record one assertion. `pass` true means the bug is fixed. */
function expect(pass, label, measured, expected) {
    current.checks.push({ pass, label });
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}`);
    console.log(`         measured: ${measured}`);
    console.log(`         expected: ${expected}`);
}

/** Print a free-form evidence block. */
const note = s => console.log(s.split('\n').map(l => '         ' + l).join('\n'));

const mapOf = dl => dl.calcMAP(dl.state.sys, dl.state.dia, dl.state.hr);

/* =============================================================================
   F1  surgical stimulus decays because setups do not set nociceptionTarget
   ========================================================================== */
probe('F1', 'Scenario stimulus survives loading', () => {
    const mismatched = [];
    const keys = Object.keys(boot().dl.SCENARIOS);
    for (const key of keys) {
        const sim = boot();
        sim.dl.loadScenario(key);
        const noci = sim.dl.state.nociception;
        const target = sim.dl.state.nociceptionTarget;
        sim.advance(30000);
        if (Math.abs(noci - target) > 0.01) {
            mismatched.push({ key, noci, target, after: sim.dl.state.nociception });
        }
    }
    expect(mismatched.length === 0,
        'every scenario keeps the stimulus it sets',
        `${mismatched.length}/${keys.length} scenarios lose it: ` +
            mismatched.slice(0, 5).map(m => `${m.key}(${m.noci}->${m.after.toFixed(2)})`).join(', ') +
            (mismatched.length > 5 ? ', ...' : ''),
        'nociceptionTarget == nociception after setup(), in all scenarios');
    if (mismatched.length) {
        note('setups assign state.nociception but not state.nociceptionTarget;\n' +
             'the tick eases toward the target (TAU_NOCI 2.5 s) which reset just zeroed.\n' +
             'Fix once in loadScenario(): state.nociceptionTarget = state.nociception');
    }
});

/* =============================================================================
   F2  opioid cover swamps the whole 0-10 stimulus scale
   ========================================================================== */
probe('F2', 'Surgical stimulus produces a haemodynamic response', () => {
    const rows = [];
    [0, 2, 4, 6, 8, 10].forEach(n => {
        const sim = boot();
        sim.dl.loadScenario('maintenance');
        sim.dl.setNoci(n);
        sim.advance(180000);
        rows.push({ n, cover: sim.dl.state.analgesiaCover, eff: sim.dl.state.effectiveStimulus,
                    hr: sim.dl.state.hr, map: mapOf(sim.dl) });
    });
    note('maintenance scenario, sweeping the header Stimulus slider:\n' +
         'noci  cover  effStim    HR   MAP\n' +
         rows.map(r => `${String(r.n).padStart(4)}${r.cover.toFixed(2).padStart(7)}` +
             `${r.eff.toFixed(2).padStart(9)}${r.hr.toFixed(0).padStart(6)}${r.map.toFixed(0).padStart(6)}`).join('\n'));

    /* A routine maintenance regimen should leave most of the scale usable.
       Some cover is correct -- a lightly-handled patient on remi genuinely
       should not respond -- but it must not consume the whole range. */
    const cover = rows[0].cover;
    expect(cover < 5,
        'a routine opioid regimen leaves most of the 0-10 scale usable',
        `cover ${cover.toFixed(2)} of 10 from remi 0.15 mcg/kg/min + residual fentanyl`,
        'below 5, so a strong surgical stimulus still breaks through');

    /* The slider must actually drive haemodynamics across its range. */
    const mapRange = Math.max(...rows.map(r => r.map)) - Math.min(...rows.map(r => r.map));
    const monotonic = rows.every((r, i) => i === 0 || r.map >= rows[i - 1].map - 0.5);
    expect(mapRange > 25 && monotonic,
        'the Stimulus slider drives a graded haemodynamic response',
        `MAP spans ${mapRange.toFixed(0)} mmHg across the sweep` +
            (monotonic ? '' : ', and is NOT monotonic'),
        'a monotonic rise spanning more than 25 mmHg');

    /* Scenarios whose teaching depends on a sympathetic response must not be
       masked. vagal and mh deliberately set a stimulus below their opioid
       cover -- vagal to keep the bradycardic picture clean (see the v3.65 note
       in its setup), mh because the teaching point is hypermetabolism -- so
       they are legitimately excluded. */
    const STIMULUS_DEPENDENT = ['maintenance', 'asthma', 'autonomicDysreflexia',
                                'aneurysm', 'haemorrhage', 'ischaemia', 'tiva',
                                'anaphBrewing', 'paedLap', 'emergence'];
    const masked = STIMULUS_DEPENDENT.filter(key => {
        const sim = boot();
        sim.dl.loadScenario(key);
        sim.advance(120000);
        return sim.dl.state.nociception > 0 && sim.dl.state.effectiveStimulus < 0.05;
    });
    expect(masked.length === 0,
        'scenarios that teach a sympathetic response are not fully masked',
        masked.length ? `${masked.length} masked: ${masked.join(', ')}` : 'none masked',
        'none');
});

/* =============================================================================
   F3  the LAST scenario self-cancels before it can progress
   ========================================================================== */
probe('F3', 'LAST progresses to an arrest rhythm', () => {
    const sim = boot();
    const s = sim.dl.state;
    sim.dl.loadScenario('last');
    const seen = new Set([s.rhythm]);
    const marks = [];
    [10, 29, 30, 31, 60, 120, 300].forEach((t, i, arr) => {
        sim.advance((t - (i ? arr[i - 1] : 0)) * 1000);
        seen.add(s.rhythm);
        marks.push(`${String(t).padStart(4)}s  events.last=${String(s.events.last).padEnd(5)} ` +
                   `lastTimer=${s.lastTimer.toFixed(1).padStart(5)}  rhythm=${s.rhythm}`);
    });
    note(marks.join('\n'));

    const arrested = seen.has('vtPulseless') || seen.has('vf');
    expect(arrested,
        'reaches pulseless VT (60 s) and VF (120 s) if untreated',
        `rhythm only ever: ${[...seen].join(', ')}`,
        'vtPulseless by 60 s, vf by 120 s');
    if (!arrested) {
        note('The ROSC check `rhythm === "sinus" && lastTimer > 30` runs before\n' +
             'progression at 60 s, so it fires at t=30 s and clears events.last.\n' +
             'Fix: gate resolution on an arrest having actually occurred.');
    }
});

/* =============================================================================
   F4  SpO2 does not respond to hypoventilation
   ========================================================================== */
probe('F4', 'SpO2 responds to hypoventilation', () => {
    const rows = [];
    [500, 300, 200, 150, 100, 60, 40, 20].forEach(vt => {
        const sim = boot();
        const s = sim.dl.state;
        sim.dl.loadScenario('maintenance');
        sim.dl.setAirway('ett');
        sim.dl.setVentMode('VCV');
        sim.dl.setVentParam('fio2', 0.21);
        sim.dl.setVentParam('vt', vt);
        sim.dl.setVentParam('rr', 12);
        sim.advance(300000);
        rows.push({ vt, mv: s.minuteVent, afio2: s.patient.alveolarFiO2, etco2: s.etco2, spo2: s.spo2 });
    });
    note('adult, ETT, VCV, FiO2 0.21, paralysed -- only Vt varied, 5 min each:\n' +
         'Vt(mL)  minuteVent  alveolarFiO2  etCO2   SpO2\n' +
         rows.map(r => `${String(r.vt).padStart(6)}${r.mv.toFixed(2).padStart(12)}` +
             `${r.afio2.toFixed(3).padStart(14)}${r.etco2.toFixed(0).padStart(7)}${r.spo2.toFixed(1).padStart(7)}`).join('\n'));

    // A patient on 1.2 L/min of minute ventilation should not read a full saturation.
    const marginal = rows.find(r => r.vt === 100);
    expect(marginal.spo2 < 95,
        'severe hypoventilation (Vt 100 mL, MV 1.2 L/min) causes desaturation',
        `SpO2 ${marginal.spo2.toFixed(1)}% with etCO2 ${marginal.etco2.toFixed(0)}`,
        'SpO2 below 95%, falling progressively as Vt falls');

    /* The response should be graded rather than binary. Distinct levels is the
       direct measure: the old model produced exactly two (99.0 and 70.0). A
       step of ~20 points low on the curve is expected -- the oxyhaemoglobin
       dissociation curve really is steep below 90% -- so the cap here only
       needs to catch a true cliff. */
    const levels = new Set(rows.map(r => r.spo2.toFixed(0))).size;
    const biggestStep = rows.reduce((m, r, i) =>
        i ? Math.max(m, Math.abs(rows[i - 1].spo2 - r.spo2)) : 0, 0);
    expect(levels >= 5 && biggestStep < 25,
        'the SpO2 response is graded rather than a step function',
        `${levels} distinct SpO2 levels across the sweep, largest single step ${biggestStep.toFixed(1)} points`,
        'at least 5 distinct levels and no step above 25 points');
});

/* =============================================================================
   F5  SpO2 floors at 70 and hypoxia has no haemodynamic consequence
   ========================================================================== */
probe('F5', 'Prolonged hypoxia is survivable-to-fatal, not a plateau', () => {
    const sim = boot();
    const s = sim.dl.state;
    sim.dl.loadScenario('maintenance');
    sim.dl.setVentMode('MANUAL');
    sim.dl.toggleEvent('apnoea');
    sim.dl.setVentParam('fio2', 0.21);
    sim.advance(1800000);   // 30 minutes of total apnoea on room air

    note(`after 30 minutes of total apnoea on room air:\n` +
         `SpO2 ${s.spo2.toFixed(1)}   HR ${s.hr.toFixed(0)}   MAP ${mapOf(sim.dl).toFixed(0)}   ` +
         `rhythm ${s.rhythm}   alveolarFiO2 ${s.patient.alveolarFiO2.toFixed(3)}`);

    const capMin = sim.dl.CONFIG.CAPS.SPO2_MIN;
    expect(s.spo2 < 60,
        'SpO2 can fall below its 70% plateau toward CAPS.SPO2_MIN',
        `SpO2 plateaus at ${s.spo2.toFixed(1)}% (CAPS.SPO2_MIN is ${capMin}, unreachable)`,
        `SpO2 falling toward ${capMin}`);
    expect(s.rhythm !== 'sinus' || s.hr < 50,
        'sustained hypoxia produces bradycardia or arrest',
        `rhythm ${s.rhythm}, HR ${s.hr.toFixed(0)}, MAP ${mapOf(sim.dl).toFixed(0)} -- haemodynamically normal`,
        'hypoxic bradycardia progressing to arrest');
});

/* =============================================================================
   F6  pre-loaded autonomic tone is erased before the scenario can present
   ========================================================================== */
probe('F6', 'Hypertensive scenarios actually present as hypertensive', () => {
    [['aneurysm', 'briefing states BP 200/110 (MAP ~140)'],
     ['autonomicDysreflexia', 'briefing states explosive hypertension']].forEach(([key, brief]) => {
        const sim = boot();
        sim.dl.loadScenario(key);
        let peak = 0;
        for (let i = 0; i < 120; i++) { sim.advance(1000); peak = Math.max(peak, mapOf(sim.dl)); }
        expect(peak > 110,
            `${key} becomes hypertensive (${brief})`,
            `peak MAP over the first 2 min is ${peak.toFixed(0)} mmHg`,
            'peak MAP above 110 mmHg');
    });

    /* The dysreflexia mechanism is real but keyed to nociception, so show that
       fixing F1 alone recovers most of it. */
    const sim = boot();
    sim.dl.loadScenario('autonomicDysreflexia');
    sim.dl.state.nociceptionTarget = sim.dl.state.nociception;   // F1 fix
    sim.advance(300000);
    note(`with the F1 fix applied, autonomicDysreflexia reaches MAP ${mapOf(sim.dl).toFixed(0)} ` +
         `(vs ${'65'} as shipped) -- the AD amplifier at index.html:5584 does work,\n` +
         `it is just multiplying a nociception drive that has already decayed to zero.`);
});

/* =============================================================================
   F7  malignant hyperthermia shows only one of three cardinal signs
   ========================================================================== */
probe('F7', 'MH presents with tachycardia and hyperthermia, not just rising etCO2', () => {
    const sim = boot();
    const s = sim.dl.state;
    sim.dl.loadScenario('mh');
    const hr0 = s.hr;
    const marks = [];
    [60, 120, 300, 600].forEach((t, i, arr) => {
        sim.advance((t - (i ? arr[i - 1] : 0)) * 1000);
        marks.push(`${String(t).padStart(4)}s  mhSeverity=${s.mhSeverity.toFixed(2)}  ` +
                   `metabRate=${s.metabolicRate.toFixed(2)}  betaTone=${s.betaTone.toFixed(2)}  ` +
                   `HR=${s.hr.toFixed(0)}  etCO2=${s.etco2.toFixed(0)}`);
    });
    note(marks.join('\n'));

    expect(s.hr > 100,
        'HR rises into the briefed range (75 -> 110)',
        `HR ${hr0.toFixed(0)} -> ${s.hr.toFixed(0)} at full severity`,
        'HR above 100 bpm');

    const hasTemp = Object.keys(s).some(k => /temp/i.test(k)) ||
                    Object.keys(s.patient).some(k => /temp/i.test(k));
    expect(hasTemp,
        'body temperature is modelled',
        'no temperature field exists anywhere in state',
        'a state.temperature integrator tracking mhSeverity');

    /* Saturating exactly at full severity is fine; saturating early is not,
       because the crisis then stops escalating while it is still building.
       Measure how far up the severity range the metabolic rate keeps rising. */
    const sim2 = boot();
    const s2 = sim2.dl.state;
    sim2.dl.loadScenario('mh');
    let satSeverity = 1;
    const max = sim2.dl.CONFIG.METAB_MAX;
    for (let i = 0; i < 600; i++) {
        sim2.advance(1000);
        if (s2.metabolicRate >= max - 1e-6) { satSeverity = s2.mhSeverity; break; }
    }
    expect(satSeverity >= 0.9,
        'metabolic rate keeps escalating through the severity range',
        `metabolicRate reaches its ceiling (${max}) at mhSeverity ${satSeverity.toFixed(2)}`,
        'not before mhSeverity 0.9');
});

/* =============================================================================
   F8  three scenario setup lines are silent no-ops
   ========================================================================== */
probe('F8', 'Scenario setup lines actually take effect', () => {
    ['ischaemia', 'pulmEmbolism'].forEach(key => {
        const sim = boot();
        sim.dl.loadScenario(key);
        const rate = sim.dl.state.machine.pumps.remi;
        expect(rate > 0,
            `${key} starts its remifentanil infusion`,
            `pumps.remi = ${JSON.stringify(rate)}` +
                (rate > 0 ? '' : ' -- setup assigns pumps.remi.rate, a no-op on a number'),
            'pumps.remi = 0.08');
    });

    const sim = boot();
    sim.dl.loadScenario('mh');
    sim.advance(2000);
    const etco2 = sim.dl.state.etco2;
    expect(etco2 > 50,
        'mh starts at the briefed etCO2 of 55',
        `state.etco2 = ${etco2.toFixed(1)}` +
            (etco2 > 50 ? '' : ` (setup writes state.etCO2 - wrong case, dead property)`),
        'state.etco2 near 55');
});

/* =============================================================================
   F10  scenario setups permanently mutate the shared PROFILES objects
   ========================================================================== */
probe('F10', 'PROFILES presets are not mutated by scenarios', () => {
    const sim = boot();
    const dl = sim.dl;
    const pristine = { mapTarget: dl.PROFILES.adult.mapTarget,
                       airwayReactivity: dl.PROFILES.adult.airwayReactivity };
    const trail = [`pristine                  mapTarget ${pristine.mapTarget}  airwayReactivity ${pristine.airwayReactivity}`];
    ['aneurysm', 'asthma', 'autonomicDysreflexia', 'maintenance'].forEach(k => {
        dl.loadScenario(k);
        trail.push(`after loading ${k.padEnd(22)} mapTarget ${dl.PROFILES.adult.mapTarget}  ` +
                   `airwayReactivity ${dl.PROFILES.adult.airwayReactivity}`);
    });
    note(trail.join('\n'));

    const clean = dl.PROFILES.adult.mapTarget === pristine.mapTarget &&
                  dl.PROFILES.adult.airwayReactivity === pristine.airwayReactivity;
    expect(clean,
        'PROFILES.adult is unchanged after playing several scenarios',
        `mapTarget ${pristine.mapTarget} -> ${dl.PROFILES.adult.mapTarget}, ` +
            `airwayReactivity ${pristine.airwayReactivity} -> ${dl.PROFILES.adult.airwayReactivity}`,
        'unchanged -- setProfile() should copy: state.profile = {...PROFILES[key]}');
});

/* =============================================================================
   F11  scenarioReset() misses five drugs
   ========================================================================== */
probe('F11', 'scenarioReset() clears every drug in PK', () => {
    const sim = boot();
    const dl = sim.dl;
    const p = dl.state.patient;

    dl.loadScenario('bronchospasm');
    give(dl, 'salb', 0.25);
    give(dl, 'mag', 2.0);
    give(dl, 'alf', 1.0);
    give(dl, 'morph', 10);
    give(dl, 'furo', 40);
    sim.advance(30000);

    /* Call scenarioReset() directly rather than loadScenario(), so we measure
       what the reset clears -- not what the next scenario's setup() then puts
       back (maintenance seeds remi/fent/roc itself). */
    dl.scenarioReset();
    const leaked = Object.keys(dl.PK).filter(d => (p[d + 'Ce'] || 0) > 1e-9 || (p[d + 'Cp'] || 0) > 1e-9);
    expect(leaked.length === 0,
        'no drug survives a scenario change',
        leaked.length ? `${leaked.length} leak: ${leaked.map(d => `${d}Ce=${p[d + 'Ce'].toFixed(5)}`).join(', ')}` : 'none',
        'all cleared -- derive the list from Object.keys(PK)');
});

/* =============================================================================
   F12  gauge ranges do not match the model limits behind them
   ========================================================================== */
probe('F12', 'Physiology gauge ranges match the values they display', () => {
    const dl = boot().dl;
    const gauges = {};
    Object.keys(dl.PHYS_GROUPS).forEach(g => dl.PHYS_GROUPS[g].forEach(i => {
        if (!i.section) gauges[i.key] = i;
    }));

    /* Hard clamps applied in the physiology tick (index.html:6007-6009). */
    const CLAMP = { alpha: 1.4, beta: 1.4, parasymp: 1.0 };
    Object.keys(CLAMP).forEach(k => {
        const min = resolve(gauges[k].min), max = resolve(gauges[k].max);
        const frac = (CLAMP[k] - min) / (max - min);
        expect(frac >= 0.90,
            `${gauges[k].label}: the bar can reach its danger threshold`,
            `model clamps at ${CLAMP[k]} but the gauge spans ${min}-${max}, so the bar tops out at ` +
                `${(frac * 100).toFixed(0)}% (warn at 75% ${frac >= 0.75 ? 'reachable' : 'UNREACHABLE'}, ` +
                `danger at 90% ${frac >= 0.90 ? 'reachable' : 'UNREACHABLE'})`,
            `gauge max resolved from the same constant the tick clamps against`);
    });

    /* Preload and contractility ceilings are per-profile, and the gauge maxima
       resolve against the ACTIVE profile -- so each profile must be selected
       before its gauge span is read. */
    const worst = [];
    Object.keys(dl.PROFILES).forEach(pk => {
        dl.setProfile(pk);
        const prof = dl.state.profile;
        const pc = prof.preloadCeiling !== undefined ? prof.preloadCeiling : 1.6;
        const cc = prof.contractilityCeiling !== undefined ? prof.contractilityCeiling : dl.CONFIG.CONT_CEILING;
        const pFrac = (pc - resolve(gauges.preload.min)) / (resolve(gauges.preload.max) - resolve(gauges.preload.min));
        const cFrac = (cc - resolve(gauges.contract.min)) / (resolve(gauges.contract.max) - resolve(gauges.contract.min));
        worst.push(`${pk.padEnd(9)} preload ceiling ${String(pc).padEnd(5)} -> bar max ${(pFrac * 100).toFixed(0)}%   ` +
                   `contractility ceiling ${String(cc).padEnd(5)} -> bar max ${(cFrac * 100).toFixed(0)}%`);
        if (pFrac < 0.9 || cFrac < 0.9) worst.dirty = true;
    });
    note(worst.join('\n'));
    expect(!worst.dirty,
        'preload and contractility gauges track the active profile ceilings',
        'gauges use global CONFIG limits while profiles override them per patient',
        'max resolved per profile, e.g. () => state.profile.preloadCeiling ?? 1.6');

    /* Circulating volume must cover the paediatric patient. */
    const cvMin = resolve(gauges.circVol.min);
    expect(cvMin <= dl.PROFILES.paed.centralVol * 0.9,
        'circulating-volume gauge covers a paediatric patient',
        `gauge starts at ${cvMin} L but the paed profile's normal volume is ${dl.PROFILES.paed.centralVol} L`,
        'a floor below the smallest profile volume, e.g. profile-relative');
});

/* =============================================================================
   F13  gauges do not colour when the value falls dangerously low
   -----------------------------------------------------------------------------
   The colour modes could only express "dangerous at the end of the bar", so the
   circulatory variables -- whose danger sits well inside their span -- either
   had colour:'none' or a ceiling rule that only watched the top. Untreated
   haemorrhage took circulating volume from 5.0 L to 0.5 L and cardiac output to
   0.9 L/min with both bars still accent-blue.

   Two things have to hold at once, and they pull against each other: the
   threshold has to fire on a genuinely sick patient, and it has to stay quiet on
   a well one -- including a well 20 kg child and a well 130 kg adult, whose
   normal values differ enough that any absolute threshold breaks one of them.
   ========================================================================== */
probe('F13', 'Low-side danger colours the gauge, for every profile', () => {
    const dl = boot().dl;
    const gauges = {};
    Object.keys(dl.PHYS_GROUPS).forEach(g => dl.PHYS_GROUPS[g].forEach(i => {
        if (!i.section) gauges[i.key] = i;
    }));
    const statusOf = (k, v) =>
        dl.physStatus(gauges[k], v, resolve(gauges[k].min), resolve(gauges[k].max)) || 'none';

    /* 1. The values untreated haemorrhage actually reaches must read danger. */
    dl.setProfile('adult');
    const bled = [
        ['circVol',  0.50, 'central volume, untreated haemorrhage at 135 s'],
        ['preload',  0.10, 'preload, same run'],
        ['co',       0.92, 'cardiac output, same run'],
        ['contract', 0.63, 'contractility, anaphylaxis with myocardial depression'],
    ];
    const missed = bled.filter(([k, v]) => statusOf(k, v) !== 'danger');
    note(bled.map(([k, v, why]) => `${k.padEnd(9)} ${String(v).padEnd(5)} -> ${statusOf(k, v).padEnd(6)} (${why})`).join('\n'));
    expect(missed.length === 0,
        'shock-range circulatory values read danger',
        missed.length ? `${missed.map(([k, v]) => `${k}=${v} reads ${statusOf(k, v)}`).join(', ')}`
                      : 'all four read danger',
        'explicit low thresholds, anchored to the value the model treats as normal');

    /* 2. No profile may colour at its own resting state. This is the check that
       rules out absolute thresholds: a resting paed CO is 3.2 L/min and a
       resting obese SVR tone is 0.61, so thresholds picked for a 70 kg adult
       would paint both patients permanently amber before anything happened. */
    const falsePositives = [];
    Object.keys(dl.PROFILES).forEach(pk => {
        dl.setProfile(pk);
        const resting = {
            circVol:  dl.state.profile.centralVol,
            preload:  dl.CONFIG.PRELOAD_BASELINE,
            co:       dl.physCOBaseline(),
            svr:      dl.physSVRBaseline(),
        };
        const line = Object.keys(resting).map(k => {
            const st = statusOf(k, resting[k]);
            if (st !== 'none') falsePositives.push(`${pk}/${k} rests at ${resting[k].toFixed(2)} -> ${st}`);
            return `${k} ${resting[k].toFixed(2)} ${st}`;
        });
        note(`${pk.padEnd(9)} ${line.join('   ')}`);
    });
    expect(falsePositives.length === 0,
        'a patient at rest colours nothing, on every profile',
        falsePositives.length ? falsePositives.join('; ') : 'all profiles clean at rest',
        'thresholds resolved from the profile, not hardcoded for the 70 kg adult');

    /* 3. And the thresholds must sit inside the range the model can produce --
       a danger threshold below the model's own floor can never be reached. */
    dl.setProfile('adult');
    const FLOOR = {
        preload:  0,
        contract: dl.CONFIG.CONT_FLOOR,
        svr:      dl.CONFIG.SVR_FLOOR,
        circVol:  0,
        co:       0,
    };
    const unreachable = Object.keys(FLOOR).filter(k => {
        const d = resolve(gauges[k].dangerLow);
        return d === undefined || d <= FLOOR[k];
    });
    note(Object.keys(FLOOR).map(k =>
        `${k.padEnd(9)} dangerLow ${String(resolve(gauges[k].dangerLow)).padEnd(20)} model floor ${FLOOR[k]}`).join('\n'));
    expect(unreachable.length === 0,
        'every low danger threshold sits above the model floor',
        unreachable.length ? `unreachable: ${unreachable.join(', ')}` : 'all five reachable',
        'dangerLow strictly above the floor the tick clamps to');

    /* 4. The Nociception gauge shows what the tick acts on (effective stimulus),
       not the raw slider position -- otherwise it just echoes the control and
       stays pinned high through a fully covered case. */
    const sim = boot();
    sim.dl.loadScenario('autonomicDysreflexia');
    sim.advance(1000);
    const rawNoci = sim.dl.state.nociception;
    sim.dl.state.analgesiaCover = rawNoci;          // pretend it is fully covered
    sim.advance(1000);
    const shown = gauges.noci.get.call(null);
    note(`raw nociception ${rawNoci.toFixed(1)}, analgesia covering all of it -> gauge shows ${shown.toFixed(2)}`);
    expect(shown < rawNoci - 0.5,
        'Nociception gauge falls when analgesia covers the stimulus',
        `gauge reads ${shown.toFixed(2)} against a raw stimulus of ${rawNoci.toFixed(1)}`,
        'get() returns state.effectiveStimulus, as the Pathways tab already does');
});

/* =============================================================================
   F14  opioid vagal drive pins parasympathetic tone at the clamp
   -----------------------------------------------------------------------------
   The opioids' central vagal effect was a per-tick additive push on
   state.parasympTone. Against the TONE_DECAY_TAU relaxation (a per-tick blend,
   not a time constant) an additive push k settles at REST + k/TAU = REST +
   20*(gain*dt) = REST + 2*gain - a 20x amplification - so remifentanil above
   ~0.2 mcg/kg/min drove the tone past its 1.0 clamp and pinned it. Consequences:
   the haemodynamic dose-response went flat (identical output over a 2.5x dose
   range), further vagal drives were masked (no headroom left), and the gauge
   read maximal vagal tone next to a tachycardic patient. The drive now builds a
   saturating parasympTarget the tone relaxes toward - trap #1, the same pattern
   alpha and beta already use.
   ========================================================================== */
probe('F14', 'Opioid vagal drive does not pin parasympathetic tone', () => {
    const clamp = boot().dl.CONFIG.PARASYMP_CLAMP;

    /* Steady-state HR drop and parasympTone under a fixed remi infusion on a
       resting adult (no stimulus), so only the opioid vagal arm is exercised. */
    function remiSteady(rate) {
        const sim = boot(); const dl = sim.dl;
        dl.setProfile('adult'); dl.setNoci(0);
        sim.advance(60000);
        const hr0 = dl.state.hr;
        dl.state.machine.pumps.remi = rate;
        sim.advance(600000);
        return { dHR: dl.state.hr - hr0, para: dl.state.parasympTone };
    }

    /* 1. The dose-response must keep moving across the range that used to be
       flat. Old model: remi 0.2..0.5 all produced an identical HR (pinned). */
    const rates = [0.2, 0.3, 0.4, 0.5];
    const pts = rates.map(r => ({ r, ...remiSteady(r) }));
    note(pts.map(p => `remi ${p.r}  parasymp ${p.para.toFixed(3)}  HR ${p.dHR.toFixed(1)}`).join('\n'));
    let monotonic = true;
    for (let i = 1; i < pts.length; i++) {
        // each higher dose must give measurably MORE bradycardia, not the same
        if (pts[i].dHR > pts[i - 1].dHR - 0.2) monotonic = false;
    }
    expect(monotonic,
        'remifentanil bradycardia keeps deepening from 0.2 to 0.5 mcg/kg/min',
        `HR deltas: ${pts.map(p => p.dHR.toFixed(1)).join(', ')}`,
        'a monotonic dose-response, not a flat pinned region');

    /* 2. At a routine infusion the tone must sit strictly below the clamp,
       leaving the headroom that vagal events / hypoxia / baroreflex add into. */
    const mid = remiSteady(0.25);
    expect(mid.para < clamp - 0.02,
        'a routine remi infusion leaves parasympathetic headroom below the clamp',
        `remi 0.25 -> parasymp ${mid.para.toFixed(3)} (clamp ${clamp})`,
        `parasympTone below ${clamp} so further vagal drives still register`);

    /* 3. The opioid must still produce a plausible bradycardia - the fix is
       meant to stop the pin, not to zero out the vagal effect. */
    const lo = remiSteady(0.15);
    expect(lo.dHR <= -3 && lo.dHR >= -12,
        'remifentanil still causes clinically sensible bradycardia',
        `remi 0.15 -> HR ${lo.dHR.toFixed(1)} bpm (documented calibration is about -8)`,
        'a HR drop in roughly the -4 to -10 range at 0.15 mcg/kg/min');

    /* 4. A vagal event on top of an opioid infusion must still move the tone -
       the old pin left zero headroom, so the parasympathetic arm did nothing
       and only the separate sympathetic-withdrawal arm survived. */
    const sim = boot(); const dl = sim.dl;
    dl.loadScenario('maintenance'); dl.setNoci(0);
    dl.state.machine.pumps.remi = 0.2;
    sim.advance(300000);
    const pBefore = dl.state.parasympTone;
    dl.toggleEvent('vagal');
    let pPeak = pBefore;
    for (let i = 0; i < 400; i++) { sim.advance(100); pPeak = Math.max(pPeak, dl.state.parasympTone); }
    note(`on remi 0.2: parasymp ${pBefore.toFixed(3)} -> vagal-event peak ${pPeak.toFixed(3)}`);
    expect(pPeak > pBefore + 0.1,
        'a vagal event still drives parasympathetic tone up on top of an opioid',
        `parasymp ${pBefore.toFixed(3)} -> ${pPeak.toFixed(3)} when the event fires`,
        'the opioid no longer consumes all the headroom to the clamp');
});

/* =============================================================================
   F15  the ischaemia scenario cannot actually be healed
   -----------------------------------------------------------------------------
   Coronary supply was modelled as diastolic pressure alone (supplyIdx = DBP/ref),
   with HR only on the demand side. Slowing the heart cut SBP (demand) but cut DBP
   (supply) too, so the demand/supply ratio barely moved and imbalance never went
   negative - no amount of management could push the accumulator down. The
   scenario's own hints tell the trainee to slow the heart to fix it, but the
   model made that impossible.

   v4.37 adds a diastolic-time factor (HR_REF/HR) to supply: coronary filling is a
   diastolic event and diastole shortens with rate, so a slow heart is rewarded on
   supply, not just spared demand. Rate control now heals - the property this probe
   pins down.
   ========================================================================== */
probe('F15', 'Rate control heals myocardial ischaemia; tachycardia does not', () => {
    /* Run the ischaemia scenario under a treatment, sampling the accumulator. */
    function run(treat, secs) {
        const sim = boot(); const dl = sim.dl;
        dl.loadScenario('ischaemia');
        if (treat) treat(dl, sim);
        let peak = 0;
        const series = [];
        for (let t = 0; t <= secs; t += 5) {
            sim.advance(5000);
            peak = Math.max(peak, dl.state.ischaemia);
            series.push({ t, isch: dl.state.ischaemia, hr: dl.state.hr });
        }
        const s = dl.state;
        return { peak, isch: s.ischaemia, hr: s.hr, sys: s.sys, dia: s.dia, series };
    }

    /* 1. Untreated, the tachycardic patient builds and stays ischaemic. */
    const untreated = run(null, 420);
    expect(untreated.isch > 0.8,
        'untreated ischaemia builds and stays high',
        `ischaemia settles at ${untreated.isch.toFixed(2)} (HR ${untreated.hr.toFixed(0)})`,
        'a demand/supply imbalance the tachycardia sustains');

    /* 2. Rate control to the low 70s with an adequate DBP heals within a few
       minutes and holds - the clinical target the scenario teaches. Delivered
       here with the tools the hints name: analgesia (remi) plus a beta-blocker. */
    const managed = run(dl => { dl.state.machine.pumps.remi = 0.5; give(dl, 'esmo', 50); give(dl, 'esmo', 50); }, 600);
    const healedBy = managed.series.find(x => x.t >= 60 && x.isch < 0.2);
    const heldLow = managed.series.slice(-6).every(x => x.isch < 0.25);
    note(`managed (HR ${managed.hr.toFixed(0)}, ${managed.sys.toFixed(0)}/${managed.dia.toFixed(0)}): peak ${managed.peak.toFixed(2)} -> ` +
         `${managed.isch.toFixed(2)}${healedBy ? `, first <0.2 at ${healedBy.t}s` : ', never <0.2'}`);
    expect(managed.peak > 0.4 && managed.isch < 0.2 && heldLow,
        'sustained rate control heals the ischaemia and holds it down',
        `peak ${managed.peak.toFixed(2)}, final ${managed.isch.toFixed(2)} at HR ${managed.hr.toFixed(0)}`,
        'a slow heart with adequate diastolic pressure drives imbalance negative');

    /* 3. Analgesia alone that does NOT slow the heart enough must NOT heal it -
       the teaching point is that rate control specifically is the lever. */
    const analgesiaOnly = run(dl => { dl.state.machine.pumps.remi = 0.4; }, 420);
    expect(analgesiaOnly.hr > 82 && analgesiaOnly.isch > 0.7,
        'deep analgesia that leaves the heart fast does not heal ischaemia',
        `remi 0.4 -> HR ${analgesiaOnly.hr.toFixed(0)}, ischaemia ${analgesiaOnly.isch.toFixed(2)}`,
        'still-tachycardic supply penalty keeps imbalance positive');

    /* 4. Mechanism unit-check: for the same diastolic pressure, a slower heart
       must produce a higher supply index than a fast one. */
    const dl = boot().dl;
    const supplyAt = hr => (70 / dl.CONFIG.ISCHAEMIA_DBP_REF) *
        Math.max(0.4, Math.min(1.8, dl.CONFIG.ISCHAEMIA_HR_REF / Math.max(hr, 1)));
    const slow = supplyAt(60), fast = supplyAt(110);
    note(`supply index at DBP 70: HR 60 -> ${slow.toFixed(3)}, HR 110 -> ${fast.toFixed(3)}`);
    expect(slow > fast + 0.15,
        'the diastolic-time factor rewards a slow heart on supply',
        `supply(HR60) ${slow.toFixed(3)} vs supply(HR110) ${fast.toFixed(3)} at the same DBP`,
        'supply rises as HR falls, because diastole lengthens');
});

/* =============================================================================
   F16  salbutamol causes no tachycardia and barely bronchodilates
   -----------------------------------------------------------------------------
   Both salbutamol effect terms - the beta1 tachycardia and the direct beta2
   bronchodilator - divided salbCe by a hardcoded 0.05, with comments claiming a
   peak Ce of ~0.05. The PK actually delivers ~0.00134 for the 250mcg reference
   dose, ~37x lower, so both effects were ~37x too weak: no tachycardia, near-
   placebo bronchodilation. v4.38 references both to CONFIG.SALB_CE_REF (the real
   peak) and calibrates the gains. A beta2 vasodilation term offsets most of the
   inotropic MAP rise (residual is a documented coupling limit).
   ========================================================================== */
probe('F16', 'Salbutamol causes tachycardia and bronchodilates', () => {
    const dl0 = boot().dl;

    /* Calibration guard: the effect reference must track the PK. This is the
       exact thing that was broken - if the PK changes, SALB_CE_REF must follow. */
    {
        const sim = boot(); const dl = sim.dl; dl.setProfile('adult');
        give(dl, 'salb', 0.25);
        let ce = 0; for (let i = 0; i < 3000; i++) { sim.advance(100); ce = Math.max(ce, dl.state.patient.salbCe); }
        const ratio = ce / dl.CONFIG.SALB_CE_REF;
        note(`250mcg peak salbCe ${ce.toFixed(5)} vs SALB_CE_REF ${dl.CONFIG.SALB_CE_REF} (ratio ${ratio.toFixed(2)})`);
        expect(ratio > 0.7 && ratio < 1.4,
            'the effect reference concentration matches the PK-delivered peak Ce',
            `250mcg peaks at salbCe ${ce.toFixed(5)}, SALB_CE_REF is ${dl.CONFIG.SALB_CE_REF}`,
            'SALB_CE_REF within ~30% of the real peak, so the /ref terms are on scale');
    }

    /* Tachycardia: a 250mcg bolus must produce a clear, dose-dependent HR rise. */
    function hrRise(mg) {
        const sim = boot(); const dl = sim.dl; dl.setProfile('adult'); dl.setNoci(0);
        sim.advance(60000); const hr0 = dl.state.hr;
        give(dl, 'salb', mg);
        let hrMax = hr0; for (let i = 0; i < 3000; i++) { sim.advance(100); hrMax = Math.max(hrMax, dl.state.hr); }
        return hrMax - hr0;
    }
    const hr250 = hrRise(0.25), hr100 = hrRise(0.1);
    note(`HR rise: 100mcg +${hr100.toFixed(1)}, 250mcg +${hr250.toFixed(1)}`);
    expect(hr250 >= 10 && hr250 <= 22,
        'a 250mcg salbutamol bolus causes a clear tachycardia',
        `250mcg -> HR +${hr250.toFixed(1)} bpm`,
        'a visible tachycardia in the +12-18 range');
    expect(hr100 < hr250 - 2,
        'the tachycardia is dose-dependent',
        `100mcg +${hr100.toFixed(1)} vs 250mcg +${hr250.toFixed(1)}`,
        'a smaller dose gives a smaller HR rise');

    /* Bronchodilation: in an active bronchospasm, 250mcg must drop airway
       resistance well below where it sits untreated. */
    function resistAfter(treat) {
        const sim = boot(); const dl = sim.dl;
        dl.setProfile('adult'); dl.toggleEvent('bronchospasm');
        sim.advance(30000);
        if (treat) treat(dl, sim);
        let rMin = dl.state.patient.bronchResistance;
        for (let i = 0; i < 2400; i++) { sim.advance(100); rMin = Math.min(rMin, dl.state.patient.bronchResistance); }
        return rMin;
    }
    const rUntreated = resistAfter(null);
    const rSalb = resistAfter(dl => give(dl, 'salb', 0.25));
    note(`bronchospasm airway resistance: untreated ${rUntreated.toFixed(0)}, +250mcg ${rSalb.toFixed(0)}`);
    expect(rSalb < rUntreated - 15,
        'salbutamol meaningfully relieves an active bronchospasm',
        `resistance untreated ${rUntreated.toFixed(0)} -> +250mcg ${rSalb.toFixed(0)}`,
        'a clear drop in airway resistance, not the near-placebo the /0.05 reference gave');
});

/* =============================================================================
   F17  salbutamol-class drug fixes from the drug audit (v4.39)
   -----------------------------------------------------------------------------
   The salbutamol audit found three more drugs whose effect scaling was
   mismatched to the PK-delivered Ce, so the drug was too weak or inert:
     - neostigmine: NEO_REVERSAL_RATE 0.05 gave a max reversal effect of 0.003
       vs the ~0.6 needed, so it reversed nothing;
     - dexmedetomidine: k10 0.3 (a ~2 min half-life) starved the effect site, so
       an infusion produced no bradycardia or sedation - and it had no UI;
     - magnesium: 0.5*(magCe/0.5) with a real peak Ce of ~0.088 contributed 0.088
       not 0.5, a near-placebo bronchodilator.
   ========================================================================== */
probe('F17', 'Neostigmine, dexmedetomidine and magnesium work', () => {
    /* Neostigmine reverses a PARTIAL block (roc waned) but not a DENSE one; a
       dense block is sugammadex's job. */
    function rocThenReverse(waneMin, revType, revDose) {
        const sim = boot(); const dl = sim.dl; dl.setProfile('adult');
        give(dl, 'roc', 50); sim.advance(waneMin * 60000);
        const p0 = dl.state.patient.paralysis;
        give(dl, revType, revDose); sim.advance(600000);
        return { p0, p1: dl.state.patient.paralysis };
    }
    const partial = rocThenReverse(45, 'neoglyco', 2.5);   // ~partial block at 45 min
    note(`neostigmine on a partial block: paralysis ${partial.p0.toFixed(2)} -> ${partial.p1.toFixed(2)}`);
    expect(partial.p0 > 0.3 && partial.p1 < 0.15,
        'neostigmine reverses a partial (waned) rocuronium block',
        `paralysis ${partial.p0.toFixed(2)} -> ${partial.p1.toFixed(2)} after neostigmine`,
        'a working reversal, not the 0.00 the old 0.05 rate gave');

    const dense = rocThenReverse(5, 'neoglyco', 2.5);      // dense block at 5 min
    expect(dense.p1 > 0.9,
        'neostigmine does NOT reverse a dense block (that is sugammadex\'s role)',
        `dense paralysis ${dense.p0.toFixed(2)} -> ${dense.p1.toFixed(2)} after neostigmine`,
        'a dense block stays clamped - clinically neostigmine cannot reverse deep block');
    const denseSug = rocThenReverse(5, 'sug', 400);
    expect(denseSug.p1 < 0.15,
        'sugammadex DOES reverse a dense block',
        `dense paralysis ${denseSug.p0.toFixed(2)} -> ${denseSug.p1.toFixed(2)} after sugammadex`,
        'sugammadex chelates rocuronium directly, at any depth');

    /* Dexmedetomidine, driven through the real setInf() UI path, produces
       bradycardia and sedation. */
    {
        const sim = boot(); const dl = sim.dl; dl.setProfile('adult'); dl.setNoci(0);
        sim.advance(60000);
        const hr0 = dl.state.hr, bis0 = dl.state.bis;
        dl.setInf('dex', 0.7);              // the slider's entry point
        sim.advance(40 * 60000);
        note(`dex 0.7 mcg/kg/hr @40min: HR ${hr0.toFixed(0)}->${dl.state.hr.toFixed(0)}, BIS ${bis0.toFixed(0)}->${dl.state.bis.toFixed(0)}`);
        expect(dl.state.hr < hr0 - 6 && dl.state.bis < bis0 - 15,
            'a dexmedetomidine infusion causes bradycardia and sedation',
            `HR ${hr0.toFixed(0)}->${dl.state.hr.toFixed(0)}, BIS ${bis0.toFixed(0)}->${dl.state.bis.toFixed(0)}`,
            'a clinical infusion is no longer inert (k10 fix + rebalanced gains)');
    }

    /* Magnesium is a modest bronchodilator adjunct - real relief, but weaker
       than salbutamol. */
    function resistAfter(treat) {
        const sim = boot(); const dl = sim.dl; dl.setProfile('adult'); dl.toggleEvent('bronchospasm');
        sim.advance(30000);
        if (treat) treat(dl);
        let rMin = dl.state.patient.bronchResistance;
        for (let i = 0; i < 2400; i++) { sim.advance(100); rMin = Math.min(rMin, dl.state.patient.bronchResistance); }
        return rMin;
    }
    const rNone = resistAfter(null);
    const rMag = resistAfter(dl => give(dl, 'mag', 2));
    const rSalb = resistAfter(dl => give(dl, 'salb', 0.25));
    note(`bronchospasm resistance: untreated ${rNone.toFixed(0)}, +2g mag ${rMag.toFixed(0)}, +250mcg salb ${rSalb.toFixed(0)}`);
    expect(rMag < rNone - 8 && rMag > rSalb,
        'magnesium gives modest bronchodilation, weaker than salbutamol',
        `resistance untreated ${rNone.toFixed(0)}, mag ${rMag.toFixed(0)}, salb ${rSalb.toFixed(0)}`,
        'a real adjunct effect (was near-placebo), but less than the primary reliever');
});

/* =============================================================================
   F18  the anaphylaxis scenario barely presents, and treating it made it worse
   -----------------------------------------------------------------------------
   The September 2026 audit. Measured against an identical run with the event
   forced off, the whole untreated reaction was worth MAP -15.5, HR +5.5 and
   SpO2 -3.3 at its worst, and it then cleared itself in 145s and drifted up to
   MAP 107 - so doing nothing was the winning move. Five separate causes:

     - the "sympathetic surge" was a per-tick push on alphaTone/betaTone
       (structural trap #1), worth +0.046 of tone, i.e. +2.2 bpm - and because
       alphaTone raises SVR it lifted MAP +5.5, so the reaction opened by making
       the patient look better. It also ran only between SYMP_START and
       VASOPLEGIA_START, so it decayed away as the hypotension arrived.
     - the vasoplegia peak was cut 1.25 -> 0.25 in v3.75 to lift the nadir from
       22 to ~48, and was never re-measured after the model's baseline rose
       ~25 mmHg. By v4.42 the nadir was 74.
     - no capillary leak existed at all, while objective 3 and hint 4 both
       taught volume resuscitation. 2L of crystalloid left MAP 90 against 100
       for doing nothing, and SpO2 90 against 96.
     - adrenaline advanced anaphylaxisTimer to max(timer, decayStart)+dose*100,
       which for a patient still on the rising limb jumped them FORWARD to near
       peak vasoplegia: 100 mcg at t=30s dropped MAP 86 -> 70 within 5s. The
       faster a trainee treated correctly, the worse the monitor got.
     - the co-triggered bronchospasm reached resistance 21 of 80 - 26% of what
       the model's own bronchospasm scenario delivers - and never resolved.
   ========================================================================== */
probe('F18', 'Anaphylaxis presents dramatically, and treatment helps', () => {

    /** Run the scenario, optionally with the event suppressed, sampling 1 Hz. */
    function runAnaph(opts) {
        opts = opts || {};
        const sim = boot(); const dl = sim.dl;
        dl.loadScenario('anaphylaxis');
        if (opts.noEvent) { dl.state.events.anaphylaxis = false; dl.state.anaphExitPushdown = 0; }
        const acts = (opts.acts || []).slice();
        const rows = [];
        for (let s = 1; s <= (opts.dur || 600); s++) {
            while (acts.length && acts[0].t === s) acts.shift().do(dl);
            sim.advance(1000);
            rows.push({ t: s, map: mapOf(dl), hr: dl.state.hr,
                        raw: dl.state.patient.bronchResistance,
                        vol: dl.state.patient.centralVolume,
                        beta: dl.state.betaTone, spo2: dl.state.spo2,
                        sev: dl.state.anaphSeverity, res: dl.state.anaphResolution,
                        bronch: !!dl.state.events.bronchospasm });
        }
        return { rows, at: t => rows[t - 1], errors: sim.errors,
                 minMap: Math.min(...rows.map(r => r.map)),
                 maxHr:  Math.max(...rows.map(r => r.hr)),
                 maxRaw: Math.max(...rows.map(r => r.raw)),
                 maxBeta: Math.max(...rows.map(r => r.beta)) };
    }
    const ADR = (t, d) => ({ t, do: dl => give(dl, 'adr', d) });
    const FLU = (t, d) => ({ t, do: dl => give(dl, 'flu', d) });

    const un   = runAnaph();
    const ctrl = runAnaph({ noEvent: true });

    /* 1. The reaction is worth something. Both limbs, against the control. */
    const dMap = ctrl.at(120).map - un.at(120).map;
    const dHr  = un.at(120).hr - ctrl.at(120).hr;
    note(`untreated vs event-off control at t=120s: MAP ${un.at(120).map.toFixed(0)} vs ` +
         `${ctrl.at(120).map.toFixed(0)} (-${dMap.toFixed(0)}), HR ${un.at(120).hr.toFixed(0)} vs ` +
         `${ctrl.at(120).hr.toFixed(0)} (+${dHr.toFixed(0)}), nadir MAP ${un.minMap.toFixed(0)}`);
    expect(un.minMap <= 55 && dMap >= 30,
        'the untreated reaction produces real hypotension',
        `nadir MAP ${un.minMap.toFixed(0)}, ${dMap.toFixed(0)} mmHg below the event-off control`,
        'MAP nadir <= 55 and >= 30 mmHg of it attributable to the reaction (was 74 and 15)');
    expect(un.maxHr >= 125 && dHr >= 25,
        'the untreated reaction produces real tachycardia',
        `peak HR ${un.maxHr.toFixed(0)}, ${dHr.toFixed(0)} bpm above the event-off control`,
        'HR >= 125 with >= 25 bpm from the reaction (the trap #1 push gave +2.2)');

    /* 2. The early phase must not make the patient look BETTER. */
    const earlyRise = un.at(25).map - ctrl.at(25).map;
    expect(earlyRise < 6,
        'the early surge does not raise MAP appreciably',
        `MAP at t=25s is ${earlyRise.toFixed(1)} above the event-off control`,
        'under 6 mmHg - a beta-dominant surge, not an alpha one that defends the BP');

    /* 3. It must not resolve itself. This is the one that made doing nothing
          the winning move. */
    expect(un.at(600).map <= 60 && un.at(600).sev > 0.9,
        'an untreated reaction does not resolve on its own',
        `at t=600s MAP ${un.at(600).map.toFixed(0)}, severity ${un.at(600).sev.toFixed(2)}`,
        'MAP still <= 60 and severity still > 0.9 (v3.63-v4.42 cleared it by 145s)');

    /* 4. Capillary leak exists, and fluid given is RETAINED rather than being
          drained straight back out (which is what a floor-based leak did). */
    const volDrop = 5.0 - Math.min(...un.rows.map(r => r.vol));
    const fl = runAnaph({ acts: [FLU(60, 1.0)] });
    note(`circulating volume: untreated falls to ${Math.min(...un.rows.map(r => r.vol)).toFixed(2)} L; ` +
         `with 1L at t=60s it is ${fl.at(600).vol.toFixed(2)} L at t=600s ` +
         `(MAP ${un.at(600).map.toFixed(0)} -> ${fl.at(600).map.toFixed(0)})`);
    expect(volDrop >= 1.0,
        'the reaction causes a capillary leak',
        `central volume falls ${volDrop.toFixed(2)} L`,
        '>= 1.0 L, so the scenario\'s own "aggressive volume resuscitation" has a target');
    expect(fl.at(600).vol > un.at(600).vol + 0.8 && fl.at(600).map > un.at(600).map + 5,
        'fluid given is retained and raises the pressure',
        `volume ${un.at(600).vol.toFixed(2)} -> ${fl.at(600).vol.toFixed(2)} L, ` +
        `MAP ${un.at(600).map.toFixed(0)} -> ${fl.at(600).map.toFixed(0)}`,
        'the leak caps total loss rather than pinning the volume to a floor');

    /* 5. Adrenaline must never make the patient acutely worse. Checked against
          the untreated run over the same window, because MAP is falling anyway
          during the rise phase. */
    let worstPenalty = -Infinity, worstT = 0;
    for (const tGive of [30, 40, 50, 60]) {
        const r = runAnaph({ acts: [ADR(tGive, 0.1)], dur: tGive + 15 });
        for (let k = 1; k <= 10; k++) {
            const pen = un.at(tGive + k).map - r.at(tGive + k).map;   // >0 = treated is worse
            if (pen > worstPenalty) { worstPenalty = pen; worstT = tGive; }
        }
    }
    expect(worstPenalty < 1.0,
        'adrenaline never transiently worsens the pressure',
        `worst deficit against the untreated run in the 10s after a dose: ` +
        `${worstPenalty.toFixed(1)} mmHg (dose at t=${worstT}s)`,
        'never worse than doing nothing (the v3.63 timer advance cost 16 mmHg at t=30s)');

    /* 6. Dose-response climbs monotonically, and one bolus is not a cure. */
    const d1 = runAnaph({ acts: [ADR(60, 0.1)] });
    const d3 = runAnaph({ acts: [ADR(60, 0.1), ADR(100, 0.1), ADR(140, 0.1)] });
    const d5 = runAnaph({ acts: [ADR(60, 0.1), ADR(100, 0.1), ADR(140, 0.1),
                                 ADR(180, 0.1), ADR(220, 0.1)] });
    note(`adrenaline dose-response at t=600s: 1x100mcg res ${d1.at(600).res.toFixed(2)} ` +
         `MAP ${d1.at(600).map.toFixed(0)}; 3x res ${d3.at(600).res.toFixed(2)} ` +
         `MAP ${d3.at(600).map.toFixed(0)}; 5x res ${d5.at(600).res.toFixed(2)} ` +
         `MAP ${d5.at(600).map.toFixed(0)}`);
    expect(d1.at(600).res < d3.at(600).res && d3.at(600).res < d5.at(600).res
           && d1.at(600).map < d3.at(600).map && d3.at(600).map < d5.at(600).map,
        'the adrenaline dose-response is monotonic',
        `resolution ${d1.at(600).res.toFixed(2)} < ${d3.at(600).res.toFixed(2)} < ` +
        `${d5.at(600).res.toFixed(2)}; MAP ${d1.at(600).map.toFixed(0)} < ` +
        `${d3.at(600).map.toFixed(0)} < ${d5.at(600).map.toFixed(0)}`,
        'more adrenaline resolves more of the reaction and raises MAP further');
    expect(d1.at(600).res < 0.4 && d1.at(600).map < 70,
        'one bolus is a response, not a cure',
        `1x100mcg leaves resolution ${d1.at(600).res.toFixed(2)}, MAP ${d1.at(600).map.toFixed(0)}`,
        'partial - the hints say titrate to response, so one dose must not finish it');

    /* 7. The respiratory limb is comparable to the model's own bronchospasm
          scenario, and reverses with adrenaline. */
    const bsim = boot(); bsim.dl.loadScenario('bronchospasm'); bsim.advance(600000);
    const bsRaw = bsim.dl.state.patient.bronchResistance;
    note(`airway resistance: anaphylaxis untreated peaks ${un.maxRaw.toFixed(0)}, ` +
         `the bronchospasm scenario settles ${bsRaw.toFixed(0)}, ` +
         `anaphylaxis + 3x100mcg adrenaline ends ${d3.at(600).raw.toFixed(0)}`);
    expect(un.maxRaw >= 0.8 * bsRaw,
        'the co-triggered bronchospasm is as severe as the bronchospasm scenario',
        `anaphylaxis ${un.maxRaw.toFixed(0)} vs bronchospasm scenario ${bsRaw.toFixed(0)}`,
        'within 20% (was 21 vs 49, because sevo and betaTone attenuated it first)');
    expect(d3.at(600).raw < un.at(600).raw - 10,
        'adrenaline relieves the bronchospasm',
        `resistance at t=600s: untreated ${un.at(600).raw.toFixed(0)}, ` +
        `treated ${d3.at(600).raw.toFixed(0)}`,
        'a real fall - the endogenous-surge discount must not block DRUG beta relief');

    /* 8. Guards the oscillation the release path introduced: BRONCH_PROB is 999,
          i.e. deterministic, so without a one-shot latch the release and the
          co-trigger flip the event every tick and the log grows without bound. */
    const cured = runAnaph({ acts: [ADR(60, 0.5), ADR(120, 0.5)], dur: 900 });
    const flips = cured.rows.reduce((n, r, i) =>
        n + (i > 0 && r.bronch !== cured.rows[i - 1].bronch ? 1 : 0), 0);
    note(`with 1mg of adrenaline the reaction resolves (severity ${cured.at(900).sev.toFixed(2)}) ` +
         `and the bronchospasm event flips ${flips} time(s) in 900s; tick errors ${cured.errors.length}`);
    expect(flips <= 2 && cured.errors.length === 0,
        'the resolving bronchospasm is released once, not oscillated',
        `${flips} event flips over 900s, ${cured.errors.length} tick errors`,
        'at most 2 (on, then off) - the co-trigger is latched to once per reaction');

    /* 9. The surge must leave headroom below BETA_CLAMP, or every beta drug and
          beta blocker given afterwards has a flat dose-response. This is the
          half of trap #1 that the v4.36 parasympTone finding was about. */
    const clamp = boot().dl.CONFIG.BETA_CLAMP;
    const surgeOnly = Math.max(...un.rows.filter(r => r.t <= 40).map(r => r.beta));
    note(`betaTone from the surge alone (to t=40s, before the baroreflex dominates): ` +
         `${surgeOnly.toFixed(2)} against BETA_CLAMP ${clamp}`);
    expect(surgeOnly < clamp - 0.15,
        'the sympathetic surge leaves headroom below the beta clamp',
        `betaTone reaches ${surgeOnly.toFixed(2)} of a ${clamp} clamp`,
        'clear of the clamp, so a beta drug given afterwards still has an effect');
});

/* =============================================================================
   F19  myocardial ischaemia never moves the blood pressure, and its own
        recommended treatment cannot heal it
   -----------------------------------------------------------------------------
   The September 2026 audit, measured against an identical run with the event
   forced off. Four findings:

     - BP never fell. state.ischaemia had exactly two consumers in the whole
       model: the ECG morphology, and one contractility push-down capped at
       ISCHAEMIA_CONTR_DROP 0.20. Contractility went 0.95 -> 0.80 and stopped;
       the baroreflex absorbed it. MAP dipped 107 -> 98 at t=74s and was back at
       104 by t=600, ending at BP 135/83 - higher than its own trough.
     - The scenario never presented its briefed numbers. setupBrief promises
       "HR 105, BP 150/95"; SBP peaked at 139 and settled 128-135. The event-off
       control reached 154/95 exactly, so the briefing had been written against
       the NON-ischaemic haemodynamics and the contractility drop then removed
       15-20 mmHg of it.
     - It saturated and then did nothing. state.ischaemia hit 1.00 at t=144s and
       clamped, while the underlying imbalance went on climbing 1.10 -> 1.31 with
       nowhere to show it. The last seven and a half minutes were static: no
       progression, no arrhythmia, no route to the cardiogenic shock objective 1
       names.
     - No hint-derived plan could heal it. Every plan within the hints' stated
       doses left ischaemia at 1.00, including the sweep's own transcription.
       The cause was not the model's calibration: esmolol is well calibrated
       (50mg takes HR 104 -> 89 at nadir) but a bolus wears off with a ~9 min
       half-life while the surgical stimulus persists indefinitely, and hint 3
       said "esmolol 25-50mg slow IV" without saying to repeat it. Probe F15
       masked this by stacking two 50mg boluses onto a remifentanil rate of 0.5
       at t=0 - it never tested a hint-derived plan.

   v4.44 splits the haemodynamic consequence into state.ischaemiaStun, a slow
   follower of the score, so the ECG changes first and the pressure follows;
   deepens ISCHAEMIA_CONTR_DROP to 0.50; lightens the scenario's opioid cover so
   the briefed opening numbers are actually on the monitor; and rewrites hint 3
   to teach titration. ISCHAEMIA_HR_REF is deliberately unchanged.
   ========================================================================== */
probe('F19', 'Ischaemia moves the blood pressure, and titrated rate control heals it', () => {

    /** Run the scenario under a plan, sampling at 1 Hz. Actions are dispatched
        order-independently (as sweep.js does) - a while-loop over an unsorted
        list silently drops everything after the first out-of-order entry. */
    function run(opts) {
        opts = opts || {};
        const sim = boot(); const dl = sim.dl;
        dl.loadScenario('ischaemia');
        if (opts.noEvent) { dl.state.events.ischaemia = false; dl.state.ischaemia = 0; }
        // Cardiac output has no state field - it is computed in the gauge's own
        // getter, so read it the way the Physiology tab does.
        const coSpec = gaugeSpecs(dl).find(g => g.key === 'co');
        const pending = (opts.acts || []).map(a => ({ ...a, done: false }));
        const rows = [];
        for (let s = 1; s <= (opts.dur || 600); s++) {
            pending.forEach(a => { if (!a.done && a.t === s) { a.done = true; a.do(dl); } });
            sim.advance(1000);
            const st = dl.state;
            rows.push({ t: s, map: mapOf(dl), sys: st.sys, dia: st.dia, hr: st.hr,
                        co: coSpec.spec.get(), isch: st.ischaemia, stun: st.ischaemiaStun,
                        contract: st.patient.contractility });
        }
        return { rows, at: t => rows[t - 1], errors: sim.errors,
                 maxSys: Math.max(...rows.map(r => r.sys)),
                 undone: pending.filter(a => !a.done).length };
    }
    const ESMO = (t, d) => ({ t, do: dl => give(dl, 'esmo', d) });
    const REMI = (t, r) => ({ t, do: dl => dl.setInf('remi', r) });
    const METAR = (t, d) => ({ t, do: dl => give(dl, 'metar', d) });
    const SEVO = (t, v) => ({ t, do: dl => dl.setVentParam('sevo', v) });

    const un = run();

    /* 1. The scenario opens on the hypertensive picture its briefing describes.
          setupBrief says "HR 105, BP 150/95". */
    const open = un.at(20);
    note(`opening (t=20s): BP ${open.sys.toFixed(0)}/${open.dia.toFixed(0)}, ` +
         `HR ${open.hr.toFixed(0)}, ischaemia ${open.isch.toFixed(2)} - briefed as HR 105, BP 150/95`);
    expect(open.sys >= 145 && open.hr >= 100,
        'the scenario presents the hypertensive demand picture it briefs',
        `BP ${open.sys.toFixed(0)}/${open.dia.toFixed(0)}, HR ${open.hr.toFixed(0)} at t=20s`,
        'SBP >= 145 and HR >= 100 (the old cover held it at 141/87, HR 99)');

    /* 2. And then the pressure FALLS - the finding that started this audit. */
    const late = un.at(600);
    const fall = open.sys - late.sys;
    note(`untreated trajectory: BP ${open.sys.toFixed(0)}/${open.dia.toFixed(0)} at t=20s -> ` +
         `${un.at(180).sys.toFixed(0)}/${un.at(180).dia.toFixed(0)} at t=180s -> ` +
         `${late.sys.toFixed(0)}/${late.dia.toFixed(0)} at t=600s; ` +
         `CO ${un.at(20).co.toFixed(1)} -> ${late.co.toFixed(1)} L/min`);
    expect(fall >= 22 && late.map < open.map - 15,
        'the untreated blood pressure falls as the myocardium stuns',
        `SBP falls ${fall.toFixed(0)} mmHg (${open.sys.toFixed(0)} -> ${late.sys.toFixed(0)}), ` +
        `MAP ${open.map.toFixed(0)} -> ${late.map.toFixed(0)}`,
        '>= 22 mmHg of systolic fall (was an 8 mmHg dip that then recovered)');
    expect(late.co < un.at(20).co - 1.0,
        'cardiac output falls too, rather than being held up by the tachycardia',
        `CO ${un.at(20).co.toFixed(1)} -> ${late.co.toFixed(1)} L/min`,
        'a real fall - untreated CO used to RISE, 6.4 -> 6.6, as HR climbed');

    /* 3. The two phases are genuinely separated: the ECG sign arrives while the
          pressure is still high, which is the recognition moment. */
    note(`phase separation: at t=60s ischaemia ${un.at(60).isch.toFixed(2)} but stun only ` +
         `${un.at(60).stun.toFixed(2)}, BP still ${un.at(60).sys.toFixed(0)}/${un.at(60).dia.toFixed(0)}`);
    expect(un.at(60).isch > 0.8 && un.at(60).stun < 0.35 && un.at(60).sys > 135,
        'the ECG changes lead the haemodynamic collapse',
        `at t=60s: ischaemia ${un.at(60).isch.toFixed(2)}, stun ${un.at(60).stun.toFixed(2)}, ` +
        `SBP ${un.at(60).sys.toFixed(0)}`,
        'score already high while stun is low and the pressure is still up');

    /* 4. It must not go static. Before v4.44 the score clamped at 1.0 by t=144s
          and nothing moved again for seven and a half minutes. */
    expect(un.at(600).stun > un.at(180).stun + 0.2 && un.at(600).contract < un.at(180).contract,
        'deterioration continues after the score saturates',
        `stun ${un.at(180).stun.toFixed(2)} -> ${un.at(600).stun.toFixed(2)}, ` +
        `contractility ${un.at(180).contract.toFixed(2)} -> ${un.at(600).contract.toFixed(2)}`,
        'the lagged stun carries the progression the clamped score cannot');

    /* 5. A single esmolol bolus is not enough, but titrating to a rate target
          is - which is what hint 3 now says, and what the old hint did not. */
    const single = run({ acts: [ESMO(60, 50)] });
    const titrated = run({ acts: [ESMO(60, 50), ESMO(150, 50), ESMO(240, 50), ESMO(330, 50)] });
    note(`esmolol: one 50mg bolus -> HR ${single.at(600).hr.toFixed(0)}, ischaemia ` +
         `${single.at(600).isch.toFixed(2)}; titrated 4 x 50mg -> HR ` +
         `${titrated.at(600).hr.toFixed(0)}, ischaemia ${titrated.at(600).isch.toFixed(2)}`);
    expect(single.at(600).isch > 0.8,
        'a single esmolol bolus does not heal it',
        `one 50mg bolus leaves ischaemia ${single.at(600).isch.toFixed(2)} at HR ${single.at(600).hr.toFixed(0)}`,
        'still ischaemic - the bolus wears off while the stimulus does not');
    expect(titrated.at(600).isch < 0.6 && titrated.at(600).isch < single.at(600).isch - 0.3,
        'titrating esmolol to a rate target does heal it',
        `4 x 50mg leaves ischaemia ${titrated.at(600).isch.toFixed(2)} at HR ${titrated.at(600).hr.toFixed(0)}`,
        'clearly better than a single dose - rate control has to be sustained');

    /* 6. The sweep's own plan - the hints, transcribed - must now work, and must
          work better than the same plan without the DBP support, because supply
          is proportional to diastolic pressure. */
    const full = run({ acts: [REMI(60, 0.25), ESMO(90, 50), METAR(95, 1),
                              ESMO(180, 50), ESMO(270, 50)] });
    const noPressor = run({ acts: [REMI(60, 0.25), ESMO(90, 50),
                                   ESMO(180, 50), ESMO(270, 50)] });
    note(`hint-derived plan: with metaraminol ischaemia ${full.at(600).isch.toFixed(2)} at ` +
         `BP ${full.at(600).sys.toFixed(0)}/${full.at(600).dia.toFixed(0)}; without it ` +
         `${noPressor.at(600).isch.toFixed(2)} at ` +
         `${noPressor.at(600).sys.toFixed(0)}/${noPressor.at(600).dia.toFixed(0)}`);
    expect(full.at(600).isch < 0.3,
        "the scenario's own recommended management heals it",
        `ischaemia ${full.at(600).isch.toFixed(2)} at HR ${full.at(600).hr.toFixed(0)}, ` +
        `BP ${full.at(600).sys.toFixed(0)}/${full.at(600).dia.toFixed(0)}`,
        '< 0.3 - every hint-derived plan used to leave it pinned at 1.00');
    expect(full.at(600).isch < noPressor.at(600).isch,
        'defending the diastolic pressure improves the outcome (objective 4)',
        `with metaraminol ${full.at(600).isch.toFixed(2)} vs without ${noPressor.at(600).isch.toFixed(2)}`,
        'better - supply is proportional to DBP, so a pressor earns its place');

    /* 7. Deep volatile is the trap the hints warn about: it cuts demand but
          collapses the diastolic pressure the coronaries are perfused by. */
    const sevoHeavy = run({ acts: [SEVO(60, 2.5), REMI(62, 0.3), ESMO(90, 50),
                                   ESMO(180, 50), ESMO(270, 50)] });
    note(`sevo-heavy variant: BP ${sevoHeavy.at(600).sys.toFixed(0)}/` +
         `${sevoHeavy.at(600).dia.toFixed(0)}, ischaemia ${sevoHeavy.at(600).isch.toFixed(2)} ` +
         `(vs ${full.at(600).sys.toFixed(0)}/${full.at(600).dia.toFixed(0)} for the DBP-sparing plan)`);
    expect(sevoHeavy.at(600).dia < full.at(600).dia - 5,
        'deepening the volatile costs diastolic pressure',
        `DBP ${sevoHeavy.at(600).dia.toFixed(0)} vs ${full.at(600).dia.toFixed(0)} for the DBP-sparing plan`,
        'lower - which is the trade-off hints 2 and 4 are warning about');

    /* 8. The mistakes the objectives name must still be mistakes. */
    const pressorOnly = run({ acts: [METAR(60, 1)] });
    const fluidOnly = run({ acts: [{ t: 60, do: dl => give(dl, 'flu', 0.5) }] });
    note(`mistakes: metaraminol alone -> ischaemia ${pressorOnly.at(600).isch.toFixed(2)} at ` +
         `BP ${pressorOnly.at(600).sys.toFixed(0)}/${pressorOnly.at(600).dia.toFixed(0)}; ` +
         `500mL fluid -> ${fluidOnly.at(600).isch.toFixed(2)}`);
    expect(pressorOnly.at(600).isch > 0.8 && fluidOnly.at(600).isch > 0.8,
        'a pressor or fluid alone, without addressing demand, still fails',
        `metaraminol alone ${pressorOnly.at(600).isch.toFixed(2)}, ` +
        `fluid ${fluidOnly.at(600).isch.toFixed(2)}`,
        'both still ischaemic - objective 5 and the fluid hint stay honest');

    /* 9. Sanity: no dropped actions, no tick errors anywhere above. */
    const allRuns = [un, single, titrated, full, noPressor, sevoHeavy, pressorOnly, fluidOnly];
    const errs = allRuns.reduce((n, r) => n + r.errors.length, 0);
    const drops = allRuns.reduce((n, r) => n + r.undone, 0);
    expect(errs === 0 && drops === 0,
        'every run completes with no tick errors and no dropped actions',
        `${errs} tick errors, ${drops} undelivered actions across ${allRuns.length} runs`,
        'zero of each');
});

/* =============================================================================
   F20  post-induction hypotension self-corrects in ten seconds
   -----------------------------------------------------------------------------
   The September 2026 six-scenario audit. The scenario's whole premise did not
   exist. Briefing and setupBrief both promise "MAP sitting at 55 and not
   improving"; measured, MAP was 56 at t=1, 70 by t=10 and 83 by t=600.

   MAP 55 was a startup transient, not a state: scenarioReset() snaps BP to the
   elderly profile's mapTarget, alphaTone starts at ALPHA_REST (0.2), and the
   tick drives it to its nociception-4 target over ~2s. t=1 caught the trough on
   the way up. Consequences: objective 5 ("aim for MAP > 65 within 1-2 minutes")
   was already met untreated at t=10, hint 5's "5-10 minutes at MAP 55" was ten
   seconds, and the scenario's own metaraminol + fluid landed on a recovered
   patient and drove MAP to 108-118.

   Fixed by nociception 4 -> 2, which is what objective 3 already claimed
   ("no surgical stimulus yet to drive sympathetic tone") and what the setup
   comment already claimed ("not yet enough to drive a clinically useful
   sympathetic response"). Volume stays at 0.92 - nociception, not hypovolaemia,
   was holding the pressure up.
   ========================================================================== */
probe('F20', 'Post-induction hypotension actually sits at MAP 55', () => {

    function run(acts, dur) {
        const sim = boot(); const dl = sim.dl;
        dl.loadScenario('hypotensionPostInd');
        const pending = (acts || []).map(a => ({ ...a, done: false }));
        const rows = [];
        for (let s = 1; s <= (dur || 600); s++) {
            pending.forEach(a => { if (!a.done && a.t === s) { a.done = true; a.do(dl); } });
            sim.advance(1000);
            rows.push({ t: s, map: mapOf(dl), hr: dl.state.hr, bis: dl.state.bis });
        }
        return { rows, at: t => rows[t - 1], errors: sim.errors,
                 undone: pending.filter(a => !a.done).length };
    }
    const METAR = (t, d) => ({ t, do: dl => give(dl, 'metar', d) });
    const EPHED = (t, d) => ({ t, do: dl => give(dl, 'ephed', d) });
    const FLU   = (t, d) => ({ t, do: dl => give(dl, 'flu', d) });
    const SEVO  = (t, v) => ({ t, do: dl => dl.setVentParam('sevo', v) });

    const un = run();

    /* 1. The briefed pressure is a STATE, not a one-second transient. */
    const early = [5, 15, 30, 60].map(t => un.at(t).map);
    note(`untreated MAP: t=5 ${un.at(5).map.toFixed(0)}, t=30 ${un.at(30).map.toFixed(0)}, ` +
         `t=60 ${un.at(60).map.toFixed(0)}, t=120 ${un.at(120).map.toFixed(0)}, ` +
         `t=300 ${un.at(300).map.toFixed(0)}, t=600 ${un.at(600).map.toFixed(0)}`);
    expect(early.every(m => m >= 50 && m <= 60),
        'the scenario genuinely sits at the briefed MAP 55',
        `MAP at t=5/15/30/60 = ${early.map(m => m.toFixed(0)).join('/')}`,
        'all within 50-60 (it used to be 56 then 70 by t=10)');

    /* 2. It must not self-correct out of the teaching window. Objective 1's
          target is >65; a trainee needs time to notice and act. */
    const cross = un.rows.find(r => r.map > 65);
    note(`untreated MAP first exceeds objective 1's 65 target at t=${cross ? cross.t : 'never'}`);
    expect(cross && cross.t >= 180,
        'it does not recover past the treatment target on its own for minutes',
        `first MAP > 65 at t=${cross ? cross.t : 'never'}`,
        '>= 180s, so there is something to recognise and treat (was t=10)');

    /* 3. But hint 5 promises it DOES slowly creep up as propofol redistributes,
          so it must not be frozen either. */
    expect(un.at(600).map > un.at(30).map + 8,
        'it still slowly creeps up over ten minutes, as hint 5 describes',
        `MAP ${un.at(30).map.toFixed(0)} at t=30 -> ${un.at(600).map.toFixed(0)} at t=600`,
        'a real upward drift - the hint describes propofol redistributing');

    /* 4. Objective 4 lists four options and says they "all work". Each must
          reach objective 5's target, and the two pressors must differ on HR in
          the direction hints 6 and 7 explain. */
    const metar = run([METAR(60, 0.5)]);
    const ephed = run([EPHED(60, 6)]);
    const fluid = run([FLU(60, 0.5)]);
    const sevo  = run([SEVO(60, 1.5)]);
    /* Checked at t=300, not t=180: hints 3 and 4 explicitly rank fluid and a
       sevo reduction as the SLOW options ("1-2 minutes to peak effect",
       "takes 3-5 minutes"), so requiring all four inside three minutes would
       assert against the scenario's own teaching. The speed ranking is the
       separate check below. */
    note(`at t=300 - metaraminol 0.5mg ${metar.at(300).map.toFixed(0)} (HR ${metar.at(300).hr.toFixed(0)}), ` +
         `ephedrine 6mg ${ephed.at(300).map.toFixed(0)} (HR ${ephed.at(300).hr.toFixed(0)}), ` +
         `500mL ${fluid.at(300).map.toFixed(0)}, sevo 1.5% ${sevo.at(300).map.toFixed(0)}; ` +
         `untreated ${un.at(300).map.toFixed(0)}`);
    expect([metar, ephed, fluid, sevo].every(r => r.at(300).map > 65),
        'all four of objective 4\'s options reach the target',
        `MAP at t=300: metaraminol ${metar.at(300).map.toFixed(0)}, ephedrine ` +
        `${ephed.at(300).map.toFixed(0)}, fluid ${fluid.at(300).map.toFixed(0)}, ` +
        `sevo ${sevo.at(300).map.toFixed(0)}`,
        'all > 65 - objective 4 says they all work');
    expect(metar.at(300).hr < un.at(300).hr && ephed.at(300).hr > un.at(300).hr,
        'metaraminol slows the heart and ephedrine speeds it (hints 6 and 7)',
        `untreated HR ${un.at(300).hr.toFixed(0)}, metaraminol ${metar.at(300).hr.toFixed(0)}, ` +
        `ephedrine ${ephed.at(300).hr.toFixed(0)}`,
        'opposite directions - baroreflex vs direct beta');

    /* 5. A pressor must act faster than fluid or a sevo reduction - hints 2, 3
          and 4 rank them explicitly. */
    const t65 = r => { const c = r.rows.find(x => x.t > 60 && x.map > 65); return c ? c.t : Infinity; };
    note(`time to MAP > 65: metaraminol ${t65(metar)}s, ephedrine ${t65(ephed)}s, ` +
         `fluid ${t65(fluid)}s, sevo ${t65(sevo)}s`);
    expect(t65(metar) < t65(fluid) && t65(ephed) < t65(fluid),
        'the pressors act faster than fluid, as hints 2 and 3 rank them',
        `metaraminol ${t65(metar)}s and ephedrine ${t65(ephed)}s vs fluid ${t65(fluid)}s`,
        'both pressors quicker - "effect within 10-30 seconds" vs "1-2 minutes"');

    /* 6. And the recommended management must not overshoot into hypertension,
          which is what treating an already-recovered patient used to do. */
    const plan = run([METAR(60, 0.5), FLU(61, 0.25)]);
    const peak = Math.max(...plan.rows.map(r => r.map));
    note(`sweep plan (metaraminol 0.5mg + 250mL): peak MAP ${peak.toFixed(0)}, ` +
         `t=600 ${plan.at(600).map.toFixed(0)}`);
    expect(peak < 95 && plan.at(180).map > 65,
        'the recommended management corrects without overshooting',
        `peak MAP ${peak.toFixed(0)}, MAP ${plan.at(180).map.toFixed(0)} at t=180`,
        'target reached, peak under 95 (full doses on a recovered patient hit 118)');

    expect(un.errors.length === 0 && un.undone === 0,
        'the scenario runs clean',
        `${un.errors.length} tick errors, ${un.undone} undelivered actions`,
        'zero of each');
});

/* =============================================================================
   F21  haemorrhage bled at a constant rate, whatever the pressure
   -----------------------------------------------------------------------------
   The September 2026 six-scenario audit. Two faults, one root cause.

   The tick drained `p.bleedRate * dt` per tick regardless of the patient's
   circulation, so a severe bleed was a fixed 25 mL/s tap. Consequences:

     - The scenario emptied the patient to the 0.5 L centralVolume floor by
       t=130 and then pinned MAP at 21-24 for the remaining 28 minutes.
     - More importantly it made objective 2 ("recognise the limits of pressors
       without volume; avoid masking under-resuscitation") and hints 4-5
       unteachable. Raising the pressure with fluid and metaraminol cost the
       patient nothing, because the hole leaked at the same rate whether MAP
       was 25 or 95. Permissive hypotension is the whole point of the scenario
       and the model could not express it.

   Fixed by scaling the rate with MAP about BLEED_MAP_REF (75), clamped to
   BLEED_MAP_MIN_FRAC..BLEED_MAP_MAX_FRAC. A named severity is a rate AT A
   GIVEN PRESSURE, not a constant.

   Separately, the briefing and setupBrief both promise "MAP 65" and the
   scenario did not open there: MAP read 61 for one tick, climbed to 74.7 by
   t=5 and only fell back through 65 at t=40 - the same structural-trap-1
   startup transient that v4.47 fixed in post-induction hypotension. Here the
   nociception is correct (the surgeon really is opening), so the fix seeds
   alphaTone/betaTone at their settled values and drops centralVolume to the
   fraction that then reads 65.
   ========================================================================== */
probe('F21', 'Haemorrhage scales with perfusion pressure, and opens at MAP 65', () => {

    function run(acts, dur) {
        const sim = boot(); const dl = sim.dl;
        dl.loadScenario('haemorrhage');
        const specs = gaugeSpecs(dl);
        const co = specs.find(g => g.key === 'co').spec;
        const pending = (acts || []).map(a => ({ ...a, done: false }));
        const rows = []; let lost = 0;
        for (let s = 1; s <= (dur || 600); s++) {
            pending.forEach(a => { if (!a.done && a.t === s) { a.done = true; a.do(dl); } });
            sim.advance(1000);
            lost += dl.state.patient.effectiveBleedRate;
            rows.push({ t: s, map: mapOf(dl), hr: dl.state.hr, co: co.get(),
                        vol: dl.state.patient.centralVolume, lost });
        }
        return { rows, at: t => rows[t - 1], lost, errors: sim.errors,
                 undone: pending.filter(a => !a.done).length };
    }
    const FLU   = (t, d) => ({ t, do: dl => give(dl, 'flu', d) });
    const METAR = (t, d) => ({ t, do: dl => give(dl, 'metar', d) });
    /* Clicking the active severity toggles bleeding off, as the surgeon
       controlling the source does in the UI. */
    const SOURCE = t => ({ t, do: dl => { if (dl.state.bleedSeverity) dl.setBleed(dl.state.bleedSeverity); } });

    const un = run(null, 600);

    /* 1. The briefed opening pressure is a STATE, not a transient on the way
          up to something else. Both briefing and setupBrief say MAP 65. */
    const open = [1, 5, 10].map(t => un.at(t).map);
    note(`untreated MAP: t=1 ${un.at(1).map.toFixed(0)}, t=5 ${un.at(5).map.toFixed(0)}, ` +
         `t=10 ${un.at(10).map.toFixed(0)}, t=60 ${un.at(60).map.toFixed(0)}, ` +
         `t=120 ${un.at(120).map.toFixed(0)}, t=300 ${un.at(300).map.toFixed(0)}`);
    expect(Math.abs(open[0] - 65) <= 3,
        'the scenario opens at the briefed MAP 65',
        `MAP ${open[0].toFixed(1)} at t=1`,
        'within 3 of 65 (it used to read 61 then climb to 74.7)');

    /* 2. And it must fall from there, not rise. The old startup transient
          showed a trainee an exsanguinating patient who appeared to improve
          for the first half-minute. */
    expect(open[1] < open[0] && open[2] < open[1],
        'pressure falls from the opening value rather than climbing',
        `MAP t=1 ${open[0].toFixed(1)} -> t=5 ${open[1].toFixed(1)} -> t=10 ${open[2].toFixed(1)}`,
        'monotonically down (it used to rise to 74.7 by t=5)');

    /* 3. The untreated bleed is still lethal in the direction the setupBrief
          promises ("expect further blood loss until source is controlled"). */
    expect(un.at(300).map < 35,
        'an uncontrolled severe bleed produces profound shock',
        `MAP ${un.at(300).map.toFixed(0)} and CO ${un.at(300).co.toFixed(1)} L/min at t=300`,
        'MAP under 35');

    /* 4. THE FINDING. Blood loss must depend on the pressure the trainee
          maintains. Three plans, identical source control at t=180, differing
          only in how hard the pressure was pushed beforehand. */
    const permissive = run([FLU(20, 1.0), SOURCE(180)], 300);
    const moderate   = run([FLU(20, 1.0), FLU(80, 1.0), SOURCE(180)], 300);
    const aggressive = run([FLU(20, 1.0), FLU(50, 1.0), FLU(80, 1.0), METAR(60, 1),
                            FLU(110, 1.0), METAR(150, 1), SOURCE(180)], 300);
    const meanMap = r => r.rows.reduce((a, b) => a + b.map, 0) / r.rows.length;
    note(`blood lost by t=300: permissive ${permissive.lost.toFixed(2)} L ` +
         `(mean MAP ${meanMap(permissive).toFixed(0)}), moderate ${moderate.lost.toFixed(2)} L ` +
         `(${meanMap(moderate).toFixed(0)}), aggressive ${aggressive.lost.toFixed(2)} L ` +
         `(${meanMap(aggressive).toFixed(0)})`);
    expect(permissive.lost < moderate.lost && moderate.lost < aggressive.lost,
        'the harder the pressure is pushed, the more blood is lost',
        `${permissive.lost.toFixed(2)} < ${moderate.lost.toFixed(2)} < ${aggressive.lost.toFixed(2)} L`,
        'strictly increasing - objective 2 and hints 4-5 depend on this');
    expect(aggressive.lost - permissive.lost > 0.75,
        'the cost of over-resuscitation is large enough to teach',
        `aggressive loses ${(aggressive.lost - permissive.lost).toFixed(2)} L more than permissive`,
        'more than 0.75 L (it used to be exactly 0.00 - a constant rate)');

    /* 5. The flip side, and the reason permissive hypotension is a strategy
          rather than an end in itself: with the source NOT controlled,
          aggressive resuscitation buys a good-looking pressure and then loses
          it, because the volume went out of the hole. */
    const aggrNoSource = run([FLU(20, 1.0), FLU(50, 1.0), FLU(80, 1.0), METAR(60, 1),
                              FLU(110, 1.0), METAR(150, 1), FLU(140, 1.0)], 600);
    note(`aggressive WITHOUT source control: MAP ${aggrNoSource.at(180).map.toFixed(0)} at t=180, ` +
         `${aggrNoSource.at(300).map.toFixed(0)} at t=300, ${aggrNoSource.at(600).map.toFixed(0)} at t=600`);
    expect(aggrNoSource.at(180).map > 70 && aggrNoSource.at(600).map < 40,
        'resuscitating hard into an uncontrolled bleed looks good, then fails',
        `MAP ${aggrNoSource.at(180).map.toFixed(0)} at t=180 -> ${aggrNoSource.at(600).map.toFixed(0)} at t=600`,
        'above 70 early, below 40 by t=600');

    /* 6. Hint 5 and objective 4: once the source is controlled, resuscitation
          works and holds. This is the scenario's win condition. */
    const good = run([SOURCE(60), FLU(20, 1.0), FLU(80, 1.0)], 600);
    note(`early source control + 2 L: MAP ${good.at(180).map.toFixed(0)} at t=180, ` +
         `${good.at(600).map.toFixed(0)} at t=600, volume ${good.at(600).vol.toFixed(2)} L`);
    expect(good.at(600).map > 70 && good.at(600).vol > 2.5,
        'early source control plus volume is a recoverable, held result',
        `MAP ${good.at(600).map.toFixed(0)} and ${good.at(600).vol.toFixed(2)} L circulating at t=600`,
        'MAP over 70, volume over 2.5 L');

    /* 7. Hint 1 ("volume comes first") must be true, and its converse: stopping
          the leak on an empty patient does nothing without filling them. */
    const sourceOnly = run([SOURCE(400)], 600);
    const fluidOnly  = run([FLU(400, 1.0), FLU(430, 1.0)], 600);
    const both       = run([SOURCE(400), FLU(405, 1.0), FLU(435, 1.0)], 600);
    note(`late rescue at t=400 -> MAP at t=600: source only ${sourceOnly.at(600).map.toFixed(0)}, ` +
         `fluid only ${fluidOnly.at(600).map.toFixed(0)}, both ${both.at(600).map.toFixed(0)}`);
    expect(both.at(600).map > 60 && sourceOnly.at(600).map < 30 && fluidOnly.at(600).map < 40,
        'neither source control nor volume alone rescues - the pair does',
        `source only ${sourceOnly.at(600).map.toFixed(0)}, fluid only ${fluidOnly.at(600).map.toFixed(0)}, ` +
        `both ${both.at(600).map.toFixed(0)}`,
        'only the combination exceeds MAP 60');

    expect(un.errors.length === 0 && un.undone === 0 && aggressive.undone === 0,
        'the scenario runs clean',
        `${un.errors.length} tick errors, ${un.undone + aggressive.undone} undelivered actions`,
        'zero of each');
});

/* =============================================================================
   F22  the septic patient woke up, and nothing in the scenario mentioned it
   -----------------------------------------------------------------------------
   The September 2026 six-scenario audit. Not a physiology bug - a contract one.

   The setup leaves `vent.sevo = 0` ("just induced, sevo not started yet"),
   which is realistic for that instant, but nothing maintained anaesthesia and
   none of the three objectives mentioned it. So a trainee who did everything
   the scenario asked still watched BIS go 43 -> 86, crossing 60 at t=202.

   The wake then CAUSED a second, entirely unannounced event: a bronchospasm at
   t=431 (VT 450 -> 67, etCO2 60 -> 106). Causation, not coincidence - sevo
   1.5% from t=30 holds BIS at 33-41 and the spasm never fires at all. The
   septic profile's airwayReactivity is 0.3, so a light patient spasming is the
   model behaving correctly.

   Separately, the setup's own RR 14 x VT 450 cannot hold etCO2 for a patient
   the profile gives metabolicMultiplier 1.5: untreated it climbed 38 -> 60 by
   t=420 before the bronchospasm contributed anything.

   Fixed in TEXT ONLY (v4.49) - the physiology is right, the instructions were
   missing. New objective 3 (start and maintain anaesthesia, and accept it will
   drop the pressure further), new objective 4 (match minute ventilation to the
   septic metabolic rate), four new hints, and the briefed BP corrected from
   75/45 to the 70/43 the scenario actually holds.

   This probe therefore guards the scenario TEXT against the model, which is
   what CLAUDE.md's "scenario text is part of the model's contract" asks for.
   ========================================================================== */
probe('F22', 'The septic laparotomy tells the trainee to keep the patient asleep', () => {

    function run(acts, dur) {
        const sim = boot(); const dl = sim.dl;
        dl.loadScenario('sepsis');
        const pending = (acts || []).map(a => ({ ...a, done: false }));
        const rows = [];
        for (let s = 1; s <= (dur || 600); s++) {
            pending.forEach(a => { if (!a.done && a.t === s) { a.done = true; a.do(dl); } });
            sim.advance(1000);
            rows.push({ t: s, map: mapOf(dl), hr: dl.state.hr, bis: dl.state.bis,
                        etco2: dl.state.etco2, sys: dl.state.sys, dia: dl.state.dia,
                        broncho: !!dl.state.events.bronchospasm });
        }
        return { rows, at: t => rows[t - 1], errors: sim.errors, dl,
                 undone: pending.filter(a => !a.done).length };
    }
    const SEVO  = (t, v) => ({ t, do: dl => dl.setVentParam('sevo', v) });
    const RR    = (t, v) => ({ t, do: dl => dl.setVentParam('rr', v) });
    const METAR = (t, d) => ({ t, do: dl => give(dl, 'metar', d) });
    const FLU   = (t, d) => ({ t, do: dl => give(dl, 'flu', d) });
    const NOR   = (t, r) => ({ t, do: dl => dl.setInf('nor', r) });

    const un = run(null, 600);
    const sc = un.dl.SCENARIOS.sepsis;

    /* 1. The briefed opening pressure is what the scenario holds. It is a
          steady state here, not a transient - the setup seeds alphaTone and
          betaTone at the septic profile's rest values, so nothing settles. */
    const o = un.at(1);
    note(`opening BP ${o.sys.toFixed(0)}/${o.dia.toFixed(0)} (MAP ${o.map.toFixed(0)}), ` +
         `holding ${un.at(60).sys.toFixed(0)}/${un.at(60).dia.toFixed(0)} at t=60`);
    expect(/70\/43/.test(sc.briefing) && /70\/43/.test(sc.setupBrief) &&
           Math.abs(o.sys - 70) <= 3 && Math.abs(o.dia - 43) <= 3,
        'both briefing texts quote the pressure the scenario actually opens at',
        `texts say 70/43, model gives ${o.sys.toFixed(0)}/${o.dia.toFixed(0)}`,
        'agreement within 3 mmHg (the texts used to say 75/45)');

    /* 2. THE FINDING. Untreated, the patient wakes - so there must be an
          objective that tells the trainee to prevent it. */
    const wake = un.rows.find(r => r.bis > 60);
    note(`untreated BIS: t=1 ${un.at(1).bis.toFixed(0)}, t=300 ${un.at(300).bis.toFixed(0)}, ` +
         `t=600 ${un.at(600).bis.toFixed(0)}; crosses 60 at t=${wake ? wake.t : 'never'}`);
    expect(wake && un.at(600).bis > 80,
        'the untreated patient really does wake, so there is something to teach',
        `BIS crosses 60 at t=${wake ? wake.t : 'never'}, reaching ${un.at(600).bis.toFixed(0)} at t=600`,
        'a genuine wake - this is the behaviour the new objective covers');
    const objText = sc.objectives.join(' | ').toLowerCase();
    const hintText = sc.hints.join(' | ').toLowerCase();
    expect(/anaesthes|asleep|volatile|sevo/.test(objText),
        'an objective tells the trainee to maintain anaesthesia',
        `objectives mention it: ${/anaesthes|asleep|volatile|sevo/.test(objText)}`,
        'true - three objectives used to run for ten minutes without saying so');
    expect(/sevo|vaporiser/.test(hintText),
        'a hint points at the vaporiser being at zero',
        `hints mention sevoflurane or the vaporiser: ${/sevo|vaporiser/.test(hintText)}`,
        'true');

    /* 3. The bronchospasm is CAUSED by the wake, not merely coincident with
          it. This is the check that says the physiology was never the bug. */
    const spasm = un.rows.find(r => r.broncho);
    const kept  = run([SEVO(30, 1.5)], 600);
    const keptSpasm = kept.rows.find(r => r.broncho);
    note(`untreated bronchospasm at t=${spasm ? spasm.t : 'never'}; ` +
         `with sevo 1.5% from t=30, BIS peaks ${Math.max(...kept.rows.map(r => r.bis)).toFixed(0)} ` +
         `and bronchospasm fires ${keptSpasm ? 't=' + keptSpasm.t : 'never'}`);
    expect(spasm && !keptSpasm,
        'the unannounced bronchospasm is downstream of the wake, not independent',
        `untreated t=${spasm ? spasm.t : 'never'}, anaesthetised: never`,
        'fires untreated, never when the patient is kept asleep');
    expect(/bronchospasm|airway/.test(hintText),
        'a hint warns that a light septic patient can spasm',
        `hints mention it: ${/bronchospasm|airway/.test(hintText)}`,
        'true - it used to ambush the trainee with no text anywhere');

    /* 4. Objective 3's trade-off must be real: maintaining anaesthesia has to
          COST pressure, otherwise the objective is free and teaches nothing. */
    note(`MAP at t=600: untreated ${un.at(600).map.toFixed(0)}, ` +
         `sevo 1.5% ${kept.at(600).map.toFixed(0)}`);
    expect(un.at(600).map - kept.at(600).map > 8,
        'keeping the patient asleep genuinely worsens the hypotension',
        `MAP ${un.at(600).map.toFixed(0)} untreated vs ${kept.at(600).map.toFixed(0)} on sevo`,
        'more than 8 mmHg apart - this is the tension objective 3 names');

    /* 5. Objective 4: the setup's own ventilation cannot hold etCO2 for this
          patient's metabolic rate, and that is true BEFORE any bronchospasm. */
    const preSpasm = spasm ? spasm.t - 1 : 420;
    note(`untreated etCO2 ${un.at(1).etco2.toFixed(0)} at t=1 -> ` +
         `${un.at(preSpasm).etco2.toFixed(0)} at t=${preSpasm}, before any bronchospasm`);
    expect(un.at(preSpasm).etco2 > 55,
        'the scenario\'s own RR x VT cannot hold etCO2 at the septic metabolic rate',
        `etCO2 reaches ${un.at(preSpasm).etco2.toFixed(0)} by t=${preSpasm} with no spasm yet`,
        'above 55 - objective 4 exists because of this');
    const vent = run([SEVO(30, 1.5), RR(32, 20)], 600);
    expect(vent.at(600).etco2 < 46,
        'and raising the rate fixes it, so the objective is achievable',
        `etCO2 ${vent.at(600).etco2.toFixed(0)} at t=600 on RR 20`,
        'under 46');
    expect(/ventilation|etco2|co2|rr /.test(objText + ' ' + hintText),
        'an objective or hint points at minute ventilation',
        `texts mention it: ${/ventilation|etco2|co2|rr /.test(objText + ' ' + hintText)}`,
        'true');

    /* 6. The whole recommended management, as sweep.js now runs it, must give
          a patient who is asleep, ventilated and perfused. */
    const plan = run([SEVO(30, 1.5), RR(32, 20), METAR(60, 1), FLU(61, 0.5), NOR(90, 0.1)], 600);
    const maxBis = Math.max(...plan.rows.map(r => r.bis));
    const planSpasm = plan.rows.find(r => r.broncho);
    note(`recommended management: peak BIS ${maxBis.toFixed(0)}, ` +
         `etCO2 ${plan.at(600).etco2.toFixed(0)}, MAP ${plan.at(180).map.toFixed(0)} at t=180 ` +
         `and ${plan.at(600).map.toFixed(0)} at t=600, bronchospasm ${planSpasm ? 'YES' : 'never'}`);
    expect(maxBis < 60 && !planSpasm && plan.at(600).etco2 < 50 && plan.at(600).map > 65,
        'the scenario\'s own recommended management now produces a safe anaesthetic',
        `peak BIS ${maxBis.toFixed(0)}, no spasm, etCO2 ${plan.at(600).etco2.toFixed(0)}, ` +
        `MAP ${plan.at(600).map.toFixed(0)}`,
        'asleep throughout, no spasm, etCO2 under 50, MAP above the profile target');

    expect(un.errors.length === 0 && plan.errors.length === 0 && plan.undone === 0,
        'the scenario runs clean',
        `${un.errors.length + plan.errors.length} tick errors, ${plan.undone} undelivered actions`,
        'zero of each');
});

/* -----------------------------------------------------------------------------
   summary
   -------------------------------------------------------------------------- */
const all = results.flatMap(r => r.checks);
const failed = all.filter(c => !c.pass);

console.log('\n' + '='.repeat(78));
console.log('SUMMARY');
console.log('='.repeat(78));
results.forEach(r => {
    const bad = r.checks.filter(c => !c.pass).length;
    console.log(`  ${r.id.padEnd(5)} ${bad === 0 ? 'FIXED  ' : 'open   '} ` +
        `${r.checks.length - bad}/${r.checks.length} checks pass   ${r.title}`);
});
console.log(`\n${all.length - failed.length}/${all.length} checks pass across ${results.length} findings.`);
if (failed.length) console.log('Probes reporting FAIL describe bugs that are still open.');

if (process.env.DL_STRICT === '1' && failed.length) process.exit(1);
