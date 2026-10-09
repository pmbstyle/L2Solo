'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gear-threat-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
process.env.L2NODE_PROGRESSION_RATE = 'x10';
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Skills = invoke('GameServer/Npc/NpcSkills');
const Threat = invoke('GameServer/Bot/Economy/GearThreat');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (error) { failures++; console.error(`not ok - ${name}\n${error.stack}`); }
}
const spots = [{ id: 'physical', npcEntries: [{ selfId: 130 }] },
    { id: 'magic', npcEntries: [{ selfId: 264 }] },
    { id: 'mixed', npcEntries: [{ selfId: 130 }, { selfId: 264 }] },
    { id: 'unknown', npcEntries: [{ selfId: 999999 }] }];
const state = (ids = [130], spotId = 'physical', stats = {}) => ({ characterId: 901,
    level: 19, inventory: {}, spotId, stats: { classId: 0, exp: 797708,
        targetCombat: { lastDefeatedNpcIds: ids }, ...stats } });
check('prepared membership matches every native NPC and retains bounded numeric data', () => {
    let count = 0, magic = 0;
    const seen = new Set();
    for (const npc of Data.npcs) {
        if (seen.has(npc.selfId)) continue;
        seen.add(npc.selfId); count++;
        const actor = { fetchSelfId: () => npc.selfId, fetchLevel: () => npc.template.level,
            fetchHp: () => npc.vitals?.maxHp || 1, fetchMaxHp: () => npc.vitals?.maxHp || 1 };
        const expected = Skills.combatSkillsFor(actor).some(skill => skill.fetchSpell() && skill.fetchTargetKind() === 'enemy') ? 3 : 1;
        magic += Number(expected === 3);
        assert.equal(Skills.threatFor(npc.selfId), expected, `NPC ${npc.selfId}`);
    }
    assert.ok(count >= 3608 && magic >= 669);
    assert.ok(Skills.threatBytes() <= 128 * 1024);
    assert.equal(Skills.threatFor(999999), 0);
    console.log(`catalogue: ${count} NPCs, ${magic} magical, ${Skills.threatBytes()} bytes`);
});
check('only own recent matched hunt observations permit physical defence', () => {
    const deps = { spots };
    assert.equal(Threat.maskFor(state(), deps), 1);
    assert.equal(Threat.maskFor(state([264], 'magic'), deps), 3);
    assert.equal(Threat.maskFor(state([], 'physical'), deps), 3);
    assert.equal(Threat.maskFor(state([130], 'magic'), deps), 3);
    assert.equal(Threat.maskFor(state([999999], 'unknown'), deps), 3);
    assert.equal(Threat.maskFor(state([130], 'absent'), deps), 3);
    assert.equal(Threat.maskFor(state([130]), {}), 3);
    assert.equal(Threat.maskFor(state([264, 130], 'mixed'), deps), 3);
    assert.equal(Threat.maskFor(state([264, ...Array(8).fill(130)], 'mixed'), deps), 1);
    assert.equal(Threat.maskFor(state([130], 'magic', { marketReturn: { spotId: 'physical' } }), deps), 1);
    for (const stats of [{ pvpEncounter: {} }, { wishFocus: ['scores:77'] },
        { relations: [{ targetId: 77, hostility: 1 }] }, { relations: [{ anger: 1 }] }])
        assert.equal(Threat.maskFor(state([130], 'physical', stats), deps), 3);
    assert.equal(Threat.maskFor(state(), { spots, memory: { relations: [{ hostility: 1 }] } }), 3);
    assert.equal(Threat.maskFor({ ...state(), phase: 'hot' }, deps), Threat.maskFor({ ...state(), phase: 'cold' }, deps));
});
check('preparation reuses unchanged sources and notices in-place hostile changes', () => {
    const bot = state(), deps = { spots }, first = Threat.prepare(bot, deps);
    assert.equal(Threat.prepare(bot, deps, first), first);
    bot.stats.relations = [{ hostility: 0 }];
    assert.equal(Threat.prepare(bot, deps, first), first);
    bot.stats.relations[0].hostility = 1;
    assert.equal(Threat.prepare(bot, deps, first).mask, 3);
    bot.stats.relations[0].hostility = 0;
    bot.stats.targetCombat.lastDefeatedNpcIds = [264]; bot.spotId = 'magic';
    assert.equal(Threat.prepare(bot, deps, first).mask, 3);
    assert.notEqual(Economy.inputKey(state(), deps), Economy.inputKey(state([264], 'magic'), deps));
});
check('same native build caches distinct physical/magic gains in both orders', () => {
    const necklace = Data.items.find(item => Number(item.selfId) === 118);
    assert.ok(necklace);
    for (const masks of [[1, 3], [3, 1]]) {
        const bot = state(); bot.characterId += masks[0];
        const build = Profile.buildGainsFor(bot, 1000);
        const values = new Map(masks.map(mask => [mask, Providers.gearGain(bot, necklace, 1000, build, mask)]));
        assert.equal(values.get(1).defence, 0);
        assert.ok(values.get(3).defence > 0);
        const original = Profile.powerFor;
        let evaluations = 0;
        Profile.powerFor = (...args) => { evaluations++; return original(...args); };
        try {
            for (const mask of masks) assert.deepEqual(Providers.gearGain(bot, necklace, 1000, build, mask), values.get(mask));
        assert.deepEqual(Providers.gearGain(bot, necklace, 1000, build), values.get(3));
            assert.equal(evaluations, 0, 'both threat variants hit the bounded native cache');
        } finally { Profile.powerFor = original; }
        assert.equal(values.get(1).attack, values.get(3).attack);
    }
});
check('saved level-19 build restores armour roots on physical hunt and keeps jewellery for magic', () => {
    // Recorded build, not a reconstruction of its historical purchase order.
    // Empty jewellery is a controlled variant; prices/offers are native x10.
    const fixture = require('./fixtures/facada-gear-threat.json');
    const Sources = invoke('GameServer/Bot/Population/ColdOccupationSources');
    const { BoardIndex } = invoke('GameServer/AfkTrade/BoardIndex');
    Sources.initialise();
    const trip = () => 0;
    trip.details = () => ({ known: true, hours: 0, fees: 0 });
    const hunt = { id: fixture.state.spotId, npcEntries: [{ selfId: 93 }, { selfId: 398 }, { selfId: 264 }] };
    const deps = { timestamp: fixture.timestamp, board: new BoardIndex(), spots: [hunt],
        tripCost: trip, npcOffersFor: id => Sources.npcOffersFor(id), knowledgeEnabled: false };
    const bot = structuredClone(fixture.state);
    for (const row of Object.values(bot.inventory)) if (row.kind === 'Armor.Jewel') {
        row.equipped = false; row.equippedCount = 0; row.equippedSlots = [];
    }
    const physical = Economy.forState(bot, deps);
    assert.equal(physical.gearThreatMask, 1);
    const physicalGear = physical.network.queue.filter(wish => wish.need === 'power' && wish.object?.itemId);
    assert.ok(physicalGear.some(wish => [42, 51, 38, 34].includes(wish.object.itemId)), 'armour competes in the existing queue');
    assert.ok(!physicalGear.some(wish => [1, 2, 3, 4, 5].includes(wish.object.slot)), 'absent magic is not a defensive gain');
    bot.stats.targetCombat.lastDefeatedNpcIds = [93, 398, 264];
    const magical = Economy.forState(bot, deps);
    assert.equal(magical.gearThreatMask, 3);
    assert.ok(magical.network.queue.some(wish => wish.key === 'power:116:4'));
    assert.ok(magical.network.queue.some(wish => wish.key === 'power:118:3'));
    Economy.reset();
});
if (failures) process.exitCode = 1;
else console.log('All gear threat checks passed.');
