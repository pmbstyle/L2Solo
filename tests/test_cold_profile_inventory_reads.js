'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Index = invoke('GameServer/Item/ItemTemplateIndex');
const filename = require.resolve('../src/GameServer/Bot/Population/ColdCombatProfile');
const source = fs.readFileSync(filename, 'utf8');
const old = source.replace('            if (!item?.equipped) return [];\n', '');
assert.notEqual(old, source, 'native reference must bypass early slot exclusion');
const reference = new Module(filename, module);
reference.filename = filename; reference.paths = Module._nodeModulePaths(path.dirname(filename));
reference._compile(old, filename);
const fixture = require('./fixtures/wish_spot_native_state.json');
const timestamp = 1791335800000;
const originalFind = Index.find;
function read(profile, state) {
    const before = structuredClone(state);
    const unused = new Set(Object.values(state.inventory || {}).filter(row => !row?.equipped).map(row => row?.selfId));
    let unusedReads = 0;
    Index.find = (items, id) => { if (items === Data.items && unused.has(id)) unusedReads++; return originalFind(items, id); };
    try {
        const result = profile.profileFor(state, timestamp);
        assert.deepEqual(state, before, 'profile preparation preserves real inventory and learned facts');
        return { result, unusedReads };
    } finally { Index.find = originalFind; }
}
let removed = 0;
const missing = structuredClone(fixture); delete missing.inventory;
const variants = [fixture, missing, { ...fixture, inventory: {} },
    { ...fixture, inventory: { ...fixture.inventory, 123456789: { selfId: 123456789, equipped: true, amount: 1, slot: 7 } } },
    { ...fixture, inventory: Object.fromEntries(Object.entries(fixture.inventory).map(([key, row]) => [key,
        { ...row, equipped: false, equippedCount: 2, equippedSlots: [1, 2] }])) },
    { ...fixture, inventory: Object.fromEntries(Object.entries(fixture.inventory).map(([key, row]) => [key,
        { ...row, amount: 0 }])) },
    ...[2, 12].map(classId => ({ ...fixture, stats: { ...fixture.stats, classId,
        coldCombat: Profile.legacySnapshot({ level: fixture.level, stats: { classId } }, [], timestamp) } })),
    { ...fixture, inventory: Object.fromEntries(Object.entries(fixture.inventory).map(([key, row]) => [key,
        { ...row, equippedSlots: row.equipped ? [1, 2, 1] : [], instances: row.equipped
            ? [{ id: 7001, equipped: true, slot: 1, enchant: 3 }, { id: 7002, equipped: true, slot: 2, enchant: 5 }]
            : row.instances }])) }
];
for (const state of variants) {
    const a = read(reference.exports, structuredClone(state)), b = read(Profile, structuredClone(state));
    assert.deepEqual(b.result, a.result, 'full native profile, effects/passives/skills/enchant and legacy fallback stay exact');
    assert(b.unusedReads <= a.unusedReads);
    removed += a.unusedReads - b.unusedReads;
}
assert(removed > 20, 'native unused inventory rows must stop triggering template reads');
console.log(`cold profile inventory preparation PASS: ${variants.length} native variants, removed unused-template reads=${removed}`);
