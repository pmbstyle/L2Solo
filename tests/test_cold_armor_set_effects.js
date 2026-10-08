const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');

const Data = invoke('GameServer/DataCache');
Data.init();
const Sets = invoke('GameServer/Items/C4ArmorSets');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const TS = 1791477000000;
const item = selfId => Data.items.find(row => Number(row.selfId) === selfId);
const bagFor = ids => Object.fromEntries(ids.map(selfId => [selfId, {
    selfId, amount: 1, equipped: true, equippedCount: 1,
    slot: item(selfId).etc.slot, equippedSlots: [item(selfId).etc.slot]
}]));
const nativeEffects = bag => {
    const actor = { effects: {} };
    Sets.sync(actor, Object.values(bag).map(row => ({
        fetchSelfId: () => row.selfId, fetchEquipped: () => row.equipped && row.amount > 0
    })));
    return Object.values(actor.effects);
};
const stateFor = (inventory, effects = []) => ({
    characterId: 881001, level: 76, inventory,
    stats: { classId: 15, coldCombat: { version: Profile.PROFILE_VERSION, classId: 15, effects } }
});
const setEffects = state => Profile.profileFor(state, TS).effects.filter(e => e.category === Sets.CATEGORY);
const effectRows = effects => effects.map(e => [e.id, e.stats]).sort((a, b) => a[0] - b[0]);

// Real catalog parts: cold-only profiles must derive all native set stats,
// including base-stat changes, resistance descriptors and shield additions.
for (const set of Sets.ARMOR_SETS) {
    const ids = [set.chest, set.legs, set.head, set.gloves, set.feet].filter(Boolean);
    const bag = bagFor(ids);
    const expected = [[set.skillId, Sets.resolveSkill(set.skillId).stats]];
    assert.deepEqual(effectRows(setEffects(stateFor(bag))), expected, set.name);
    assert.deepEqual(effectRows(nativeEffects(bag)), expected, `native ${set.name}`);
    assert.deepEqual(Profile.powerFor(stateFor(bag), TS),
        Profile.powerFor(stateFor(bag, nativeEffects(bag)), TS), `no double bonus: ${set.name}`);
    for (const missing of ids) {
        const partial = { ...bag, [missing]: { ...bag[missing], equipped: false, equippedCount: 0, equippedSlots: [] } };
        assert.equal(setEffects(stateFor(partial, nativeEffects(bag))).length, 0,
            `captured ${set.name} expires after removing ${missing}`);
    }
    if (set.shield) {
        const shieldBag = bagFor([...ids, set.shield]);
        const withShield = [...expected, [set.shieldSkillId, Sets.resolveSkill(set.shieldSkillId).stats]]
            .sort((a, b) => a[0] - b[0]);
        assert.deepEqual(effectRows(setEffects(stateFor(shieldBag))), withShield, `${set.name} shield`);
        assert.deepEqual(effectRows(nativeEffects(shieldBag)), withShield, `native ${set.name} shield`);
        const partial = { ...shieldBag, [set.chest]: { ...shieldBag[set.chest], equipped: false } };
        assert.equal(setEffects(stateFor(partial, nativeEffects(shieldBag))).length, 0,
            `shield alone cannot preserve ${set.name}`);
    }
}

const dcBag = bagFor([2407, 512, 5767, 5779]);
const stale = nativeEffects(dcBag);
const complete = stateFor(dcBag, stale);
const before = Profile.profileFor(complete, TS);
const changedBag = { ...dcBag, 5767: { ...dcBag[5767], equipped: false, equippedCount: 0, equippedSlots: [] },
    ...bagFor([6384]) };
const changed = stateFor(changedBag, stale);
const after = Profile.profileFor(changed, TS);
assert.equal(before.castSpd, 468);
assert.equal(before.pDef, 573.9);
assert.equal(after.castSpd, 369, 'one Major Arcana glove must lose Dark Crystal casting bonus and WIT');
assert.equal(after.pDef, 547.9, 'one Major Arcana glove must lose Dark Crystal defence bonus');
assert.deepEqual(Profile.powerFor(changed, TS), Profile.powerFor(stateFor(changedBag, nativeEffects(changedBag)), TS));
assert.deepEqual(Profile.powerFor(stateFor(dcBag), TS), Profile.powerFor(complete, TS));

const devotionBag = bagFor([1101, 1104, 44]);
const devotion = stateFor(devotionBag, nativeEffects(devotionBag));
devotion.level = 19;
const helmetBag = { ...devotionBag, 44: { ...devotionBag[44], equipped: false, equippedCount: 0, equippedSlots: [] },
    ...bagFor([1148]) };
assert.equal(Profile.profileFor(devotion, TS).castSpd, 404);
assert.equal(Profile.profileFor({ ...devotion, inventory: helmetBag }, TS).castSpd, 352);

const packed = Profile.buildGainsFor(complete, TS);
assert.strictEqual(Profile.buildGainsFor(stateFor(dcBag), TS), packed,
    'captured derived effects do not split equivalent builds');
const swapped = Profile.buildGainsFor(changed, TS);
assert.notStrictEqual(swapped, packed, 'worn-part change invalidates the cached build');
assert.deepEqual(Profile.powerNumbers(swapped), Profile.powerFor(changed, TS));
assert.strictEqual(Profile.buildGainsFor(stateFor(changedBag), TS), swapped,
    'stale saved set descriptors do not split a broken build');
Profile.forgetBuild(complete.characterId);

assert.equal(setEffects(stateFor({}, stale)).length, 0, 'explicitly empty inventory clears captured set bonuses');
assert.deepEqual(effectRows(setEffects(stateFor(undefined, stale))), effectRows(stale),
    'legacy state without inventory retains its captured set');
const zeroBag = { ...dcBag, 5767: { ...dcBag[5767], amount: 0 } };
assert.equal(setEffects(stateFor(zeroBag, stale)).length, 0, 'zero-count part cannot complete a set');
const buff = { id: 999000, key: 'test-buff', category: 'buff', stats: { pAtkMul: 1.2 } };
const buffed = stateFor(changedBag, [...stale, buff]);
assert(Profile.profileFor(buffed, TS).effects.includes(buff), 'rebuilding sets preserves unrelated buffs');
assert.equal(setEffects(stateFor(dcBag, [...stale, ...stale])).length, 1, 'captured duplicates cannot double a bonus');

console.log('Cold armor set effects: all 45 sets, shield bonuses, swaps, legacy state and cache checks passed');
