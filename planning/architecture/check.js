'use strict';

// Map staleness check: every code name the map quotes (`Module`, `Module.method`, `path/File.js`) must still exist in
// src/, scripts/ or tests/. Prints the map lines whose names are gone; exit 1 when any are.
// Usage: node planning/architecture/check.js
// Run before each release (map refresh) and after a change that removes or renames a module.
// Not checked: lines that record removed code (deleted/removed/gone/paid), and a quoted name followed by
// " (proposed)" (a fix's name that does not exist yet) or " (C4" (a name from the C4 reference code).

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const mapDir = __dirname;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(c?js|json|sql|ini)$/.test(entry.name)) out.push(full);
    }
    return out;
}

const files = ['src', 'scripts', 'tests', 'config', 'database', 'launcher/main']
    .map(dir => path.join(root, dir)).filter(fs.existsSync).flatMap(dir => walk(dir));
const basenames = new Map();
for (const file of files) {
    const base = path.basename(file).replace(/\.(c?js|json|sql|ini)$/, '');
    if (!basenames.has(base)) basenames.set(base, []);
    basenames.get(base).push(file);
}
let corpus = null;
const text = file => fs.readFileSync(file, 'utf8');
function inCorpus(word) {
    corpus ||= files.filter(file => /\.c?js$/.test(file)).map(text).join('\n');
    return new RegExp(`\\b${word.replace(/[$]/g, '\\$')}\\b`).test(corpus);
}
function moduleHas(module, member) {
    return (basenames.get(module) || []).some(file => new RegExp(`\\b${member.replace(/[$]/g, '\\$')}\\b`).test(text(file)));
}

// A quoted span is checked only when it reads as a code name; prose, values and config keys pass.
function check(span) {
    const name = span.replace(/\(.*$/, '').replace(/[,;:]+$/, '').trim();
    let match;
    if ((match = name.match(/^([\w./-]+)\.(c?js|json|sql|ini)$/))) {
        const rel = `${match[1]}.${match[2]}`;
        if (rel.includes('/')) {
            const hits = [rel, `src/${rel}`, `src/GameServer/${rel}`].some(candidate => fs.existsSync(path.join(root, candidate)))
                || files.some(file => file.endsWith(`/${rel}`));
            return hits ? null : 'file';
        }
        return basenames.has(path.basename(rel).replace(/\.(c?js|json|sql|ini)$/, '')) ? null : 'file';
    }
    if ((match = name.match(/^([A-Z][A-Za-z0-9]+)\.([A-Za-z_$][\w$]*)$/))) {
        if (!basenames.has(match[1])) return inCorpus(match[1]) ? null : 'module';
        return moduleHas(match[1], match[2]) ? null : 'member';
    }
    if ((match = name.match(/^[A-Z][a-z]+[A-Z][A-Za-z0-9]*$/))) {
        return basenames.has(name) || inCorpus(name) ? null : 'name';
    }
    return null;
}

const missing = [];
for (const file of fs.readdirSync(mapDir).filter(name => name.endsWith('.md')).sort()) {
    const lines = text(path.join(mapDir, file)).split('\n');
    lines.forEach((line, index) => {
        // Entries recorded as removed name the dead code on purpose.
        if (/\b(deleted|removed|gone|paid)\b/i.test(line)) return;
        for (const match of line.matchAll(/`([^`]{2,100})`/g)) {
            const span = match[1];
            if (/^ \((proposed|C4)\b/.test(line.slice(match.index + match[0].length))) continue;
            for (const part of span.split(/[\s/]*[,+|]\s*|\s+→\s+/)) {
                const kind = check(part);
                if (kind) missing.push(`${file}:${index + 1}  ${kind} gone: ${part}`);
            }
        }
    });
}
if (missing.length) {
    console.log(missing.join('\n'));
    console.log(`\n${missing.length} map reference(s) no longer found in the code.`);
    process.exitCode = 1;
} else {
    console.log('Every code name in the map is still in the code.');
}
