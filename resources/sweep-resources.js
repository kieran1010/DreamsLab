/* =============================================================================
   RESOURCES SWEEPER  --  add new resources/ files to the Resources tab
   -----------------------------------------------------------------------------
   Scans resources/ for files that aren't yet listed in resources/manifest.json
   (the data the Resources tab fetches at runtime - see [RESOURCES] in
   index.html), and for each new one found, prompts for a Name and a Topic,
   then appends an entry:

       { title: <name>, type: <guessed from extension>, url: 'resources/<file>',
         description: <topic> }

   Existing entries are never touched or reordered - only appended to. Run it
   after dropping a file into resources/, before committing:

       node resources/sweep-resources.js

   This is local tooling, like tools/*.js - it does not run automatically, and
   the sim has no build-time dependency on it (the Resources tab reads
   manifest.json directly at runtime; this script is just the convenient way
   to edit that file). Requires Node 18+. No dependencies.
   ============================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RESOURCES_DIR = __dirname;
const MANIFEST_PATH = path.join(__dirname, 'manifest.json');

/* Files in resources/ that aren't resources themselves. */
const IGNORE = new Set(['README.md', 'sweep-resources.js', 'manifest.json']);

const EXT_TYPE = {
    '.pdf': 'pdf',
    '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.m4v': 'video',
};
function guessType(file) {
    return EXT_TYPE[path.extname(file).toLowerCase()] || 'link';
}

function readManifest() {
    if (!fs.existsSync(MANIFEST_PATH)) return [];
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8').trim();
    return raw ? JSON.parse(raw) : [];
}

function writeManifest(list) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(list, null, 2) + '\n');
}

const RESOURCES_PREFIX = 'resources/';
function knownResourceFiles(manifest) {
    return new Set(
        manifest
            .filter(r => typeof r.url === 'string' && r.url.startsWith(RESOURCES_PREFIX))
            .map(r => r.url.slice(RESOURCES_PREFIX.length))
    );
}

/* Not rl.question() in a loop: with piped/non-TTY stdin, Node's readline can
   silently drop the second and later question() calls (the interface's
   'close' event can race ahead of the next question's listener setup once
   all input is already buffered). Queuing our own 'line' events sidesteps
   that entirely and works the same whether input is typed or piped. */
function createPrompter(rl) {
    const queue = [];
    const waiting = [];
    rl.on('line', line => {
        if (waiting.length) waiting.shift()(line);
        else queue.push(line);
    });
    return function ask(question) {
        rl.output.write(question);
        return new Promise(resolve => {
            if (queue.length) resolve(queue.shift());
            else waiting.push(resolve);
        });
    };
}

/* Read-only: the files in resources/ that aren't in manifest.json yet.
   Shared by main() below and by .githooks/pre-commit, which needs to know
   whether there's actually anything to prompt for before deciding whether a
   missing terminal is even a problem. */
function findNewFiles() {
    if (!fs.existsSync(RESOURCES_DIR)) return [];
    const files = fs.readdirSync(RESOURCES_DIR)
        .filter(f => !IGNORE.has(f) && !f.startsWith('.'))
        .filter(f => fs.statSync(path.join(RESOURCES_DIR, f)).isFile())
        .sort();
    const known = knownResourceFiles(readManifest());
    return files.filter(f => !known.has(f));
}

async function main() {
    if (!fs.existsSync(RESOURCES_DIR)) {
        console.error('resources/ does not exist.');
        process.exitCode = 1;
        return;
    }

    const newFiles = findNewFiles();
    if (!newFiles.length) {
        console.log('No new files in resources/ - manifest.json is already up to date.');
        return;
    }

    console.log(`Found ${newFiles.length} new file(s) in resources/ not yet in the Resources tab:`);
    newFiles.forEach(f => console.log(`  ${f}  (type: ${guessType(f)})`));
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    const ask = createPrompter(rl);
    const newEntries = [];
    for (const file of newFiles) {
        console.log(`--- ${file} ---`);
        const title = (await ask('Name: ')).trim();
        if (!title) {
            console.log('(no name given - skipped)\n');
            continue;
        }
        const description = (await ask('Topic: ')).trim();
        console.log('');
        const entry = { title, type: guessType(file), url: `resources/${file}` };
        if (description) entry.description = description;
        newEntries.push(entry);
    }
    rl.close();

    if (!newEntries.length) {
        console.log('Nothing added.');
        return;
    }

    const manifest = readManifest();
    writeManifest(manifest.concat(newEntries));
    console.log(`Added ${newEntries.length} entr${newEntries.length === 1 ? 'y' : 'ies'} to resources/manifest.json.`);
    console.log('Review the diff, then commit manifest.json together with the new file(s) in resources/.');
}

module.exports = { findNewFiles };

if (require.main === module) {
    main().catch(err => {
        console.error(err.message);
        process.exitCode = 1;
    });
}
