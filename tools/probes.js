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

const { boot, resolve, give } = require('./harness');

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
