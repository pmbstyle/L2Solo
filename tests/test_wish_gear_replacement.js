'use strict';
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('wish-gear-replacement');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Equipment = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const Index = require('../src/GameServer/Item/ItemTemplateIndex');
const timestamp = 1791335800000;
const template = id => Index.find(Data.items, id);
const gear = (id, equipped = true, enchant = 0) => ({ selfId: id, amount: 1, slot: Number(template(id).etc.slot),
    equipped, equippedCount: equipped ? 1 : 0, equippedSlots: equipped ? [Number(template(id).etc.slot)] : [], enchant });
let owner = 950001;
function stateFor(inventory, classId = 57) {
    const state = { characterId: owner++, level: 69, stats: { classId }, inventory };
    state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(classId, 69), timestamp);
    return state;
}
function check(label, state, id, expectedEquip = true) {
    const snapshot = structuredClone(state), item = template(id);
    const before = Profile.powerFor(state, timestamp), build = Profile.buildGainsFor(state, timestamp);
    const nativePower = Profile.powerFor;
    let calls = 0, hypothetical;
    Profile.powerFor = (...args) => { calls++; return hypothetical = nativePower(...args); };
    let gain;
    try {
        gain = Providers.gearGain(state, item, timestamp, build, 1);
        const cold = calls;
        assert.deepEqual(Providers.gearGain(state, item, timestamp, build, 1), gain, label + ' cached exact value');
        assert.equal(calls, cold, label + ' warm hit must not build a bag/profile');
        assert(cold <= 1, label + ' at most one hypothetical profile');
    } finally { Profile.powerFor = nativePower; }
    assert.deepEqual(state, snapshot, label + ' valuation leaves all rows/instances unchanged');
    const inventory = Planner.equipInventoryUpgrades(state, { ...structuredClone(state.inventory), [id]: gear(id, false) });
    assert.equal(inventory[id].equipped, expectedEquip, label + ' native receipt accepts candidate');
    if (expectedEquip) {
        const after = Profile.powerFor({ ...state, inventory }, timestamp);
        for (const key of Object.keys(after)) assert(Math.abs(hypothetical[key] - after[key]) <= 1e-9, label + ' ' + key);
        const caster = require('../src/GameServer/Bot/Economy/BotImprovementPolicy').isCaster(state);
        const attack = caster ? 'mAtk' : 'pAtk';
        assert(Math.abs(gain.attack - Math.max(0, after[attack] / before[attack] - 1)) <= 1e-9, label + ' attack gain');
    } else assert.deepEqual(gain, { attack: 0, defence: 0 }, label + ' no benefit from rejected replacement');
    Profile.forgetBuild(state.characterId);
    return { inventory, gain, calls };
}
function verify() {
    assert.equal(Equipment.equipmentSlotKey(7), Equipment.equipmentSlotKey(14));
    assert(Equipment.equipmentReplacementConflict(14, 8));
    assert(!Equipment.equipmentReplacementConflict(7, 8));
    check('two to one', stateFor({ 93: gear(93) }), 2503);
    check('one to two, higher old key', stateFor({ 2503: gear(2503) }), 300);
    check('one to two, lower old key', stateFor({ 162: gear(162) }), 300);
    check('same slot', stateFor({ 93: gear(93) }), 299);
    const enchanted = stateFor({ 93: gear(93, true, 7) });
    enchanted.inventory[93].instances = [{ id: 4242, slot: 14, enchant: 7, equipped: true }];
    check('old per-instance enchant', enchanted, 2503);
    const explicit = stateFor({ 93: { ...gear(93), slot: 0, equippedSlots: [14] } });
    check('explicit equippedSlots', explicit, 2503);
    const shield = check('two-handed removes shield', stateFor({ 18: gear(18), 2503: gear(2503) }), 300);
    assert(!shield.inventory[18].equipped);
    const keptShield = check('one-handed retains shield', stateFor({ 18: gear(18), 159: gear(159) }), 2503);
    assert(keptShield.inventory[18].equipped);
    check('native SA effect', stateFor({ 93: gear(93) }), 4744);
    check('downgrade rejected', stateFor({ 300: gear(300) }), 2503, false);
    check('equal raw score SA rejected by actual equip', stateFor({ 2503: gear(2503) }), 4744, false);
    check('zero slot falls back to native weapon template',
        stateFor({ 2503: { ...gear(2503), slot: 0, equippedSlots: [7] } }), 4744, false);
    // Body/jewellery conflicts retain their old scope; weapon replacement is local.
    const untouched = stateFor({ 93: gear(93), 18: gear(18), 850: gear(850), 365: gear(365), 388: gear(388) });
    check('other slots survive weapon replacement', untouched, 2503);
    const changed = stateFor({ 93: gear(93) });
    const first = Providers.gearGain(changed, template(2503), timestamp, null, 1);
    changed.inventory[93].enchant = 7;
    const second = Providers.gearGain(changed, template(2503), timestamp, null, 1);
    assert(second.attack < first.attack, 'changed build cannot reuse old weapon gain');
    Profile.forgetBuild(changed.characterId);
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Clan = invoke('GameServer/Clan/ClanEconomyContext');
    const member = stateFor({ 93: gear(93) });
    const nativeBasics = Economy.basics, nativeGain = Providers.gearGain;
    let basicsCalls = 0, gainCalls = 0;
    Economy.basics = (state, inputs) => {
        assert.equal(state, member);
        assert.equal(inputs.timestamp, timestamp, 'clan fallback receives review timestamp');
        basicsCalls++;
        return { timestamp, persona: {}, hunt: { perHour: 1000, expPerHour: 1000 }, deathHours: 0 };
    };
    Providers.gearGain = (state, item, now) => {
        assert.equal(now, timestamp, 'clan uses the prepared combat timestamp');
        gainCalls++;
        return nativeGain(state, item, now);
    };
    try {
        const result = Clan.forClan({ id: owner++, level: 3, leaderId: member.characterId,
            members: [member], state: {} }, { timestamp, proofOffer: null, halls: [],
            equipment: [{ memberId: member.characterId, plan: { target: { selfId: 2503 }, market: { price: 1 } } }] });
        assert.equal(basicsCalls, 1, 'one prepared member fallback per clan review');
        assert.equal(gainCalls, 1);
        assert(result.network.queue.some(row => row.object.itemId === 2503), 'clan retains the useful weapon replacement');
    } finally {
        Economy.basics = nativeBasics; Providers.gearGain = nativeGain;
        Clan.reset(); Profile.forgetBuild(member.characterId);
    }
    assert.equal(invoke('Database').isReady(), false);
    require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
    console.log('PASS native weapon replacement, receipt parity, shield, instances, SA rejection, zero/warm cache and build change', isMainThread ? 'main' : 'worker');
}
(async () => {
    verify();
    if (isMainThread) {
        const worker = new Worker(__filename);
        await new Promise((resolve, reject) => {
            worker.once('error', reject);
            worker.once('exit', code => code === 0 ? resolve() : reject(Error('worker exit ' + code)));
        });
    } else parentPort.close();
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
