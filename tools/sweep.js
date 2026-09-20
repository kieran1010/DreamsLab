/* =============================================================================
   SWEEP  --  run every scenario twice and record all 22 Physiology gauges
   -----------------------------------------------------------------------------
   For each scenario: one untreated run (no user action at all) and one treated
   run applying that scenario's own recommended management, transcribed from its
   `objectives` and `hints` in index.html.

   Treatments go through the same public functions the UI calls -- giveBolus(),
   setInf(), setVentParam(), setAirway(), setVentMode(), toggleEvent() -- so the
   runs exercise real user paths rather than poking state directly.

   Output: results.json, consumed by scan.js and trace.js.

       node tools/sweep.js
       DL_DURATION=1200 DL_SAMPLE=10 node tools/sweep.js
   ============================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const { boot, gaugeSpecs, sampleGauges, give, DEFAULT_SEED } = require('./harness');

const DURATION = parseInt(process.env.DL_DURATION || '600', 10);  // simulated seconds
const SAMPLE   = parseInt(process.env.DL_SAMPLE   || '5',   10);  // seconds between samples
const SEED     = parseInt(process.env.DL_SEED || String(DEFAULT_SEED), 10);
const OUT      = path.join(__dirname, 'results.json');

/* Non-gauge context captured alongside the gauges, for diagnosis. */
function extras(dl) {
    const s = dl.state, p = s.patient;
    return {
        sys: s.sys, dia: s.dia, mac: s.mac, bis: s.bis, rhythm: s.rhythm,
        peak: s.peakPressure, minuteVent: s.minuteVent, effRR: s.effectiveRR,
        etSevo: s.etSevo, tof: s.tofCount,
        propCe: p.propCe, remiCe: p.remiCe, fentCe: p.fentCe, rocCe: p.rocCe,
        metarCe: p.metarCe, adrCe: p.adrCe, norCe: p.norCe, salbCe: p.salbCe,
        esmoCe: p.esmoCe, gtnCe: p.gtnCe, atropCe: p.atropCe, dantCe: p.dantCe,
        ischaemia: s.ischaemia, peShunt: s.peShunt, aspInjury: s.aspirationInjury,
        mhSev: s.mhSeverity, anaphT: s.anaphylaxisTimer, lastT: s.lastTimer,
        vagalT: s.vagalTimer, bleedRate: p.bleedRate, fluidBuffer: p.fluidBuffer,
        airway: p.airway, ventMode: s.machine.vent.mode,
        pumps: { ...s.machine.pumps },
        frcO2: p.frcO2, alveolarFiO2: p.alveolarFiO2, metabolicRate: s.metabolicRate,
        awarenessRisk: s.awarenessRisk, reactivityRisk: p.reactivityRisk,
        analgesiaCover: s.analgesiaCover, effectiveStimulus: s.effectiveStimulus,
        nociTarget: s.nociceptionTarget,
        events: Object.keys(s.events).filter(k => s.events[k]),
    };
}

/* v4.57: every action time shifts by the standard onset lead-in.

   Scenarios now open on a patient who looks normal and deteriorate after
   CONFIG.ONSET_LEAD_IN seconds, so a plan written against the old behaviour
   treats a pathology that has not happened yet. Several did: the vagal plan
   released the surgeon's stimulus at t=20, before the bradycardia existed at
   all, and the MH plan turned the vaporiser off before the etCO2 had moved -
   so the "treated" run was not a treatment, it was prophylaxis, and comparing
   it against the untreated run measured nothing.

   Shifting the whole plan rather than editing times one by one keeps every
   tuned INTERVAL intact (the emergence plan's sevo-off -> remi-off ->
   sugammadex -> extubate sequence, the bronchospasm escalation ladder), which
   is where the calibration actually lives.

   `induction` is exempt: nothing is wrong with that patient, there is no
   pathology to wait for, and its eleven steps are a walkthrough the trainee
   drives from t=0. */
const LEAD_IN = 20;
const PLAN_EXEMPT = new Set(['induction']);
function planFor(key) {
    const plan = TREATMENTS[key] || [];
    if (PLAN_EXEMPT.has(key)) return plan;
    return plan.map(a => ({ ...a, t: a.t + LEAD_IN }));
}

/**
 * Run one scenario for `durationSec`, applying `plan` (an array of
 * { t, label, do }) at the given simulated second.
 */
function runScenario(key, plan, durationSec, sampleEvery, seed = SEED) {
    const sim = boot({ seed });
    const dl = sim.dl;
    const specs = gaugeSpecs(dl);

    dl.loadScenario(key);

    const rows = [];
    const fired = [];
    const pending = (plan || []).map(a => ({ ...a, done: false }));
    const push = t => rows.push({ t, ...sampleGauges(specs), _x: extras(dl) });

    push(0);
    for (let t = 1; t <= durationSec; t++) {
        pending.forEach(a => {
            if (a.done || a.t !== t) return;
            a.done = true;
            try { a.do(dl); fired.push({ t, label: a.label }); }
            catch (e) { fired.push({ t, label: a.label, error: String(e.message || e) }); }
        });
        sim.advance(1000);
        if (t % sampleEvery === 0) push(t);
    }

    return {
        key, rows, events: fired,
        errors: sim.errors.slice(0, 20),
        specs: specs.map(s => ({ group: s.group, key: s.key, label: s.label, unit: s.unit })),
    };
}

/* -----------------------------------------------------------------------------
   Recommended treatments, transcribed from each scenario's own briefing text.
   Keep these in step with index.html when scenario hints change.
   -------------------------------------------------------------------------- */
const V = (dl, k, v) => dl.setVentParam(k, v);

const TREATMENTS = {
    // The 11-step walkthrough the scenario itself lays out.
    induction: [
        { t: 2,   label: 'Pre-oxygenate: FiO2 1.0, FGF 8',   do: dl => { V(dl, 'fio2', 1.0); V(dl, 'fgf', 8); } },
        { t: 185, label: 'Propofol 150mg',                   do: dl => { give(dl, 'prop', 100); give(dl, 'prop', 50); } },
        { t: 186, label: 'Fentanyl 100mcg',                  do: dl => give(dl, 'fent', 0.1) },
        { t: 187, label: 'Metaraminol 1mg (prophylactic)',   do: dl => give(dl, 'metar', 1) },
        { t: 250, label: 'Rocuronium 50mg',                  do: dl => give(dl, 'roc', 50) },
        { t: 340, label: 'Intubate (airway -> ETT)',         do: dl => dl.setAirway('ett') },
        { t: 345, label: 'Ventilator -> VCV',                do: dl => dl.setVentMode('VCV') },
        { t: 350, label: 'Sevoflurane 1.5%',                 do: dl => V(dl, 'sevo', 1.5) },
    ],
    // v4.47: dosed down to the bottom of objective 4's stated ranges
    // ("Metaraminol 0.5-1mg", "Crystalloid 250-500mL"). The old full-dose pair
    // was landing MAP at 106 - but that was treating a patient who had already
    // self-corrected to 70 before the treatment fired. With the scenario now
    // genuinely sitting at 55, the lower doses reach objective 5's ">65 within
    // 1-2 minutes" without overshooting into hypertension.
    hypotensionPostInd: [
        { t: 60, label: 'Metaraminol 0.5mg',  do: dl => give(dl, 'metar', 0.5) },
        { t: 61, label: 'Crystalloid 250mL',  do: dl => give(dl, 'flu', 0.25) },
    ],
    maintenance: [],   // stable-baseline scenario; nothing to treat
    sepsis: [
        // v4.49: sevo and RR added to match the new objectives 3 and 4. Without
        // them the "treated" run woke the patient (BIS 86) and was bronchospasming
        // by t=431 while the sweep recorded it as the recommended management.
        { t: 30, label: 'Sevoflurane 1.5%',           do: dl => V(dl, 'sevo', 1.5) },
        { t: 32, label: 'RR up to 20',                do: dl => V(dl, 'rr', 20) },
        { t: 60, label: 'Metaraminol 1mg',            do: dl => give(dl, 'metar', 1) },
        { t: 61, label: 'Crystalloid 500mL',          do: dl => give(dl, 'flu', 0.5) },
        { t: 90, label: 'Noradrenaline infusion 0.1', do: dl => dl.setInf('nor', 0.1) },
    ],
    anaphBrewing: [
        { t: 90,  label: 'Adrenaline 100mcg',  do: dl => give(dl, 'adr', 0.1) },
        { t: 95,  label: 'Crystalloid 1000mL', do: dl => give(dl, 'flu', 1.0) },
        { t: 150, label: 'Adrenaline 100mcg',  do: dl => give(dl, 'adr', 0.1) },
    ],
    paedLap: [],
    asthma: [],
    // v4.43: retimed and re-dosed for the reworked reaction. The old plan
    // started at t=30, before there was anything on the monitor to react to,
    // and gave 2L into a patient whose circulating volume never moved. The
    // reaction now declares itself from ~t=30 (MAP falling, HR climbing), so
    // first bolus at 50 is a fast-but-plausible recognition; 1L answers the
    // capillary leak, which takes ~1.2L out; and the boluses are spaced 40s to
    // match the hints' "titrated to response" rather than stacked.
    anaphylaxis: [
        { t: 50,  label: 'Adrenaline 100mcg',  do: dl => give(dl, 'adr', 0.1) },
        { t: 55,  label: 'Crystalloid 1000mL', do: dl => give(dl, 'flu', 1.0) },
        { t: 90,  label: 'Adrenaline 100mcg',  do: dl => give(dl, 'adr', 0.1) },
        { t: 130, label: 'Adrenaline 100mcg',  do: dl => give(dl, 'adr', 0.1) },
    ],
    aspiration: [
        { t: 20, label: 'FiO2 1.0',               do: dl => V(dl, 'fio2', 1.0) },
        { t: 25, label: 'Suction airway',         do: dl => dl.suctionAirway() },
        { t: 45, label: 'Intubate (airway->ETT)', do: dl => dl.setAirway('ett') },
        { t: 50, label: 'Ventilator -> VCV',      do: dl => dl.setVentMode('VCV') },
        { t: 55, label: 'PEEP 8',                 do: dl => V(dl, 'peep', 8) },
        { t: 60, label: 'Suction airway again',   do: dl => dl.suctionAirway() },
        { t: 70, label: 'Salbutamol 250mcg',      do: dl => give(dl, 'salb', 0.25) },
    ],
    bronchospasm: [
        /* v4.50: was sevo 3% on top of undiminished propofol TIVA, then
           adrenaline 100 mcg at t=90. That is every hint applied at once
           rather than an escalation, and it showed: BIS bottomed at 9.8 and
           the adrenaline - given at a point where resistance had already
           fallen to 11.6 - swung MAP to 130 and HR to 140. Hint 6 offers
           adrenaline for REFRACTORY cases, and this plan never becomes one.

           Now a clinician's escalation: open the expiratory time, oxygenate,
           add volatile while backing the propofol off so the two do not stack,
           then salbutamol and magnesium. Stops when it works. Peak BIS 17,
           peak MAP 83, peak HR 117, resistance 9.2 and Vt 559 by t=180.
           The refractory adrenaline path is covered by probe F23 instead. */
        { t: 20, label: 'RR down to 8',       do: dl => V(dl, 'rr', 8) },
        { t: 22, label: 'FiO2 1.0',           do: dl => V(dl, 'fio2', 1.0) },
        { t: 25, label: 'Sevoflurane 2%',     do: dl => V(dl, 'sevo', 2.0) },
        { t: 25, label: 'Propofol TIVA 8->4', do: dl => dl.setInf('prop', 4) },
        { t: 30, label: 'Salbutamol 250mcg',  do: dl => give(dl, 'salb', 0.25) },
        { t: 60, label: 'Magnesium 2g',       do: dl => give(dl, 'mag', 2.0) },
    ],
    haemorrhage: [
        { t: 20,  label: 'Crystalloid 1000mL', do: dl => give(dl, 'flu', 1.0) },
        { t: 60,  label: 'Crystalloid 1000mL', do: dl => give(dl, 'flu', 1.0) },
        { t: 70,  label: 'Metaraminol 1mg',    do: dl => give(dl, 'metar', 1) },
        // Clicking the active severity toggles bleeding off, as disableEvent() does.
        { t: 180, label: 'Surgeon controls source', do: dl => { if (dl.state.bleedSeverity) dl.setBleed(dl.state.bleedSeverity); } },
        { t: 200, label: 'Crystalloid 1000mL', do: dl => give(dl, 'flu', 1.0) },
    ],
    emergence: [
        /* v4.52: the plan stopped at sugammadex and never took the tube out,
           so the "recommended management" for a scenario whose own description
           says "smooth emergence AND EXTUBATION" left an awake patient
           intubated - which is precisely what fires the bronchospasm at t=292
           (SpO2 min 85, etCO2 55, MAP 133). Extubating prevents it entirely.
           Now extubates to Mask once reversed and switches to Manual so the
           patient breathes for themselves: no spasm, SpO2 min 99, MAP 112. */
        { t: 30,  label: 'Sevoflurane off',   do: dl => V(dl, 'sevo', 0) },
        { t: 32,  label: 'Remifentanil off',  do: dl => dl.setInf('remi', 0) },
        { t: 35,  label: 'Sugammadex 200mg',  do: dl => give(dl, 'sug', 200) },
        /* v4.56: 120/121 -> 60/61. The remifentanil seed was 2.8x the level
           its own pump sustains, so the patient used to wake slowly and the
           spasm fired at t=292; extubating at 120 comfortably beat it. With
           the seed corrected the wake is faster and the spasm fires at t=91,
           so a plan that extubates at 120 arrives after the hazard it is
           meant to avoid. Extubating at 60 prevents it as before. */
        { t: 60,  label: 'Extubate to mask',  do: dl => dl.setAirway('mask') },
        { t: 61,  label: 'Vent to Manual',    do: dl => dl.setVentMode('MANUAL') },
    ],
    tiva: [],
    aneurysm: [
        { t: 30, label: 'Esmolol 30mg', do: dl => give(dl, 'esmo', 30) },
        { t: 45, label: 'GTN 200mcg',   do: dl => give(dl, 'gtn', 0.2) },
        { t: 90, label: 'GTN 200mcg',   do: dl => give(dl, 'gtn', 0.2) },
    ],
    autonomicDysreflexia: [
        { t: 30, label: 'Surgeon stops stimulus (noci -> 0)', do: dl => dl.setNoci(0) },
        { t: 35, label: 'GTN 200mcg',                        do: dl => give(dl, 'gtn', 0.2) },
    ],
    vagal: [
        { t: 20, label: 'Surgeon releases (vagal event off)', do: dl => { if (dl.state.events.vagal) dl.toggleEvent('vagal'); } },
        { t: 25, label: 'Atropine 0.6mg',                    do: dl => give(dl, 'atrop', 0.6) },
    ],
    // v4.44: retimed and re-dosed. The old plan gave a single esmolol 30mg and
    // left ischaemia pinned at 1.00 for the whole run - the scenario's own
    // recommended management was inert against its own model. Two things were
    // wrong. A single bolus wears off (esmolol t1/2 ~9 min) while the surgical
    // stimulus does not, so rate control has to be TITRATED; and the plan leant
    // on deep sevo, which collapses the diastolic pressure the coronaries are
    // perfused by. This plan does what hint 3 now says: opioid up, esmolol
    // repeated to a rate target, and metaraminol to defend the DBP.
    ischaemia: [
        { t: 60,  label: 'Remifentanil up to 0.15',       do: dl => dl.setInf('remi', 0.15) },
        { t: 90,  label: 'Esmolol 50mg',                  do: dl => give(dl, 'esmo', 50) },
        { t: 95,  label: 'Metaraminol 1mg (defend DBP)',  do: dl => give(dl, 'metar', 1) },
        { t: 180, label: 'Esmolol 50mg (titrate)',        do: dl => give(dl, 'esmo', 50) },
        { t: 270, label: 'Esmolol 50mg (titrate)',        do: dl => give(dl, 'esmo', 50) },
        { t: 275, label: 'Metaraminol 1mg (defend DBP)',  do: dl => give(dl, 'metar', 1) },
    ],
    pulmEmbolism: [
        { t: 20, label: 'FiO2 1.0',                     do: dl => V(dl, 'fio2', 1.0) },
        { t: 30, label: 'Metaraminol 1mg',              do: dl => give(dl, 'metar', 1) },
        { t: 60, label: 'Noradrenaline infusion 0.15',  do: dl => dl.setInf('nor', 0.15) },
        { t: 90, label: 'Crystalloid 250mL (cautious)', do: dl => give(dl, 'flu', 0.25) },
    ],
    // NB the scenario objective says "adrenaline boluses (100mcg-1mg) for ROSC",
    // but only doses >= CONFIG.ARREST_ADR_CREDIT_DOSE (500 mcg) earn a rescue
    // credit, and CONFIG.ARREST_REVIVE_THRESHOLD (3) are needed. A trainee
    // following the objective with 100 mcg boluses never achieves ROSC.
    last: [
        { t: 20,  label: 'Intubate (airway -> ETT)', do: dl => dl.setAirway('ett') },
        { t: 25,  label: 'Ventilate: VCV, FiO2 1.0', do: dl => { dl.setVentMode('VCV'); V(dl, 'fio2', 1.0); } },
        { t: 90,  label: 'Adrenaline 500mcg',        do: dl => give(dl, 'adr', 0.5) },
        { t: 150, label: 'Adrenaline 500mcg',        do: dl => give(dl, 'adr', 0.5) },
        { t: 210, label: 'Adrenaline 500mcg',        do: dl => give(dl, 'adr', 0.5) },
    ],
    mh: [
        { t: 20, label: 'Sevoflurane off (stop trigger)', do: dl => V(dl, 'sevo', 0) },
        { t: 22, label: 'FGF 10 (washout)',               do: dl => V(dl, 'fgf', 10) },
        { t: 25, label: 'Propofol infusion 8 (TIVA)',     do: dl => dl.setInf('prop', 8) },
        { t: 30, label: 'Dantrolene 200mg',               do: dl => give(dl, 'dant', 1.0) },
        { t: 35, label: 'Hyperventilate: RR 20, Vt 600',  do: dl => { V(dl, 'rr', 20); V(dl, 'vt', 600); } },
    ],
};

/* -----------------------------------------------------------------------------
   main
   -------------------------------------------------------------------------- */
function main() {
    const keys = Object.keys(boot().dl.SCENARIOS);
    const results = {};
    let totalErrors = 0;

    for (const key of keys) {
        process.stderr.write('  ' + key.padEnd(22));
        const untreated = runScenario(key, [], DURATION, SAMPLE);
        const treated   = runScenario(key, planFor(key), DURATION, SAMPLE);
        totalErrors += untreated.errors.length + treated.errors.length;
        results[key] = {
            untreated, treated,
            treatmentPlan: planFor(key).map(a => ({ t: a.t, label: a.label })),
        };
        process.stderr.write(`ok  (runtime errors: ${untreated.errors.length + treated.errors.length})\n`);
    }

    fs.writeFileSync(OUT, JSON.stringify(results));
    console.log(`\n${keys.length} scenarios x 2 runs x ${DURATION}s, sampled every ${SAMPLE}s, seed ${SEED}`);
    console.log(`runtime errors across all runs: ${totalErrors}`);
    console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
    console.log('next: node tools/scan.js');
}

if (require.main === module) main();

module.exports = { runScenario, TREATMENTS, planFor };
