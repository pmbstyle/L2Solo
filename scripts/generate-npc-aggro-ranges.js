'use strict';
// The aggro range of every aggressive NPC (T114): L2J Lisvus datapack
// sql/npc.sql, column `aggro` (0: passive), at the revision the legacy
// monsters were generated from. data/Npcs/aggro-ranges.json, read by
// NpcAggroRange. Usage: node scripts/generate-npc-aggro-ranges.js [lisvus repo]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const repo = path.resolve(process.argv[2] || path.join(root, 'tmp', 'vendor', 'l2j-lisvus'));
const expectedRevision = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975';
const revision = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (revision !== expectedRevision) throw new Error(`Expected Lisvus ${expectedRevision}, found ${revision}`);

// One SQL tuple: quoted strings with backslash escapes, bare numbers, NULL.
function fields(tuple) {
    const out = [];
    let at = 0;
    while (at < tuple.length) {
        while (tuple[at] === ' ' || tuple[at] === ',') at++;
        if (tuple[at] === "'") {
            let value = '';
            for (at++; at < tuple.length && tuple[at] !== "'"; at++) value += tuple[at] === '\\' ? tuple[++at] : tuple[at];
            out.push(value);
            at++;
        } else {
            const end = tuple.indexOf(',', at);
            out.push(tuple.slice(at, end < 0 ? tuple.length : end).trim());
            at = end < 0 ? tuple.length : end;
        }
    }
    return out;
}

const AGGRO = 30;
const ranges = {};
for (const line of fs.readFileSync(path.join(repo, 'datapack', 'sql', 'npc.sql'), 'utf8').split('\n')) {
    if (!line.startsWith('(')) continue;
    const row = fields(line.trim().replace(/[,;]$/, '').slice(1, -1));
    const range = Number(row[AGGRO]) || 0;
    if (range > 0) ranges[row[0]] = range;
}
const out = path.join(root, 'data', 'Npcs', 'aggro-ranges.json');
fs.writeFileSync(out, `${JSON.stringify({ source: `l2j-lisvus ${revision} datapack/sql/npc.sql aggro`, ranges })}\n`);
console.log(`wrote ${path.relative(root, out)}: ${Object.keys(ranges).length} aggressive NPCs`);
