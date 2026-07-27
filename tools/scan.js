/* =============================================================================
   SCAN  --  automated anomaly detection over the sweep results
   -----------------------------------------------------------------------------
   Reads results.json and flags, per scenario and per gauge:

     BUG   NaN / undefined values, or values outside the gauge's own declared
           min..max (the bar clips and the trainee loses the trend)
     CLIN  clinically implausible steady states at the end of the run
     WARN  a gauge pinned at its floor or ceiling for most of the run
     INFO  a gauge that never moves at all

   Plus a treatment-effect table comparing the end of the treated and untreated
   runs, which is where "the recommended treatment makes it worse" shows up.

       node tools/scan.js
   ============================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const { boot, resolve } = require('./harness');

const RESULTS = path.join(__dirname, 'results.json');
if (!fs.existsSync(RESULTS)) {
    console.error('results.json not found -- run `node tools/sweep.js` first.');
    process.exit(1);
}
const R = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));

/* Gauge ranges come from the app itself, so the scan tracks any retuning. */
const dl = boot().dl;
const RANGE = {};
Object.keys(dl.PHYS_GROUPS).forEach(g => dl.PHYS_GROUPS[g].forEach(i => {
    if (i.section) return;
    RANGE[i.key] = { min: resolve(i.min), max: resolve(i.max), label: i.label, colour: i.colour };
}));

/* Gauges whose resting value legitimately sits on the floor. */
const FLOOR_OK = ['noci', 'autoPEEP', 'paralysis', 'bbBlock'];
/* Gauges that legitimately never move (operator-set, not model-driven). */
const STATIC_OK = ['fio2', 'bbBlock'];

const findings = [];
const add = (sev, scen, run, key, msg) => findings.push({ sev, scen, run, key, msg });

function analyse(scen, runName, run) {
    const rows = run.rows;
    const n = rows.length;

    Object.keys(RANGE).forEach(k => {
        const vals = rows.map(r => r[k]);
        const nulls = vals.filter(v => v === null).length;
        if (nulls) { add('BUG', scen, runName, k, `${nulls}/${n} samples NaN or undefined`); return; }

        const { min, max } = RANGE[k];
        const atMax = vals.filter(v => v >= max - 1e-9).length;
        const atMin = vals.filter(v => v <= min + 1e-9).length;
        if (atMax / n > 0.5) add('WARN', scen, runName, k, `pinned at gauge max (${max}) for ${atMax}/${n} samples`);
        if (atMin / n > 0.5 && !FLOOR_OK.includes(k)) add('WARN', scen, runName, k, `pinned at gauge min (${min}) for ${atMin}/${n} samples`);

        const over = vals.filter(v => v > max + 1e-6).length;
        const under = vals.filter(v => v < min - 1e-6).length;
        if (over)  add('BUG', scen, runName, k, `exceeds gauge max ${max} (peak ${Math.max(...vals).toFixed(2)}) on ${over}/${n} samples -- bar clips`);
        if (under) add('BUG', scen, runName, k, `below gauge min ${min} (trough ${Math.min(...vals).toFixed(2)}) on ${under}/${n} samples -- bar clips`);

        if (Math.max(...vals) - Math.min(...vals) === 0 && !STATIC_OK.includes(k)) {
            add('INFO', scen, runName, k, `never changes (constant ${vals[0]})`);
        }
    });

    /* Clinical sanity on the last two minutes. */
    const tail = rows.filter(r => r.t >= rows[rows.length - 1].t - 120);
    const avg = k => {
        const v = tail.map(r => r[k]).filter(x => x !== null);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
    };
    const map = avg('map'), spo2 = avg('spo2'), hr = avg('hr'), etco2 = avg('etco2'), consc = avg('consc');

    if (map < 55)   add('CLIN', scen, runName, 'map', `MAP settles at ${map.toFixed(0)} mmHg (shock territory)`);
    if (map > 115)  add('CLIN', scen, runName, 'map', `MAP settles at ${map.toFixed(0)} mmHg (severe hypertension)`);
    if (spo2 < 90)  add('CLIN', scen, runName, 'spo2', `SpO2 settles at ${spo2.toFixed(0)}%`);
    if (etco2 > 55) add('CLIN', scen, runName, 'etco2', `etCO2 settles at ${etco2.toFixed(0)} mmHg`);
    if (hr > 130)   add('CLIN', scen, runName, 'hr', `HR settles at ${hr.toFixed(0)} bpm`);
    // Emergence and the induction walkthrough are meant to end awake.
    if (consc > 65 && !['induction', 'emergence', 'last'].includes(scen)) {
        add('CLIN', scen, runName, 'consc', `consciousness ${consc.toFixed(0)} at end -- awareness territory`);
    }
}

Object.keys(R).forEach(scen => {
    analyse(scen, 'untreated', R[scen].untreated);
    if (R[scen].treatmentPlan.length) analyse(scen, 'treated', R[scen].treated);
});

/* -----------------------------------------------------------------------------
   Treatment effect
   -------------------------------------------------------------------------- */
console.log('\n===== TREATMENT EFFECT (end of run, untreated -> treated) =====\n');
console.log('scenario             MAP            SpO2           HR             etCO2          consciousness');
console.log('-'.repeat(103));
Object.keys(R).forEach(scen => {
    if (!R[scen].treatmentPlan.length) return;
    const u = R[scen].untreated.rows[R[scen].untreated.rows.length - 1];
    const t = R[scen].treated.rows[R[scen].treated.rows.length - 1];
    const q = (v, d) => (v === null ? 'NaN' : v.toFixed(d));
    const cell = (k, d = 0) => `${q(u[k], d)} -> ${q(t[k], d)}`.padEnd(15);
    console.log(scen.padEnd(21) + cell('map') + cell('spo2') + cell('hr') + cell('etco2') + cell('consc'));
});

/* -----------------------------------------------------------------------------
   Findings
   -------------------------------------------------------------------------- */
const ORDER = { BUG: 0, CLIN: 1, WARN: 2, INFO: 3 };
findings.sort((a, b) => ORDER[a.sev] - ORDER[b.sev] || a.scen.localeCompare(b.scen) || a.key.localeCompare(b.key));

console.log('\n\n===== ANOMALY SCAN =====\n');
findings.forEach(f => console.log(`[${f.sev.padEnd(4)}] ${(f.scen + '/' + f.run).padEnd(32)} ${f.key.padEnd(11)} ${f.msg}`));

const tally = findings.reduce((a, f) => (a[f.sev] = (a[f.sev] || 0) + 1, a), {});
console.log(`\n${findings.length} findings  ` +
    Object.keys(ORDER).map(k => `${k}:${tally[k] || 0}`).join('  '));
