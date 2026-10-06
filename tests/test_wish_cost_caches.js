'use strict';
// Caches on the wish-review path (L22): invoke() reuse, power numbers by
// build, and the drop-source index kept across spot-less callers. Each must
// give exactly what the uncached code gives.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-cost-caches-'));
delete process.env.L2NODE_CONFIG_SHARED_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ItemIndex = invoke('GameServer/Item/ItemTemplateIndex');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (error) { failures++; console.error(`not ok - ${name}\n${error.stack}`); }
}

const POWER = ['pAtk', 'mAtk', 'atkSpd', 'castSpd', 'pDef', 'mDef', 'maxHp'];
const subset = profile => Object.fromEntries(POWER.map(key => [key, profile[key]]));
const weapon = Data.items.find(item => String(item.template?.kind || '').startsWith('Weapon.') && item.etc?.rank === 'c'
    && Number(item.stats?.pAtk) > 0);
const armor = Data.items.find(item => String(item.template?.kind || '').startsWith('Armor.') && item.etc?.rank === 'c'
    && Number(item.etc?.slot) === 10);
assert.ok(weapon && armor, 'fixture items');
const row = (item, enchant = 0, equipped = true) => ({ selfId: Number(item.selfId), amount: 1, equipped,
    equippedCount: Number(equipped), slot: Number(item.etc.slot), enchant,
    instances: [{ id: 9000 + Number(item.selfId), selfId: Number(item.selfId), amount: 1, equipped, slot: Number(item.etc.slot), enchant }] });
const base = (patch = {}) => ({ characterId: 77, level: 52, adena: 1000, exp: 1,
    inventory: { [weapon.selfId]: row(weapon), [armor.selfId]: row(armor) },
    stats: { classId: 2, hennas: [], coldCombat: Profile.legacySnapshot({ stats: { classId: 2 }, level: 52 }, [], 0) }, ...patch });

check('invoke() returns the module require() returns, reloads after a cache delete, follows replaced exports', () => {
    const file = require.resolve('../src/GameServer/Formulas');
    const first = invoke('GameServer/Formulas');
    assert.equal(first, require(file));
    assert.equal(invoke('GameServer/Formulas'), first);
    const saved = require.cache[file];
    delete require.cache[file];
    const reloaded = invoke('GameServer/Formulas');
    assert.notEqual(reloaded, first);
    assert.equal(reloaded, require(file));
    require.cache[file].exports = { replaced: true };
    assert.equal(invoke('GameServer/Formulas').replaced, true);
    require.cache[file] = saved;
    assert.equal(invoke('GameServer/Formulas'), first);
});

check('power numbers by build equal the full profile, for the base build and each change', () => {
    const now = Date.now();
    const variants = [
        base(),
        base({ inventory: { ...base().inventory, [weapon.selfId]: row(weapon, 3) } }),
        base({ inventory: { [armor.selfId]: row(armor) } }),
        base({ inventory: { ...base().inventory, [weapon.selfId]: row(weapon, 0, false) } }),
        base({ level: 53 }),
        base({ stats: { ...base().stats, hennas: [1] } }),
        base({ stats: { ...base().stats, classId: 3, coldCombat: Profile.legacySnapshot({ stats: { classId: 3 }, level: 52 }, [], 0) } })
    ];
    const seen = new Set();
    for (const state of variants) {
        const power = Profile.powerFor(state, now);
        assert.deepEqual(power, subset(Profile.profileFor(state, now)));
        seen.add(JSON.stringify(power));
    }
    assert.ok(seen.size >= 5, `changes must change the power (${seen.size} distinct)`);
});

check('an ordinary fight (adena, exp) reuses the remembered numbers', () => {
    const now = Date.now();
    const before = Profile.powerFor(base(), now);
    assert.equal(Profile.powerFor(base({ adena: 999999, exp: 5000 }), now), before);
});

check('a timed effect counts while active and not after it expires', () => {
    const now = Date.now();
    const effect = { id: 1068, key: 'might', category: 'buff', expiresAt: now + 60000, stats: { pAtkMul: 1.15 } };
    const state = base();
    state.stats.coldCombat = { ...state.stats.coldCombat, effects: [effect] };
    const active = Profile.powerFor(state, now), expired = Profile.powerFor(state, now + 120000);
    assert.deepEqual(active, subset(Profile.profileFor(state, now)));
    assert.deepEqual(expired, subset(Profile.profileFor(state, now + 120000)));
    assert.ok(active.pAtk > expired.pAtk);
});

check('a caller without spots gets no sources and keeps the index built for the real spot list', () => {
    const reward = (Data.npcRewards || []).find(npc => (npc.rewards || []).some(group => (group.items || []).length));
    const npc = ItemIndex.find(Data.npcs, reward.selfId);
    const spots = [{ id: 'fixture', npcEntries: [{ selfId: Number(reward.selfId), name: npc?.template?.name, count: 3 }] }];
    const index = Planner.sourceIndexFor(spots);
    assert.ok(index.size > 0);
    assert.equal(Planner.sourceIndexFor([]).size, 0);
    assert.equal(Planner.sourceIndexFor(undefined).size, 0);
    assert.equal(Planner.sourceIndexFor(spots), index);
});

check('per-actor wish results are bounded, least recently used out, a reused actor kept', () => {
    const { WishNetwork, remember, ACTOR_LIMIT } = invoke('GameServer/Bot/Economy/WishNetwork');
    const map = new Map();
    for (let i = 0; i < ACTOR_LIMIT; i++) remember(map, `character:${i}`, i);
    remember(map, 'character:0', 0);
    remember(map, 'group:after', 1);
    assert.equal(map.size, ACTOR_LIMIT);
    assert.ok(map.has('character:0'), 'a reused actor stays');
    assert.ok(!map.has('character:1'), 'the oldest unused actor leaves');
    const engine = new WishNetwork();
    for (let i = 0; i < ACTOR_LIMIT + 40; i++) engine.build({ actorKey: `character:${i}`, inputKey: 'k', nodes: [], roots: [] });
    assert.equal(engine.cache.size, ACTOR_LIMIT);
});

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log('all passed');
process.exit(0);
