'use strict';
const assert = require('node:assert/strict');
const { useRate } = require('./helpers/progressionRate');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gear-threat-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
useRate('x10');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Skills = invoke('GameServer/Npc/NpcSkills');
const Threat = invoke('GameServer/Bot/Economy/GearThreat');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
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
    assert.notEqual(Threat.maskFor(state(), deps), Threat.maskFor(state([264], 'magic'), deps));
});
check('physical and magic threats give distinct necklace gains', () => {
    const necklace = Data.items.find(item => Number(item.selfId) === 118);
    assert.ok(necklace);
    const bot = state();
    const values = new Map([1, 3].map(mask => [mask, Providers.gearGain(bot, necklace, 1000, mask)]));
    assert.equal(values.get(1).defence, 0);
    assert.ok(values.get(3).defence > 0);
    assert.deepEqual(Providers.gearGain(bot, necklace, 1000), values.get(3), 'the default threat is both');
    assert.equal(values.get(1).attack, values.get(3).attack);
});
check('saved level-19 build: survival shots, then armour gaps; empty jewel slots take owned jewellery', () => {
    // Recorded build, not a reconstruction of its historical purchase order.
    // Prices/offers are native x10. The bot misses its NG kit milestone
    // (PersonalGearProgression): the survival shot tranche leads, then only
    // gap-closing pieces compete; threat masks still shape gear value above.
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
    const unarmed = Economy.forState(bot, deps);
    assert.equal(unarmed.gearThreatMask, 1);
    assert.deepEqual(unarmed.network.queue.map(wish => wish.key), ['stock:shots'],
        'the missing survival shot tranche leads the kit');
    Economy.reset();
    bot.inventory[1835] = { selfId: 1835, amount: 20000, kind: 'Other.Shot' };
    const physical = Economy.forState(bot, deps);
    assert.equal(physical.gearThreatMask, 1);
    const physicalGear = physical.network.queue.filter(wish => wish.need === 'power' && wish.object?.itemId);
    // The armour gaps the T123 hunt tables price best (helmet, gloves, pants, breastplate).
    assert.ok(physicalGear.some(wish => [43, 50, 30, 23].includes(wish.object.itemId)), 'armour competes in the existing queue');
    assert.ok(!physicalGear.some(wish => [1, 2, 3, 4, 5].includes(wish.object.slot)), 'absent magic is not a defensive gain');
    Economy.reset();
    for (const row of Object.values(bot.inventory)) if (row.kind === 'Armor.Jewel') {
        row.equipped = false; row.equippedCount = 0; row.equippedSlots = [];
    }
    bot.stats.targetCombat.lastDefeatedNpcIds = [93, 398, 264];
    const magical = Economy.forState(bot, deps);
    assert.equal(magical.gearThreatMask, 3);
    const jewelRoots = magical.projection.roots.filter(key => /^power:\d+:[1-5]$/.test(key));
    assert.ok(jewelRoots.length > 0, 'empty jewel slots are kit gaps');
    assert.ok(jewelRoots.every(key => Number(bot.inventory[key.split(':')[1]]?.amount) > 0),
        'owned jewellery closes the gaps before purchases');
    assert.ok(!magical.projection.roots.some(key => ['power:116:4', 'power:118:3'].includes(key)),
        'jewellery below the NG milestone does not close a kit gap');
    Economy.reset();
});
if (failures) process.exitCode = 1;
else console.log('All gear threat checks passed.');
