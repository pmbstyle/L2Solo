'use strict';
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const { WishNetwork, createSolver } = require('../src/GameServer/Bot/Economy/WishNetwork');
const timestamp = 1791335800000;
function inventoryFor(items) {
    const inventory = {};
    for (const entry of items) {
        const old = inventory[entry.selfId];
        const equippedSlots = [...(old?.equippedSlots || []), entry.slot];
        inventory[entry.selfId] = { ...entry, amount: Number(old?.amount || 0) + 1,
            equipped: true, equippedCount: equippedSlots.length, equippedSlots };
    }
    return inventory;
}
function bot(classId, level, inventory = {}) {
    const state = { characterId: 990120, level, adena: 1000000, phase: 'cold', activity: 'hunting',
        currentRegion: 'Giran', loc: { locX: 81100, locY: 148000, locZ: -3466 }, stats: { classId }, inventory };
    state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(classId, level), timestamp);
    return state;
}
function verify() {
    const starter = inventoryFor(Data.newbieItems.find(row => row.classId === 0).items.filter(row => row.equipped)
        .map(row => ({ ...row, slot: Data.items.find(item => item.selfId === row.selfId).etc.slot })));
    const first = bot(0, 1, starter);
    assert(Progression.assess(first).required, 'starter clothes are never a completed working kit');
    assert(Progression.assess(first).gaps.get(7), 'starter weapon still needs replacement');
    for (const classId of [0, 10, 18, 25, 38, 49, 50, 53, 54, 56]) {
        const state = bot(classId, 10, inventoryFor(Gear.planFor({ classId, level: 10 }).items));
        assert.equal(Progression.assess(state).required, false, `working NG kit closes class ${classId}`);
        assert.equal(Progression.assess({ ...state, level: 19 }).required, false,
            'a completed working NG kit stays complete until the D milestone');
        assert(Progression.assess({ ...state, level: 20 }).required, 'NG kit opens D milestone at 20');
        const d = bot(classId, 20, inventoryFor(Gear.planFor({ classId, level: 20 }).items));
        assert.equal(Progression.assess(d).required, false, `full usable D kit closes class ${classId}`);
    }
    assert.equal(Progression.assess({ ...first, stats: { ...first.stats, clanId: 1 } }).required, false,
        'personal milestones do not take over clan planning');

    const kit = inventoryFor(Gear.planFor({ classId: 0, level: 10 }).items);
    const ear = Object.values(kit).find(row => row.equippedSlots.includes(2));
    kit[ear.selfId] = { ...ear, amount: 1, equippedCount: 1, equippedSlots: [1], slot: 1 };
    const paired = bot(0, 10, kit);
    assert.deepEqual([...Progression.assess(paired).gaps.keys()], [2]);
    const board = new BoardIndex();
    board.put({ id: 1, ownerId: 990121, storeType: 1, kind: 'shop', town: 'Giran',
        lines: [{ lineId: 1, selfId: ear.selfId, count: 2, enchant: 0, price: 100 }] });
    Economy.reset();
    const ctx = Economy.forState(paired, { spots: [], board, timestamp, npcOffersFor: () => [],
        routeRows: Array.from({ length: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.length },
            () => [true, 0, 0]) });
    assert(ctx.projection.roots.includes(`power:${ear.selfId}:2`), 'same-template second earring is an acquisition root');
    assert(!ctx.projection.roots.some(key => key.startsWith('level:')), 'XP goal waits for the working kit');
    const selected = Planner.preferredTarget(paired, { wishTargetId: ear.selfId, wishSlot: 2 });
    assert.equal(selected?.item.selfId, ear.selfId, 'native target planner accepts the second identical copy');
    const receipt = Planner.equipInventoryUpgrades(paired, { ...kit, [ear.selfId]: { ...kit[ear.selfId], amount: 2 } });
    assert(receipt[ear.selfId].equippedSlots.includes(2), 'native receipt equips both sides');
    assert.equal(Progression.assess({ ...paired, inventory: receipt }).required, false);

    const material = { selfId: 1864, amount: 10, kind: 'Other.Material', basePrice: 100 };
    const spare = bot(0, 10, { ...paired.inventory, 1864: material,
        1049: { selfId: 1049, amount: 2, name: 'Spellbook: Ice Bolt' } });
    const sale = Listing.evaluate(spare, { board: new BoardIndex(), now: timestamp, slots: 0,
        keptAmounts: {}, knowledgeEnabled: false });
    assert.equal(sale.warehouse.length, 0, 'surplus never becomes personal warehouse clutter');
    assert(sale.npc.some(row => row.selfId === 1864 && row.count === 10));
    assert(sale.npc.some(row => row.selfId === 1049 && row.count === 2));
    assert.equal(Disposition.warehouseCandidates(spare).length, 0);
    const amulet = Data.items.find(item => /^Amulet/.test(item.template?.name || '')
        && require('../src/GameServer/Items/ItemAcquisitionCatalog').hasSource(item.selfId));
    assert(amulet);
    const orcLoot = { ...spare, inventory: { [amulet.selfId]: { selfId: amulet.selfId, amount: 1 } } };
    assert.equal(Listing.classify(orcLoot, Disposition.saleCandidates(orcLoot, { keptAmounts: {} })[0]).action, 'npc');

    assert.equal(Hunt.netIncome({ adena: 1000, loot: 500, shots: 100, potions: 2 }, { shots: 10, potions: 100 }), 300);
    const sampled = Hunt.bestIncome([{ spotId: 'gross', adena: 1000, loot: 0, costs: 900, kills: 10, exp: 100, cycleMs: 60000 },
        { spotId: 'net', adena: 800, loot: 0, costs: 100, kills: 10, exp: 50, cycleMs: 60000 }]);
    assert.equal(sampled.spotId, 'net', 'shots and potions can reverse the preferred earning spot');
    const poorOrc = bot(44, 7, first.inventory);
    const noShots = Hunt.huntIncome(poorOrc, timestamp);
    assert(noShots.perHour > 0 && noShots.useShots === false,
        'negative paid-shot margins fall back to a positive native uncharged hunt');
    const poorEconomy = Economy.basics(poorOrc, { timestamp });
    assert.equal(poorEconomy.stock('shots').ownedUsePerHour, 0,
        'the fallback disables charges at the existing native consumption boundary');
    assert.equal(invoke('GameServer/Inventory/ShotStock').usePolicy(poorOrc, { timestamp }).usePerHour, 0,
        'the native combat preparation also respects the uncharged fallback');
    let losingOrc = poorOrc;
    for (let at = 0; at < 3; at++) losingOrc = { ...losingOrc, stats: { ...losingOrc.stats,
        huntEfficiency: Hunt.record(losingOrc, { spotId: noShots.spotId, timestamp, cycleMs: 60000,
            adena: 100, costs: 1000, exp: 100, kills: 10 }) } };
    const retry = Hunt.huntIncome(losingOrc, timestamp);
    assert(retry.perHour > 0 && retry.useShots === false, 'an observed loss cannot lock out a profitable fallback');
    const uncharged = invoke('GameServer/Bot/Economy/SpotEconomics').create(losingOrc,
        { timestamp, moneyWeight: 1 })({ id: retry.spotId, density: 1 }, false);
    assert(uncharged.income > 0, 'charged observations are not reused for an uncharged earning route');
    const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
    const spots = ['poor', 'rich'].map((id, at) => ({ id, avgLevel: 10, minLevel: 10, maxLevel: 10,
        density: 10, tagsAuthoritative: true, tags: ['starter'], npcEntries: [],
        center: { locX: -80000 + at * 1000, locY: 250000, locZ: 0 } }));
    let earning = { ...paired, spotId: 'poor', loc: spots[0].center };
    for (let at = 0; at < 3; at++) for (const spot of spots) earning = { ...earning, stats: { ...earning.stats,
        huntEfficiency: Hunt.record(earning, { spotId: spot.id, timestamp, cycleMs: 60000,
            adena: spot.id === 'poor' ? 1000 : 800, costs: spot.id === 'poor' ? 900 : 100,
            loot: 0, exp: 100, kills: 10 }) } };
    assert.equal(Route.select(earning, { spots, timestamp, required: true }).spot.id, 'rich',
        'a suitable current spot does not pin the bot when another has better net profit');
    let weak = { ...earning, level: 25, stats: { ...earning.stats, huntEfficiency: [] } };
    for (let at = 0; at < 3; at++) weak = { ...weak, stats: { ...weak.stats,
        huntEfficiency: Hunt.record(weak, { spotId: 'rich', timestamp, cycleMs: 60000,
            adena: 800, costs: 100, loot: 0, exp: 10, kills: 10 }) } };
    assert.equal(Route.select(weak, { spots, timestamp, required: true }).spot.id, 'rich',
        'a kit goal can use easier safe ground when the normal earning band has no profitable spot');

    const item = { key: 'item:1', price: 1000, paths: [
        { kind: 'drop', activity: 'hunting', spotId: 'rare', costHours: 0, readyHours: 10 },
        { kind: 'npc', activity: 'shopping', itemId: 1, price: 1000, costHours: 0.01, quoted: true }] };
    const required = { key: 'power:1:7', need: 'power', object: { itemId: 1, slot: 7 }, progressionPriority: 3,
        valueHours: .1, price: 1000, paths: [{ requirements: [{ key: item.key, amount: 1 }] }] };
    const xp = { key: 'level:11', need: 'power', valueHours: 1000, price: 0,
        paths: [{ activity: 'hunting', kind: 'experience', costHours: .01 }] };
    const result = new WishNetwork().build({ actorKey: 'stage', inputKey: 'one', remembered: false,
        nodes: [item, required, xp], roots: [required.key, xp.key], wallet: 0, hourAdena: 1000,
        moneyPaths: [{ activity: 'hunting', kind: 'money', spotId: 'profit', incomePerHour: 1000 }] });
    assert.equal(result.focus[0], required.key, 'XP cannot outbid missing equipment');
    assert.equal(result.activity.spotId, 'profit', 'one hour earning cash beats a ten-hour rare drop');
    assert.equal(result.plans.get(item.key).kind, 'npc');
    assert.equal(result.gap.key, required.key, 'necessary kit stays funded below the ordinary return floor');
    const waitingPlan = invoke('GameServer/Bot/AI/GearPlanSelection').selectAcquisitionPlan(first,
        { status: 'active', strategy: 'direct_drop', next: { spotId: 'rare' } },
        { timestamp, preparedEconomy: { network: result } });
    assert.equal(waitingPlan.acquisitionPlan.next, null, 'cash farming is not replaced by an old direct-drop plan');
    const paid = new WishNetwork().build({ actorKey: 'paid', inputKey: 'paid', remembered: false,
        nodes: [item, required, xp], roots: [required.key, xp.key], wallet: 1000, hourAdena: 1000 });
    const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
    const packet = Funding.packetFor(paid, 1000, 0);
    assert.equal(Funding.spendable({ adena: 1000, stats: { money: packet } }, 0, { itemId: 1 }), 1000,
        'a funded mandatory purchase is payable through the native money packet');
    const ordinary = { ...required, key: 'optional', progressionPriority: 0 };
    const shared = createSolver({ nodes: [item, required, ordinary], wallet: 0, hourAdena: 1000 });
    assert.equal(shared.rootWish(required.key).plan.requirements[0].plan.kind, 'npc');
    assert.equal(shared.rootWish(ordinary.key).plan.requirements[0].plan.kind, 'drop',
        'completion-time choices do not contaminate the ordinary source memo');
    assert.equal(shared.rootWish(required.key).plan.requirements[0].plan.kind, 'npc');
    const producer = { key: 'resale:101', need: 'power', object: { itemId: 101, amount: 1, kind: 'resale' },
        progressionFunding: true, valueHours: 10, paths: [{ kind: 'craft', activity: 'crafting', trial: true,
            repeatable: false, quoted: true, costHours: .1, grossRequirements: [{ key: 'item:1864', amount: 8 }] }] };
    const wood = { key: 'item:1864', object: 1864, price: 10, paths: [{ kind: 'buy', activity: 'shopping', price: 10 }] };
    const produce = wallet => new WishNetwork().build({ actorKey: 'produce', inputKey: 'produce', remembered: false,
        nodes: [item, required, producer, wood], roots: [required.key, producer.key], wallet, hourAdena: 1000,
        stockFor: id => ({ owned: id === 1864 ? 8 : 0, incoming: 0 }) });
    assert.equal(produce(0).activity.rootKey, producer.key, 'profitable native craft can fund an unaffordable kit');
    assert.equal(produce(1000).activity.rootKey, required.key, 'an affordable kit piece precedes another profit craft');
    const inputs = { key: 'resale:101', need: 'power', object: { itemId: 101 }, paths: [{ kind: 'craft', batches: 1,
        grossRequirements: [{ key: 'item:1864', amount: 8 }], requirements: [] }] };
    assert.equal(Disposition.selectedCraftAmounts(spare, { activity: { rootKey: inputs.key },
        plans: new Map([[inputs.key, inputs.paths[0]]]) })[1864], 8, 'active profitable craft protects only its actual inputs');
    const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
    const captured = Decision.compact(structuredClone(Decision.capture({ network: {
        activity: { rootKey: inputs.key, activity: 'hunting', spotId: 'recipe' },
        queue: [{ key: inputs.key, plan: inputs.paths[0] }] } }, spare)));
    assert.deepEqual(captured.activity.craftReservations, [[1864, 8]], 'physical craft reservations survive worker IPC');
    const protectedSale = Listing.evaluate(spare, { board: new BoardIndex(), now: timestamp, slots: 0,
        keptAmounts: {}, economy: { ...ctx, craftReservations: Object.fromEntries(captured.activity.craftReservations) } });
    assert.equal(protectedSale.npc.find(row => row.selfId === 1864)?.count, 2,
        'the main-thread market sells only the unused ingredient surplus');
    const spoilBoard = new BoardIndex();
    // Low-id bids must not hide a demanded high-id recipe from a spoiler.
    for (let id = 1; id < 30; id++) spoilBoard.put({ id: 100 + id, ownerId: 990121, storeType: 3, kind: 'buy_ad',
        town: 'Giran', lines: [{ lineId: 100 + id, selfId: id, count: 1, enchant: 0, price: 100 }] });
    spoilBoard.put({ id: 200, ownerId: 990121, storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 200, selfId: 1804, count: 2, enchant: 0, price: 10000 }] });
    const spoiler = bot(54, 25, inventoryFor(Gear.planFor({ classId: 54, level: 20 }).items));
    const originals = { index: Planner.sourceIndexFor, facts: Planner.sourceFacts };
    try {
        Planner.sourceIndexFor = () => new Map([[1804, [{ kind: 'drop' }, { kind: 'spoil' }]]]);
        Planner.sourceFacts = function* () { return ['drop', 'spoil'].map((kind, at) => ({ status: 'ready', kind,
            spotId: kind, npcId: 1, hours: .01 + at * .01, costHours: .01 + at * .01,
            netHourCost: 1, town: 'Giran', tripHours: 0, tripFees: 0 })); };
        const spoilContext = { ...ctx, board: spoilBoard };
        const demand = Providers.build(spoiler, spoilContext, { spots: [{}] });
        const root = demand.nodes.find(row => row.key === 'resale:1804');
        assert.equal(root?.object.amount, 2, 'recipe supply is bounded by actual market demand');
        assert.equal(demand.nodes.find(row => row.key === 'spoil:1804')?.paths[0].kind, 'spoil',
            'the earning route retains native spoil even when a drop source also exists');
        spoilBoard.remove(200);
        assert(!Providers.build(spoiler, spoilContext, { spots: [{}] }).roots.includes('resale:1804'),
            'withdrawing the buyer retires speculative recipe farming');
    } finally { Planner.sourceIndexFor = originals.index; Planner.sourceFacts = originals.facts; }
    console.log(`PASS personal gear: starter, NG/D classes, clan boundary, paired native receipt, liquidation, net income and completion time ${isMainThread ? 'main' : 'worker'}`);
}
verify();
if (isMainThread) {
    const worker = new Worker(__filename);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => { if (code) process.exitCode = code; });
} else parentPort.postMessage('verified');
