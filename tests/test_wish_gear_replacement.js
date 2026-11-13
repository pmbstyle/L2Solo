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
    const before = Profile.profileFor(state, timestamp);
    const gain = Providers.gearGain(state, item, timestamp, 1);
    assert.deepEqual(state, snapshot, label + ' valuation leaves all rows/instances unchanged');
    const inventory = Planner.equipInventoryUpgrades(state, { ...structuredClone(state.inventory), [id]: gear(id, false) });
    assert.equal(inventory[id].equipped, expectedEquip, label + ' native receipt accepts candidate');
    if (expectedEquip) {
        const after = Profile.profileFor({ ...state, inventory }, timestamp, { store: false });
        const caster = require('../src/GameServer/Bot/Economy/BotImprovementPolicy').isCaster(state);
        const attack = caster ? 'mAtk' : 'pAtk';
        assert(Math.abs(gain.attack - Math.max(0, after[attack] / before[attack] - 1)) <= 1e-9, label + ' attack gain');
        assert(Math.abs(gain.defence - Math.max(0, 1 - before.pDef / after.pDef)) <= 1e-9, label + ' defence gain');
    } else assert.deepEqual(gain, { attack: 0, defence: 0 }, label + ' no benefit from rejected replacement');
    Profile.forgetBuild(state.characterId);
    return { inventory, gain };
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
    const first = Providers.gearGain(changed, template(2503), timestamp, 1);
    // An enchant writes a new bag (a worn row is never edited in place).
    changed.inventory = { ...changed.inventory, 93: { ...changed.inventory[93], enchant: 7 } };
    const second = Providers.gearGain(changed, template(2503), timestamp, 1);
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
        // A member with a decision and a published danger price: the clan
        // reads its death hours from the packet, the same worth as the basics
        // that carry those hours, and builds no basics.
        const Decisions = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions;
        const clanNumbers = Decisions.clanNumbers;
        // Body armour (356): its defence gain is weighed by the death hours.
        const worth = (state) => {
            Clan.reset();
            return Clan.forClan({ id: owner++, level: 3, leaderId: state.characterId, members: [state], state: {} },
                { timestamp, proofOffer: null, halls: [],
                    equipment: [{ memberId: state.characterId, plan: { target: { selfId: 356 }, market: { price: 1 } } }] })
                .network.queue.find(row => row.object.itemId === 356)?.valueHours;
        };
        try {
            Decisions.clanNumbers = () => ({ horizonHours: 40, huntPerHour: 1000, updatedAt: 1 });
            const basicsWith = deathHours => () => ({ timestamp, persona: {}, hunt: { perHour: 1000, expPerHour: 1000 }, deathHours });
            // A clan projection's member carries its persona (ClanGoalService).
            const known = { ...member, persona: { traits: {} } };
            Economy.basics = basicsWith(3);
            const fromBasics = worth(known);
            Economy.basics = basicsWith(30);
            assert.notEqual(worth(known), fromBasics, 'fixture: the armour\'s worth reads the death hours');
            Economy.basics = () => { throw Error('a member with a danger packet needs no basics'); };
            const packed = { ...known, stats: { ...known.stats, dangerPrice: [3, 0.5] } };
            assert.equal(worth(packed), fromBasics, 'the packet\'s death hours value the gear as the basics do');
        } finally { Decisions.clanNumbers = clanNumbers; }
    } finally {
        Economy.basics = nativeBasics; Providers.gearGain = nativeGain;
        Clan.reset(); Profile.forgetBuild(member.characterId);
    }
    assert.equal(invoke('Database').isReady(), false);
    require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
    console.log('PASS native weapon replacement, receipt parity, shield, instances, SA rejection and build change', isMainThread ? 'main' : 'worker');
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
