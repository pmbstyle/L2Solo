'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('weapon-grade-progression');
require('../src/Global');
fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init();
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const timestamp = 1791801314861;
const byId = id => Data.items.find(row => Number(row.selfId) === Number(id));
let actorSequence = 0;
function archer(level, adena = 7023276) {
    const inventory = {};
    // The x50 archer's worn D kit and working NG bow, including both rings.
    for (const [selfId, slot] of [[848, 1], [847, 2], [910, 3], [879, 4], [879, 5],
        [45, 6], [606, 9], [391, 10], [415, 11], [1123, 12], [272, 14]]) {
        const row = inventory[selfId] || { selfId, amount: 0, equippedCount: 0, equippedSlots: [] };
        inventory[selfId] = { ...row, amount: row.amount + 1, equipped: true,
            equippedCount: row.equippedCount + 1, equippedSlots: [...row.equippedSlots, slot], slot };
    }
    for (const selfId of [1835, 1463, 1464, 1341, 1342, 1343, 1061, 736])
        inventory[selfId] = { selfId, amount: 1000000 };
    // Separate scenarios must not inherit another actor's held economic decision.
    return { characterId: 990987 + ++actorSequence, name: `WeaponGrade${level}`, accountName: `bot_weapon_grade_${level}`,
        level, adena, phase: 'cold', activity: 'hunting', currentRegion: 'Giran',
        loc: { locX: 83396, locY: 147904, locZ: -3404 }, timing: {},
        vitals: { hp: 1200, maxHp: 1200, mp: 1000, maxMp: 1000 }, inventory,
        stats: { classId: level < 40 ? 22 : 9, role: 'archer', exp: Data.experience[level - 1] + 1,
            generatedCold: true, decisionSeq: 1, persona: { primaryDrive: 'progression', understanding: 1,
                traits: { caution: .5, commitment: 0, ambition: 0, resilience: .5,
                    assertiveness: .5, empathy: .5, sociability: .5 } } } };
}
const board = new BoardIndex();
const trip = town => town === 'Giran' ? 0 : Infinity;
trip.details = town => ({ known: town === 'Giran', hours: 0, fees: 0 });
const deps = { board, spots: [], timestamp, knowledgeEnabled: false, tripCost: trip,
    npcOffersFor: id => Market.npcOffers(id, 'Giran') };
const before20 = archer(19);
assert.equal(Progression.assess(before20).gaps.has(14), false, 'the working NG bow is adequate before D expertise');
// The milestone belongs to the shared equipment policy, including classes
// whose D weapon is crafted/combined rather than stocked by an NPC.
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Compatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const kinds = new Set();
for (const classId of [7, 8, 9, 22, 24, 37, 10, 12, 16, 5, 2, 3, 21, 34, 46, 47, 48, 54, 55, 56, 57]) {
    for (const level of [20, 45]) {
        const state = archer(level);
        state.stats = { ...state.stats, classId, role: Planner.roleFor({ stats: { classId } }) };
        state.inventory = {};
        for (const row of Gear.planFor({ classId, level: 10 }).items) {
            const old = state.inventory[row.selfId] || { amount: 0, equippedSlots: [] };
            state.inventory[row.selfId] = { ...row, amount: old.amount + 1, equipped: true,
                equippedCount: old.amount + 1, equippedSlots: [...old.equippedSlots, row.slot] };
        }
        const assessment = Progression.assess(state);
        const weaponGap = [...assessment.gaps.values()].find(row => Compatibility.isWeaponSlot(row.slot));
        assert.equal(weaponGap?.rank, 1, `class ${classId}, level ${level}: an attainable D weapon minimum`);
        assert.equal(weaponGap?.priority, 3, `class ${classId}, level ${level}: NG weapon precedes the rest of the kit`);
        const dWeapon = Gear.planFor({ classId, level: 20 }).items.find(row => Compatibility.isWeaponSlot(row.slot));
        assert(dWeapon);
        const template = byId(dWeapon.selfId);
        assert.equal(Progression.priority(template, dWeapon.slot, assessment), 3);
        for (const item of Data.items) if (['d', 'c'].includes(item.etc?.rank)
            && Compatibility.isWeaponSlot(item.etc.slot)
            && Planner.suitable(item, state, Planner.roleFor(state), item.etc.rank))
            assert.equal(Progression.priority(item, item.etc.slot, assessment), 3,
                'compatible one- and two-handed weapons close the same weapon slot debt');
        kinds.add(template.template.kind);
        const ready = { ...state, inventory: { [dWeapon.selfId]: { ...dWeapon, amount: 1,
            equipped: true, equippedCount: 1, equippedSlots: [dWeapon.slot] } } };
        const nextWeapon = [...Progression.assess(ready).gaps.values()]
            .find(row => Compatibility.isWeaponSlot(row.slot));
        assert(level < 40 ? !nextWeapon : nextWeapon?.rank === 2 && nextWeapon.priority === 3,
            'D closes the first grade floor, while C remains first at level 40+');
    }
}
assert(kinds.size >= 5, 'coverage includes multiple weapon kinds, not only bows');
const cases = [];
for (const level of [20, 25, 39, 40, 45, 55]) {
    const state = archer(level), gap = Progression.assess(state).gaps.get(14);
    assert.equal(gap?.rank, 1, `level ${level}: the missed D weapon remains an attainable minimum`);
    assert.equal(gap?.priority, 3, `level ${level}: the NG weapon precedes other kit slots`);
    const before = structuredClone(state);
    const context = Economy.forState(state, deps);
    const leaf = context.network.activity;
    assert.equal(leaf?.activity, 'shopping', `level ${level}: real NPC stock gives an executable weapon purchase`);
    const wish = context.network.queue.find(row => row.key === leaf.rootKey);
    assert.equal(wish?.object?.slot, 14);
    const target = byId(wish.object.itemId);
    assert.equal(target.template.kind, 'Weapon.Bow');
    assert.equal(target.etc.rank, 'd', 'an unavailable C forecast cannot block an affordable D bow');
    assert(target.stats.pAtk > byId(272).stats.pAtk);
    const selected = Selection.selectAcquisitionPlan(state, null, { spots: [], timestamp,
        preparedEconomy: context, planningOptions: { wishTargetId: target.selfId,
            findMarketOffer: item => Market.npcOffers(item.selfId, 'Giran')[0] } }).acquisitionPlan;
    assert.equal(selected.target.selfId, target.selfId);
    assert.equal(selected.strategy, 'market');
    assert.deepEqual(state, before, 'planning does not mutate the physical bag');
    const equipped = Planner.equipInventoryUpgrades(state, { ...state.inventory,
        [target.selfId]: { selfId: target.selfId, amount: 1, equipped: false } });
    const next = Progression.assess({ ...state, inventory: equipped });
    assert(level < 40 ? !next.gaps.has(14) : next.gaps.get(14)?.rank === 2,
        'after D arrives, the normal current-grade milestone resumes');
    assert(level < 40 || next.gaps.get(14)?.priority === 3, 'C weapon is required first after D arrives');
    cases.push({ state, context, selected, target });
}

// A ready C bow may close the same minimum directly; D is not a forced stop.
const state = archer(45);
board.put({ id: 771, ownerId: 991771, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 771, selfId: 281, count: 1, price: 1, enchant: 0 }] });
const readyC = Economy.forState(state, deps);
assert(readyC.projection.nodes.some(row => row.key === 'power:281:14' && row.progressionPriority === 3),
    'a real C supplier can satisfy the required weapon milestone');
assert.equal(readyC.network.activity?.itemId, 281, 'a ready affordable C bow can beat the D fallback');
board.remove(771);

// Real x50 failure: a cheap first material batch made the long C exchange
// fundable, but left the bot wearing its NG bow despite funded NPC D stock.
const unfinishedC = archer(45);
unfinishedC.inventory[1458] = { selfId: 1458, amount: 611 };
board.put({ id: 775, ownerId: 991775, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 775, selfId: 377, count: 16, price: 54635, enchant: 0 }] });
const stagedC = Economy.forState(unfinishedC, deps);
const stagedWish = stagedC.network.queue.find(row => row.key === stagedC.network.activity?.rootKey);
assert.equal(stagedC.network.activity?.activity, 'shopping');
assert.equal(byId(stagedWish?.object?.itemId)?.etc?.rank, 'd',
    'a ready D weapon precedes a funded but unfinished C material route');
assert.equal(byId(stagedC.network.activity?.itemId)?.template.kind, 'Weapon.Bow');
board.remove(775);
board.put({ id: 776, ownerId: 991776, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 776, selfId: 281, count: 1, price: 10000000, enchant: 0 }] });
const expensiveC = Economy.forState(archer(45, 1000000), deps);
assert.equal(byId(expensiveC.network.activity?.itemId)?.etc?.rank, 'd',
    'an unaffordable ready C offer does not block the funded D minimum');
board.remove(776);

// Working C slots are required at 40, in weapon -> armour -> jewellery order.
const progressionState = archer(40);
delete progressionState.inventory[272];
progressionState.inventory[275] = { selfId: 275, amount: 1, equipped: true, equippedCount: 1,
    equippedSlots: [14], slot: 14 };
delete progressionState.inventory[847]; // Empty earring must still wait for the weapon/body.
const cGaps = Progression.assess(progressionState);
assert.equal(cGaps.gaps.get(14)?.rank, 2);
assert.equal(cGaps.gaps.get(14)?.priority, 3);
assert([9, 10, 11, 12].every(slot => cGaps.gaps.get(slot)?.priority === 2));
assert.equal(cGaps.gaps.get(6)?.priority, 0, 'the optional helmet must not hold the working C kit');
assert([1, 2, 3, 4, 5].every(slot => cGaps.gaps.get(slot)?.priority === 1));
board.put({ id: 772, ownerId: 991772, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 772, selfId: 281, count: 1, price: 1000000, enchant: 0 },
        { lineId: 773, selfId: 2429, count: 1, price: 1, enchant: 0 },
        { lineId: 774, selfId: 852, count: 2, price: 1, enchant: 0 }] });
const weaponFirst = Economy.forState(progressionState, deps);
assert.equal(weaponFirst.network.activity?.itemId, 281,
    'C weapon precedes even extremely cheap armour and missing jewellery');
const cWeapon = Planner.equipInventoryUpgrades(progressionState, { ...progressionState.inventory,
    281: { selfId: 281, amount: 1, equipped: false } });
// Its rest reads the new kit (on the hunt it waits).
const armorState = { ...progressionState, activity: 'resting', inventory: cWeapon };
const armorNext = Economy.forState(armorState, { ...deps, caller: 'step' });
const armorWish = armorNext.network.queue.find(row => row.key === armorNext.network.activity?.rootKey);
assert.equal(armorWish?.object?.slot, 12, 'after the C weapon, available C armour precedes jewellery');
const cKit = {};
for (const row of Gear.planFor({ classId: 9, level: 40 }).items) {
    const old = cKit[row.selfId] || { amount: 0, equippedSlots: [] };
    cKit[row.selfId] = { ...row, amount: old.amount + 1, equipped: true,
        equippedCount: old.amount + 1, equippedSlots: [...old.equippedSlots, row.slot] };
}
const pairedEar = Object.values(cKit).find(row => row.equippedSlots.includes(2));
cKit[pairedEar.selfId] = { ...pairedEar, amount: 1, equippedCount: 1, equippedSlots: [1], slot: 1 };
const jewelryState = { ...progressionState, inventory: { ...progressionState.inventory, ...cKit } };
for (const id of Object.keys(progressionState.inventory)) if (cKit[id] === undefined && byId(id)?.etc?.slot)
    delete jewelryState.inventory[id];
const jewels = Progression.assess(jewelryState);
assert(jewels.required && [...jewels.gaps.values()].every(row => row.slot >= 1 && row.slot <= 5 && row.priority === 1),
    'after a full C weapon/body kit, only jewellery remains');
const jewelryLast = Economy.forState({ ...jewelryState, activity: 'resting' }, { ...deps, caller: 'step' });
const jewelryWish = jewelryLast.network.queue.find(row => row.key === jewelryLast.network.activity?.rootKey);
assert.equal(jewelryWish?.object?.slot, 2, 'the same native network finally purchases the missing C earring');
board.remove(772);

async function run() {
    const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Afk = invoke('GameServer/AfkTrade/AfkTradeService'), Cold = invoke('GameServer/Bot/Economy/ColdMarketService');
    const { character, amount } = require('./helpers/nativeMarketFixture');
    try {
        Database.init();
        for (const { state } of cases.filter(row => [20, 45].includes(row.state.level))) {
            await character(Database, state.characterId, state.name, state.accountName, state.loc);
            await Database.execute(['UPDATE characters SET classId=?, level=? WHERE id=?',
                [state.stats.classId, state.level, state.characterId]]);
            await Database.setItem(state.characterId, { selfId: 57, name: 'Adena', amount: state.adena, equipped: false, slot: 0 });
            for (const row of Object.values(state.inventory)) {
                for (const slot of row.equippedSlots || [0]) await Database.setItem(state.characterId,
                    { selfId: row.selfId, name: byId(row.selfId).template.name,
                        amount: row.equipped ? 1 : row.amount, equipped: !!row.equipped, slot });
            }
        }
        await Life.init(); await Afk.init();
        for (const { state, context, selected, target } of cases.filter(row => [20, 45].includes(row.state.level))) {
            const native = await Life.upsertState({ ...state, activity: 'shopping',
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(state.characterId)),
                stats: { ...state.stats, ...context.statsPacket, equipmentPlan: selected } }, 'fixture_weapon_grade');
            const quote = Market.npcOffers(target.selfId, 'Giran').find(row => row.price === selected.market.price);
            assert(quote);
            const bought = await Cold.buyOffer(native, quote, { qty: 1 });
            assert(bought.purchased, `level ${state.level}: the native purchase succeeds`);
            const items = await Database.fetchItems(state.characterId);
            assert.equal(amount(items, 57), state.adena - selected.market.price);
            assert(items.some(row => Number(row.selfId) === target.selfId && row.equipped));
            assert(items.filter(row => row.equipped && [7, 14].includes(Number(row.slot))).length === 1);
            assert.equal(amount(items, 272), 1, 'the replaced NG bow stays owned');
        }
        console.log('PASS all-class D weapon minimum at 20, native purchase/equip, C weapon -> armour -> jewellery');
    } finally {
        await Afk._resetForTests(); await Database.close(); Economy.reset();
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
