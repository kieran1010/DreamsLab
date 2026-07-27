/* =============================================================================
   TRACE  --  print the full parameter table for one scenario
   -----------------------------------------------------------------------------
   The debugging companion to scan.js: shows every Physiology gauge at chosen
   timepoints for the untreated and treated runs, plus the non-gauge context
   (rhythm, PIP, drug effect-site levels, active events) at each end.

       node tools/trace.js bronchospasm
       node tools/trace.js ischaemia 0,30,60,90,150,300,600
       node tools/trace.js                     # lists the scenario keys
   ============================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const RESULTS = path.join(__dirname, 'results.json');
if (!fs.existsSync(RESULTS)) {
    console.error('results.json not found -- run `node tools/sweep.js` first.');
    process.exit(1);
}
const R = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));

const KEYS = ['circVol', 'preload', 'contract', 'svr', 'hr', 'map', 'co',
              'respDrive', 'resistance', 'lungVol', 'autoPEEP', 'fio2', 'spo2', 'etco2', 'vt',
              'consc', 'noci', 'paralysis', 'alpha', 'beta', 'parasymp', 'bbBlock'];

const DEC = { circVol: 2, preload: 2, contract: 2, svr: 2, hr: 0, map: 0, co: 1,
              respDrive: 2, resistance: 0, lungVol: 0, autoPEEP: 1, fio2: 2, spo2: 0, etco2: 0, vt: 0,
              consc: 0, noci: 1, paralysis: 2, alpha: 2, beta: 2, parasymp: 2, bbBlock: 2 };

const scenario = process.argv[2];
if (!scenario) {
    console.log('usage: node tools/trace.js <scenario> [comma,separated,seconds]\n');
    console.log('scenarios:');
    Object.keys(R).forEach(k => console.log('  ' + k));
    process.exit(0);
}
if (!R[scenario]) {
    console.error(`Unknown scenario "${scenario}". Run without arguments to list them.`);
    process.exit(1);
}

const times = (process.argv[3] || '0,15,30,60,120,180,300,450,600').split(',').map(Number);

function nearest(rows, t) {
    return rows.reduce((best, r) => (Math.abs(r.t - t) < Math.abs(best.t - t) ? r : best), rows[0]);
}

function table(run) {
    const picked = times.map(t => nearest(run.rows, t));
    let out = 'parameter'.padEnd(12) + picked.map(r => (r.t + 's').padStart(8)).join('') + '\n';
    out += '-'.repeat(12 + picked.length * 8) + '\n';
    KEYS.forEach(k => {
        out += k.padEnd(12) + picked.map(r => {
            const v = r[k];
            return (v === null ? '--' : v.toFixed(DEC[k])).padStart(8);
        }).join('') + '\n';
    });
    return out;
}

function context(row, label) {
    const x = row._x;
    return `${label}  events[${x.events.join(',') || '-'}]  rhythm=${x.rhythm}  ` +
        `BP=${x.sys.toFixed(0)}/${x.dia.toFixed(0)}  BIS=${x.bis.toFixed(0)}  PIP=${x.peak.toFixed(0)}  ` +
        `MV=${x.minuteVent.toFixed(1)}  etSevo=${x.etSevo.toFixed(2)}  MAC=${x.mac.toFixed(2)}  RR=${x.effRR.toFixed(1)}\n` +
        `${' '.repeat(label.length)}  noci target=${x.nociTarget}  cover=${x.analgesiaCover.toFixed(2)}  ` +
        `effStim=${x.effectiveStimulus.toFixed(2)}  isch=${x.ischaemia.toFixed(2)}  peShunt=${x.peShunt.toFixed(2)}  ` +
        `aspInj=${x.aspInjury.toFixed(2)}  mhSev=${x.mhSev.toFixed(2)}  airway=${x.airway}  mode=${x.ventMode}`;
}

const r = R[scenario];
const first = run => run.rows[0];
const last = run => run.rows[run.rows.length - 1];

console.log('='.repeat(96));
console.log('SCENARIO: ' + scenario);
console.log('='.repeat(96));

console.log('\n--- UNTREATED (no user action) ---\n');
console.log(table(r.untreated));
console.log(context(first(r.untreated), 't=0  '));
console.log(context(last(r.untreated),  't=end'));
if (r.untreated.errors.length) console.log('\nRUNTIME ERRORS: ' + r.untreated.errors[0].split('\n')[0]);

if (r.treatmentPlan.length) {
    console.log('\n--- TREATED ---');
    console.log('plan: ' + r.treatmentPlan.map(a => `${a.t}s ${a.label}`).join('\n      ') + '\n');
    console.log(table(r.treated));
    console.log(context(last(r.treated), 't=end'));
    if (r.treated.errors.length) console.log('\nRUNTIME ERRORS: ' + r.treated.errors[0].split('\n')[0]);
} else {
    console.log('\n(no recommended treatment -- observation/control scenario)');
}
