/* =============================================================================
   HEADLESS HARNESS  --  run the Dreams Lab simulator without a browser
   -----------------------------------------------------------------------------
   index.html holds the entire simulator in one inline <script>. This module
   extracts that script, runs it in a Node vm sandbox against a stubbed DOM /
   canvas / audio context, and replaces the timers with a virtual clock so the
   100 ms physiology tick can be driven deterministically and much faster than
   real time.

   Nothing in index.html is modified. The real CONFIG, PROFILES, PK, SCENARIOS
   and physiology tick execute exactly as they do in the browser, so anything
   measured here is what a user would see.

   Usage:
       const { boot } = require('./harness');
       const sim = boot();
       sim.dl.loadScenario('bronchospasm');
       sim.advance(60000);                  // 60 simulated seconds
       console.log(sim.dl.state.spo2);

   Requires Node 18+. No dependencies.
   ============================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* index.html lives one level up from tools/. DL_HTML overrides for testing a
   copy or an older revision. */
const HTML_PATH = process.env.DL_HTML || path.join(__dirname, '..', 'index.html');

function extractScript(file) {
    const src = fs.readFileSync(file, 'utf8');
    const start = src.indexOf('<script>');
    const end = src.lastIndexOf('</script>');
    if (start < 0 || end < 0) throw new Error('No <script> block found in ' + file);
    return src.slice(start + '<script>'.length, end);
}

/* -----------------------------------------------------------------------------
   DOM stubs
   -------------------------------------------------------------------------- */

/* classList backed by a real Set, so .active / .cuff-inflating state persists
   across calls the way the app expects (the physiology tick reads
   box-nibp.classList.contains('cuff-inflating') to gate auto-NIBP). */
function makeClassList() {
    const set = new Set();
    return {
        add:      (...c) => c.forEach(x => set.add(x)),
        remove:   (...c) => c.forEach(x => set.delete(x)),
        contains: c => set.has(c),
        toggle:   (c, force) => {
            const want = force === undefined ? !set.has(c) : !!force;
            if (want) set.add(c); else set.delete(c);
            return want;
        },
    };
}

const CTX2D_METHODS = [
    'fillRect', 'clearRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo',
    'stroke', 'fill', 'arc', 'closePath', 'save', 'restore', 'scale', 'translate',
    'rotate', 'setTransform', 'fillText', 'strokeText', 'quadraticCurveTo',
    'bezierCurveTo', 'setLineDash', 'drawImage', 'rect', 'clip', 'ellipse',
];

function makeCtx2d() {
    const c = {};
    CTX2D_METHODS.forEach(m => { c[m] = () => {}; });
    c.measureText = () => ({ width: 0 });
    c.createLinearGradient = () => ({ addColorStop() {} });
    return c;
}

function makeEl(id) {
    const el = {
        id: id || '',
        tagName: 'DIV',
        // style must swallow arbitrary property writes and return '' when read
        style: new Proxy({}, {
            get: (t, k) => (t[k] === undefined ? '' : t[k]),
            set: (t, k, v) => { t[k] = v; return true; },
        }),
        dataset: {},
        children: [],
        value: 0,
        innerText: '', textContent: '', innerHTML: '',
        checked: false, disabled: false,
        offsetWidth: 800, offsetHeight: 400,
        clientWidth: 800, clientHeight: 400,
        width: 800, height: 400,
        parentNode: null,
        // resize() reads canvas.parentElement.clientWidth at load and throws
        // without it, so every element gets a usable parent.
        parentElement: {
            clientWidth: 800, clientHeight: 400,
            appendChild() {},
            classList: makeClassList(),
        },
        appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
        removeChild(c) {
            const i = this.children.indexOf(c);
            if (i >= 0) this.children.splice(i, 1);
            return c;
        },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
        insertBefore(c) { this.children.unshift(c); return c; },
        setAttribute(k, v) { this[k] = v; },
        getAttribute(k) { return this[k]; },
        removeAttribute(k) { delete this[k]; },
        addEventListener() {}, removeEventListener() {},
        querySelector() { return makeEl(''); },
        querySelectorAll() { return []; },
        getContext() { return makeCtx2d(); },
        getBoundingClientRect() {
            return { width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400 };
        },
        focus() {}, blur() {}, click() {}, scrollIntoView() {},
        closest() { return null; },
        contains() { return false; },
    };
    el.classList = makeClassList();
    return el;
}

/* -----------------------------------------------------------------------------
   Seeded PRNG
   -----------------------------------------------------------------------------
   The physiology tick calls Math.random() in several places -- the airway
   reactivity roll, awareness event selection, the anaphylaxis bronchospasm
   probability and NIBP measurement error. Left alone that makes every run
   different, so a change in scan.js output could be a real regression or just
   noise. The sandbox therefore gets its own seeded Math.random, fixed by
   default. Pass a different seed to explore the spread of outcomes.
   -------------------------------------------------------------------------- */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const DEFAULT_SEED = 20260728;

/* -----------------------------------------------------------------------------
   boot() -- build a sandbox, run the simulator in it, return a driver
   -----------------------------------------------------------------------------
   opts.seed  PRNG seed (default DEFAULT_SEED; pass null for true randomness)
   opts.html  path to a different index.html
   -------------------------------------------------------------------------- */
function boot(opts = {}) {
    const htmlPath = opts.html || HTML_PATH;
    const code = extractScript(htmlPath);

    const seed = opts.seed === undefined ? DEFAULT_SEED : opts.seed;
    /* Shallow-copy Math so the app sees a normal Math object with every method,
       but a reproducible random(). */
    const sandboxMath = Object.getOwnPropertyNames(Math)
        .reduce((m, k) => (m[k] = Math[k], m), {});
    if (seed !== null) sandboxMath.random = mulberry32(seed);

    /* Elements are memoised by id so classList / value state survives between
       lookups, exactly as real DOM nodes do. */
    const els = new Map();
    const doc = {
        getElementById(id) {
            if (!els.has(id)) els.set(id, makeEl(id));
            return els.get(id);
        },
        createElement(tag) {
            const e = makeEl('');
            e.tagName = String(tag).toUpperCase();
            return e;
        },
        createTextNode(t) { return { textContent: t }; },
        querySelector() { return makeEl(''); },
        querySelectorAll() { return []; },
        addEventListener() {}, removeEventListener() {},
        fullscreenElement: null, webkitFullscreenElement: null,
        exitFullscreen() {}, webkitExitFullscreen() {},
    };
    doc.documentElement = makeEl('html');
    doc.head = makeEl('head');
    doc.body = makeEl('body');

    /* --- virtual clock + scheduler --------------------------------------- */
    const clock = { now: 0 };          // virtual milliseconds
    let seq = 1;
    const intervals = new Map();       // id -> { fn, delay, next }
    const timeouts = new Map();        // id -> { fn, at }

    const sandbox = {
        console,
        Math: sandboxMath,
        JSON, Date, Object, Array, String, Number, Boolean, Error, Set, Map,
        isNaN, parseFloat, parseInt, Infinity, NaN, undefined,
        document: doc,
        performance: { now: () => clock.now },
        // never start the render loop; animate() draws waveforms we do not need
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: () => {},
        setInterval(fn, delay) {
            const id = seq++;
            intervals.set(id, { fn, delay: delay || 0, next: clock.now + (delay || 0) });
            return id;
        },
        clearInterval(id) { intervals.delete(id); },
        setTimeout(fn, delay) {
            const id = seq++;
            timeouts.set(id, { fn, at: clock.now + (delay || 0) });
            return id;
        },
        clearTimeout(id) { timeouts.delete(id); },
        Event: class Event { constructor(type) { this.type = type; } },
        alert() {}, confirm() { return true; }, prompt() { return null; },
    };

    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.devicePixelRatio = 1;
    sandbox.innerWidth = 1920;
    sandbox.innerHeight = 1080;
    sandbox.dispatchEvent = () => true;
    sandbox.addEventListener = () => {};
    sandbox.removeEventListener = () => {};
    sandbox.navigator = { userAgent: 'node', platform: 'node' };
    sandbox.localStorage = {
        _d: {},
        getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
        setItem(k, v) { this._d[k] = String(v); },
        removeItem(k) { delete this._d[k]; },
        clear() { this._d = {}; },
    };

    /* Web Audio stub -- alarms and the SpO2 beeper build node graphs at load. */
    function audioNode() {
        const ramp = {
            value: 0,
            setValueAtTime() {}, linearRampToValueAtTime() {},
            exponentialRampToValueAtTime() {}, cancelScheduledValues() {},
        };
        return {
            connect() { return audioNode(); }, disconnect() {},
            start() {}, stop() {},
            frequency: ramp, gain: ramp, type: 'sine',
        };
    }
    sandbox.AudioContext = function AudioContext() {
        return {
            state: 'running', currentTime: 0, destination: audioNode(),
            resume() { return Promise.resolve(); },
            suspend() { return Promise.resolve(); },
            createOscillator: audioNode,
            createGain: audioNode,
            createBiquadFilter: audioNode,
            createBufferSource: audioNode,
            createBuffer: () => ({ getChannelData: () => new Float32Array(16) }),
        };
    };
    sandbox.webkitAudioContext = sandbox.AudioContext;

    /* Top-level const/let bindings are NOT properties of the vm global, so the
       things a test needs have to be published explicitly. Add to this list if
       you need to reach something else in index.html. */
    const EPILOGUE = `
;globalThis.__dl = {
    SCENARIOS, PHYS_GROUPS, physResolve, state, CONFIG, PROFILES, PK, drugDb,
    loadScenario, scenarioReset, giveBolus, setInf, setVentParam, setVentMode,
    setAirway, setNoci, toggleEvent, setBleed, setRhythm, calcMAP,
    physCardiacOutput, suctionAirway, setProfile, resolveAllEvents, setTimeScale,
    saturate, clamp, hasPulse
};
`;

    const context = vm.createContext(sandbox);
    vm.runInContext(code + EPILOGUE, context, { filename: 'dreamslab-inline.js' });

    const api = {
        /** raw vm context */
        context,
        /** the simulator's published bindings (state, SCENARIOS, loadScenario, ...) */
        dl: context.__dl,
        /** live state object, for convenience */
        get state() { return context.__dl.state; },
        /** virtual clock, in ms */
        clock,
        /** PRNG seed this sandbox was built with (null = unseeded) */
        seed,
        /** errors thrown inside timer callbacks, collected rather than fatal */
        errors: [],

        /**
         * Advance virtual time by `ms`, firing due timeouts and intervals.
         * Steps in 100 ms slices so the physiology tick sees the cadence it
         * was written for.
         */
        advance(ms) {
            const target = clock.now + ms;
            while (clock.now < target) {
                clock.now += Math.min(100, target - clock.now);

                for (const [id, t] of [...timeouts]) {
                    if (t.at > clock.now) continue;
                    timeouts.delete(id);
                    try { t.fn(); } catch (e) { api.errors.push(String((e && e.stack) || e)); }
                }
                for (const [, iv] of [...intervals]) {
                    while (iv.next <= clock.now) {
                        iv.next += (iv.delay || 100);
                        try { iv.fn(); } catch (e) { api.errors.push(String((e && e.stack) || e)); }
                        if (!iv.delay) break;
                    }
                }
            }
        },
    };
    return api;
}

/* -----------------------------------------------------------------------------
   Shared helpers used by the tools in this directory
   -------------------------------------------------------------------------- */

/** Flat list of every gauge on the Physiology tab, read from PHYS_GROUPS. */
function gaugeSpecs(dl) {
    const out = [];
    Object.keys(dl.PHYS_GROUPS).forEach(group => {
        dl.PHYS_GROUPS[group].forEach(item => {
            if (item.section) return;   // section headings carry no value
            out.push({ group, key: item.key, label: item.label, unit: item.unit, spec: item });
        });
    });
    return out;
}

/** Read every gauge through its own getter -- exactly what the UI displays. */
function sampleGauges(specs) {
    const row = {};
    specs.forEach(g => {
        let v;
        try { v = g.spec.get(); } catch (e) { v = NaN; }
        row[g.key] = (typeof v === 'number' && isFinite(v)) ? v : null;
    });
    return row;
}

/** Resolve a gauge min/max/base, which may be a number or a function. */
const resolve = x => (typeof x === 'function' ? x() : x);

/** Look up a drugDb entry by type and dose value, for giveBolus(). */
function findDose(dl, type, d) {
    for (const tab of Object.keys(dl.drugDb)) {
        for (const drug of dl.drugDb[tab]) {
            if (drug.type !== type) continue;
            const hit = drug.doses.find(x => Math.abs(x.d - d) < 1e-9);
            if (hit) return { drug, dose: hit };
        }
    }
    throw new Error(`No drugDb entry for type "${type}" at dose ${d}`);
}

/** Give a bolus the same way a dose button click would. */
function give(dl, type, d) {
    const { drug, dose } = findDose(dl, type, d);
    dl.giveBolus(drug, dose, null);
}

module.exports = {
    boot, gaugeSpecs, sampleGauges, resolve, findDose, give,
    HTML_PATH, DEFAULT_SEED, mulberry32,
};
