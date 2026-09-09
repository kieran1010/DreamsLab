/* =============================================================================
   RESOURCES SWEEPER  --  add new resources/ files to the Resources tab
   -----------------------------------------------------------------------------
   Scans resources/ for files that aren't yet listed in the RESOURCES array in
   ../index.html (see [RESOURCES] there), and for each new one found, prompts
   for a Name and a Topic, then appends an entry:

       { title: <name>, type: <guessed from extension>, url: 'resources/<file>',
         description: <topic> }

   Existing entries are never touched or reordered - only appended to. Run it
   after dropping a file into resources/, before committing:

       node resources/sweep-resources.js

   This is local tooling, like tools/*.js - it does not run automatically, and
   the sim has no runtime dependency on it or on being able to list a
   directory (a static host can't do that anyway). Requires Node 18+. No
   dependencies.
   ============================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RESOURCES_DIR = __dirname;
const INDEX_HTML = path.join(__dirname, '..', 'index.html');

/* Files in resources/ that aren't resources themselves. */
const IGNORE = new Set(['README.md', 'sweep-resources.js']);

const EXT_TYPE = {
    '.pdf': 'pdf',
    '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.m4v': 'video',
};
function guessType(file) {
    return EXT_TYPE[path.extname(file).toLowerCase()] || 'link';
}

function escapeJsString(s) {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const ARRAY_START = 'const RESOURCES = [';
function locateArray(html) {
    const start = html.indexOf(ARRAY_START);
    if (start === -1) {
        throw new Error('Could not find "' + ARRAY_START + '" in index.html - ' +
            'has the RESOURCES array moved or been renamed? (grep for [RESOURCES])');
    }
    const openBracket = start + ARRAY_START.length - 1;
    let depth = 0;
    for (let i = openBracket; i < html.length; i++) {
        if (html[i] === '[') depth++;
        else if (html[i] === ']') {
            depth--;
            if (depth === 0) return { openBracket, closeBracket: i };
        }
    }
    throw new Error('Could not find the closing "]" for the RESOURCES array in index.html.');
}

/* Existing resources/-relative urls already listed, so we don't add the same
   file twice on a re-run. */
function knownResourceFiles(html, loc) {
    const body = html.slice(loc.openBracket, loc.closeBracket);
    const known = new Set();
    const re = /url:\s*'resources\/([^']+)'/g;
    let m;
    while ((m = re.exec(body))) known.add(m[1]);
    return known;
}

function formatEntry(title, type, url, description) {
    const lines = [
        '    {',
        `        title: '${escapeJsString(title)}',`,
        `        type: '${type}',`,
        `        url: '${escapeJsString(url)}',`,
    ];
    if (description) {
        lines.push(`        description: '${escapeJsString(description)}'`);
    } else {
        lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
    }
    lines.push('    }');
    return lines.join('\n');
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

async function main() {
    if (!fs.existsSync(RESOURCES_DIR)) {
        console.error('resources/ does not exist.');
        process.exitCode = 1;
        return;
    }

    const files = fs.readdirSync(RESOURCES_DIR)
        .filter(f => !IGNORE.has(f) && !f.startsWith('.'))
        .filter(f => fs.statSync(path.join(RESOURCES_DIR, f)).isFile())
        .sort();

    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const loc = locateArray(html);
    const known = knownResourceFiles(html, loc);

    const newFiles = files.filter(f => !known.has(f));
    if (!newFiles.length) {
        console.log('No new files in resources/ - the RESOURCES array is already up to date.');
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
        newEntries.push(formatEntry(title, guessType(file), `resources/${file}`, description));
    }
    rl.close();

    if (!newEntries.length) {
        console.log('Nothing added.');
        return;
    }

    const before = html.slice(0, loc.closeBracket).replace(/\s*$/, '');
    const after = html.slice(loc.closeBracket);
    const needsComma = /\}$/.test(before);
    const insertion = (needsComma ? ',\n' : '\n') + newEntries.join(',\n') + '\n';
    const updated = before + insertion + after;

    fs.writeFileSync(INDEX_HTML, updated);
    console.log(`Added ${newEntries.length} entr${newEntries.length === 1 ? 'y' : 'ies'} to the RESOURCES array in index.html.`);
    console.log('Review the diff, then commit index.html together with the new file(s) in resources/.');
}

main().catch(err => {
    console.error(err.message);
    process.exitCode = 1;
});
