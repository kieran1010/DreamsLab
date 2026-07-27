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
    hypotensionPostInd: [
        { t: 60, label: 'Metaraminol 1mg',   do: dl => give(dl, 'metar', 1) },
        { t: 61, label: 'Crystalloid 500mL', do: dl => give(dl, 'flu', 0.5) },
    ],
    maintenance: [],   // stable-baseline scenario; nothing to treat
    sepsis: [
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
    anaphylaxis: [
        { t: 30,  label: 'Adrenaline 100mcg',  do: dl => give(dl, 'adr', 0.1) },
        { t: 35,  label: 'Crystalloid 1000mL', do: dl => give(dl, 'flu', 1.0) },
        { t: 60,  label: 'Adrenaline 100mcg',  do: dl => give(dl, 'adr', 0.1) },
        { t: 90,  label: 'Adrenaline 100mcg',  do: dl => give(dl, 'adr', 0.1) },
        { t: 120, label: 'Crystalloid 1000mL', do: dl => give(dl, 'flu', 1.0) },
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
        { t: 20, label: 'RR down to 8',      do: dl => V(dl, 'rr', 8) },
        { t: 22, label: 'FiO2 1.0',          do: dl => V(dl, 'fio2', 1.0) },
        { t: 25, label: 'Sevoflurane 3%',    do: dl => V(dl, 'sevo', 3.0) },
        { t: 30, label: 'Salbutamol 250mcg', do: dl => give(dl, 'salb', 0.25) },
        { t: 45, label: 'Magnesium 2g',      do: dl => give(dl, 'mag', 2.0) },
        { t: 90, label: 'Adrenaline 100mcg', do: dl => give(dl, 'adr', 0.1) },
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
        { t: 30, label: 'Sevoflurane off',  do: dl => V(dl, 'sevo', 0) },
        { t: 32, label: 'Remifentanil off', do: dl => dl.setInf('remi', 0) },
        { t: 35, label: 'Sugammadex 200mg', do: dl => give(dl, 'sug', 200) },
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
    ischaemia: [
        { t: 60,  label: 'Sevoflurane 2.0% (deepen)',     do: dl => V(dl, 'sevo', 2.0) },
        { t: 62,  label: 'Fentanyl 100mcg',               do: dl => give(dl, 'fent', 0.1) },
        { t: 90,  label: 'Esmolol 30mg',                  do: dl => give(dl, 'esmo', 30) },
        { t: 150, label: 'Metaraminol 0.5mg (raise DBP)', do: dl => give(dl, 'metar', 0.5) },
    ],
    pulmEmbolism: [
        { t: 20, label: 'FiO2 1.0',                     do: dl => V(dl, 'fio2', 1.0) },
        { t: 30, label: 'Metaraminol 1mg',              do: dl => give(dl, 'metar', 1) },
        { t: 60, label: 'Noradrenaline infusion 0.15',  do: dl => dl.setInf('nor', 0.15) },
        { t: 90, label: 'Crystalloid 250mL (cautious)', do: dl => give(dl, 'flu', 0.25) },
    ],
    last: [
        { t: 90,  label: 'Adrenaline 100mcg', do: dl => give(dl, 'adr', 0.1) },
        { t: 120, label: 'Adrenaline 100mcg', do: dl => give(dl, 'adr', 0.1) },
        { t: 150, label: 'Adrenaline 100mcg', do: dl => give(dl, 'adr', 0.1) },
        { t: 180, label: 'Adrenaline 500mcg', do: dl => give(dl, 'adr', 0.5) },
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
        const treated   = runScenario(key, TREATMENTS[key] || [], DURATION, SAMPLE);
        totalErrors += untreated.errors.length + treated.errors.length;
        results[key] = {
            untreated, treated,
            treatmentPlan: (TREATMENTS[key] || []).map(a => ({ t: a.t, label: a.label })),
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

module.exports = { runScenario, TREATMENTS };
