'use strict';

// The end-to-end scripts (tests/e2e/*.js, played on a real server by scripts/perf.js --scenario=script)
// run only by hand before a release, so nothing else notices when one rots. This check runs in CI:
// every script has the shape PlayerScript and HotCrowd expect, the code areas it declares still exist
// in src/, and the items, NPCs, skills and towns it names are still in data/. A rename or a data change
// breaks this test instead of a script that would fail, months later, as if the game were broken.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'tests', 'e2e');
const files = fs.readdirSync(DIR).filter(name => name.endsWith('.js') && fs.statSync(path.join(DIR, name)).isFile()).sort();
assert.ok(files.length > 0, 'tests/e2e has scripts');

const scripts = files.map(name => ({ file: `tests/e2e/${name}`, script: require(path.join(DIR, name)) }));
const needData = scripts.some(({ script }) => ['items', 'npcs', 'skills'].some(kind => script.needs?.[kind]?.length));
const DataCache = invoke('GameServer/DataCache');
if (needData) DataCache.init({ validate: false });
const found = (fetch, id) => {
    let hit = false;
    fetch(Number(id), () => { hit = true; });
    return hit;
};
const towns = new Set(Object.values(invoke('GameServer/World/TownRespawn').towns).map(town => town.name));
const names = new Set();

for (const { file, script } of scripts) {
    // HotCrowd logs players in by `players` (1..20) at `place()`; PlayerScript plays `run(ctx)`.
    assert.equal(script.name, path.basename(file, '.js'), `${file}: name is the file's name (the run folder is named by it)`);
    assert.ok(!names.has(script.name), `${file}: name is unique`);
    names.add(script.name);
    assert.ok(Number.isInteger(script.players) && script.players >= 1 && script.players <= 20, `${file}: players is 1..20`);
    assert.equal(typeof script.run, 'function', `${file}: run(ctx)`);
    assert.equal(typeof script.place, 'function', `${file}: place()`);
    // place() is read from data before the world has players: a place, or null for HotCrowd's crowd.
    const place = script.place();
    assert.ok(place === null || ['locX', 'locY', 'locZ'].every(key => Number.isFinite(Number(place[key]))),
        `${file}: place() is null or a location (${JSON.stringify(place)})`);

    // The code it plays: a changed path maps to the scripts to run.
    assert.ok(Array.isArray(script.areas) && script.areas.length > 0, `${file}: areas lists the src paths it plays`);
    for (const area of script.areas) {
        assert.ok(typeof area === 'string' && !path.isAbsolute(area) && !area.includes('..'), `${file}: area "${area}" is a path under src/`);
        assert.ok(fs.existsSync(path.join(ROOT, 'src', area)), `${file}: area src/${area} exists`);
    }

    // The data it names (a precondition on the server would fail late and look like the game's fault).
    const needs = script.needs || {};
    assert.ok(!Object.keys(needs).some(kind => !['items', 'npcs', 'skills', 'towns'].includes(kind)),
        `${file}: needs has only items, npcs, skills, towns`);
    for (const id of needs.items || []) assert.ok(found(DataCache.fetchItemFromSelfId, id), `${file}: item ${id} is in data/Items`);
    for (const id of needs.npcs || []) assert.ok(DataCache.npcRow(Number(id)), `${file}: NPC ${id} is in data/Npcs`);
    for (const id of needs.skills || []) assert.ok(found(DataCache.fetchSkillFromSelfId, id), `${file}: skill ${id} is in data/Skills`);
    for (const town of needs.towns || []) assert.ok(towns.has(town), `${file}: town "${town}" is a TownRespawn town`);
}

console.log(`e2e scripts: ${scripts.length} checked (${scripts.map(({ script }) => script.name).join(', ')})`);
