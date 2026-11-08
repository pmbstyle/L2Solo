'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
const Packet = require('../src/GameServer/Bot/Economy/StatsPacket');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('npc-basket');
require('../src/Global'); fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const DB = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState'), Goals = invoke('GameServer/Bot/Goals/GoalState');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const Basket = require('../src/GameServer/Bot/Economy/NpcPurchaseBasket');
const SavedStats = require('../src/GameServer/Bot/SavedStats');
const Native = require('./helpers/nativeMarketFixture');
Data.init();
const seller = Basket.sellerFor(2509, 'Dion', 18);
assert(seller, 'actual default C4 NPC quote exists');
const lines = [{ selfId: 2509, amount: 100, unitPrice: 18 }, { selfId: 1060, amount: 2, unitPrice: 108 },
    { selfId: 736, amount: 1, unitPrice: 480 }];
async function seed(id, wallet = 5000, stats = {}, phase = 'cold') {
    await Native.character(DB, id, `Basket${id}`, `bot_basket_${id}`);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: wallet });
    return Life.upsertState({ characterId: id, name: `Basket${id}`, accountName: `bot_basket_${id}`,
        phase, activity: 'shopping', level: 1, adena: wallet, currentRegion: 'Dion', loc: seller,
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
        inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
        stats: { classId: 0, money: [0, 0, 0, 0], ...stats } }, 'basket_fixture');
}
const amount = async (id, item) => Native.amount(await DB.fetchItems(id), item);
async function native(state, settings) {
    const admitted = await Commit.admit(state, Commit.KINDS.npcBuy);
    try { return { admitted, result: await DB.purchaseNpcInventoryBasket(state.characterId,
        { seller, lines, ...settings, coldState: admitted.state, economyCommand: admitted.command }) }; }
    finally { Commit.finish(state.characterId, admitted.command); }
}
async function run() {
    await DB.init();
    const at = Date.now(), first = { selfId: 2509, town: 'Dion', amount: 120, at, purpose: 'shots', money: 2160 };
    const unrelated = { selfId: 736, town: 'Giran', amount: 2, at, purpose: 'scrolls' };
    let state = await seed(9511, 5000, { marketErrands: [first, unrelated], marketErrand: first });
    const goal = await Goals.set(9511, { type: 'buy_craft_material', status: 'active',
        target: { itemId: 2509, amount: 120 }, plan: { purpose: 'shots' } });
    const chosen = lines.map(line => ({ ...line }));
    chosen[0].errands = [{ errand: first, units: 100, spent: 1800 }];
    chosen[0].goal = { expectedGoal: goal.current, updatedAt: goal.updatedAt, units: 100 };
    const purchased = await Basket.purchase(state, { seller, lines: chosen });
    assert(purchased.ok && purchased.purchased);
    assert.equal(await amount(9511, 57), 2504);
    assert.equal(await amount(9511, 2509), 100); assert.equal(await amount(9511, 1060), 2); assert.equal(await amount(9511, 736), 1);
    assert.equal(purchased.state.adena, 2504); assert.equal(purchased.state.inventory[2509].amount, 100);
    assert.equal(purchased.state.stats.marketErrands[0].amount, 20);
    assert.equal(purchased.state.stats.marketErrands[0].money, 360);
    assert.deepEqual(purchased.state.stats.marketErrands[1], unrelated);
    assert.equal(Goals.snapshot(9511).current.target.amount, 20);
    assert(Buffer.byteLength(JSON.stringify(purchased.economyCommit)) <= 384);
    const replay = await Basket.purchase(purchased.state, { seller: { ...seller, sourceId: 1 }, lines: [], original: purchased.economyCommand });
    assert(replay.replayed); assert.equal(await amount(9511, 57), 2504);
    assert.equal(replay.state.stats.marketErrands[0].amount, 20); assert.equal(Goals.snapshot(9511).current.target.amount, 20);
    await DB.close(); await DB.init();
    const restarted = await Basket.purchase(replay.state, { seller, lines: [], original: purchased.economyCommand });
    assert(restarted.replayed); assert.equal(await amount(9511, 2509), 100);

    state = await seed(9512, 5000, { marketErrands: [first], marketErrand: first });
    const rollbackGoal = await Goals.set(9512, { type: 'buy_craft_material', status: 'active',
        target: { itemId: 2509, amount: 120 }, plan: { purpose: 'shots' } });
    const rollbackLines = lines.map(line => ({ ...line }));
    rollbackLines[0].errands = [{ errand: first, units: 100, spent: 1800 }];
    rollbackLines[0].goal = { expectedGoal: rollbackGoal.current, updatedAt: rollbackGoal.updatedAt, units: 100 };
    const admission = await Commit.admit(state, Commit.KINDS.npcBuy);
    await DB.execute(["CREATE TEMP TRIGGER fail_basket BEFORE INSERT ON items WHEN NEW.characterId=9512 AND NEW.selfId=1060 BEGIN SELECT RAISE(ABORT,'basket rollback'); END"]);
    try { await assert.rejects(DB.purchaseNpcInventoryBasket(9512, { seller, lines: rollbackLines,
        economyCommand: admission.command }), /basket rollback/); }
    finally { Commit.finish(9512, admission.command); }
    assert.equal(await amount(9512, 57), 5000); assert.equal(await amount(9512, 2509), 0);
    const row = (await DB.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=9512']))[0];
    const [intent] = await DB.execute(['SELECT tuple FROM bot_economy_intents WHERE characterId=9512']);
    assert.equal(JSON.parse(intent.tuple)[1], 0, 'the rolled-back purchase leaves its intent pending');
    assert.equal(JSON.parse(row.statsJson).marketErrands[0].amount, 120);
    assert.equal(JSON.parse((await DB.execute(['SELECT goalJson FROM bot_goal_state WHERE characterId=9512']))[0].goalJson).target.amount, 120);
    await DB.execute(['DROP TRIGGER fail_basket']);
    assert((await DB.purchaseNpcInventoryBasket(9512, { seller, lines: rollbackLines, economyCommand: admission.command })).ok);

    state = await seed(9513, 1000);
    await assert.rejects(Basket.purchase(state, { seller, lines: [
        { selfId: 2509, amount: 50, unitPrice: 18 }, { selfId: 736, amount: 1, unitPrice: 480 }] }), /funding_changed/);
    assert.equal(await amount(9513, 57), 1000); assert.equal(await amount(9513, 2509), 0);
    state = await seed(9514);
    await assert.rejects(native(state, { seller: { ...seller, town: 'Giran' } }), /seller_changed/);
    await assert.rejects(native(Life.cachedState(9514), { lines: [{ selfId: 2508, amount: 1, unitPrice: 300 }] }), /quote_changed/);
    await assert.rejects(native(Life.cachedState(9514), { lines: [{ selfId: 2509, amount: Number.MAX_SAFE_INTEGER, unitPrice: 18 }] }), /invalid npc purchase/);
    assert.equal(await amount(9514, 57), 5000);

    state = await seed(9515, 5000, { money: [0, .001, 1000, 0, .003, 3000, 999] });
    await assert.rejects(Basket.purchase(state, { seller, lines: [{ selfId: 2509, amount: 100, unitPrice: 18,
        fundingParts: [{ amount: 50, funding: { r: .002 }, order: 0 }, { amount: 50, funding: { r: .001 }, order: 1 }] }] }), /funding_changed/);
    assert.equal(await amount(9515, 2509), 0); assert.equal(await amount(9515, 57), 5000);

    state = await seed(9516, 5000, {}, 'hot');
    state = await Life.upsertState({ ...state, activity: 'hunting', currentRegion: 'Tarlk Bugbear fields',
        loc: { locX: 96534, locY: 16945, locZ: -3320 } }, 'basket_stale_background_anchor');
    const Actor = invoke('GameServer/Model/Actor'), Backpack = invoke('GameServer/Actor/Backpack');
    const actor = new Actor({ id: 9516, name: 'Basket9516', classId: 0, race: 0, level: 1,
        hp: 100, maxHp: 100, mp: 100, maxMp: 100, locX: seller.locX, locY: seller.locY, locZ: seller.locZ });
    actor.backpack = new Backpack({ paperdoll: {}, items: [] });
    for (const item of await DB.fetchItems(9516)) actor.backpack.insertItem(item.id, item.selfId, { ...item });
    actor.session = { actor, coldLifeState: state, plan: 'shopping', botSession: true };
    const hot = await Basket.purchaseForActor(actor, { seller, lines });
    assert(hot.ok); assert.equal(actor.backpack.fetchItemFromSelfId(57).fetchAmount(), 2504);
    assert.equal(hot.state.currentRegion, 'Dion', 'the live shop visit replaces the old background hunting region');
    assert.equal(hot.state.activity, 'shopping');
    assert.deepEqual(hot.state.loc, { locX: seller.locX, locY: seller.locY, locZ: seller.locZ });
    assert.equal(actor.backpack.fetchItemFromSelfId(2509).fetchAmount(), 100);
    await assert.rejects(Basket.purchaseForActor(actor, { seller: { ...seller, town: 'Giran' }, lines }), /npc_seller_changed/,
        'the physical town proof cannot authorize a seller in another town');
    assert.equal(await amount(9516, 57), 2504);
    const stale = Commit.header(hot.economyCommand[0], hot.economyCommand[1], hot.economyCommand[2],
        { ...hot.economyCommand.authority, phase: 'cold' });
    await assert.rejects(DB.purchaseNpcInventoryBasket(9516, { economyCommand: stale }), /owner_changed/);
    const fetch = DB.fetchItems;
    DB.fetchItems = async () => { throw Error('lost actor delivery'); };
    let delivered;
    try { delivered = await Basket.purchaseForActor(actor, { seller, lines: [], original: hot.economyCommand }); }
    finally { DB.fetchItems = fetch; }
    assert(delivered.ok && delivered.replayed, 'postcommit actor failure preserves saved success');
    assert.equal(await amount(9516, 57), 2504);
    const changedErrand = { ...first, amount: 40 };
    state = await seed(9517, 5000, { marketErrands: [changedErrand], marketErrand: changedErrand });
    const oldGoal = await Goals.set(9517, { type: 'buy_craft_material', status: 'active', target: { itemId: 2509, amount: 120 } });
    const newGoal = await Goals.set(9517, { type: 'progress_level', status: 'active', target: { level: 20 } });
    const changedLines = [{ ...chosen[0], goal: { expectedGoal: oldGoal.current, updatedAt: oldGoal.updatedAt, units: 100 } }];
    const unchanged = await Basket.purchase(state, { seller, lines: changedLines });
    assert.deepEqual(unchanged.state.stats.marketErrands[0], changedErrand);
    assert.deepEqual(Goals.snapshot(9517).current, newGoal.current);
    const actualPurchase = DB.purchaseNpcInventoryBasket;
    state = await seed(9518);
    await Goals.set(9518, { type: 'buy_craft_material', status: 'active', target: { itemId: 2509, amount: 120 } });
    DB.purchaseNpcInventoryBasket = async (...args) => {
        const committed = await actualPurchase.apply(DB, args);
        await Goals.set(9518, { type: 'progress_level', status: 'active', target: { level: 30 } });
        return committed;
    };
    try { assert((await Basket.purchase(state, { seller, lines: [lines[0]] })).ok); }
    finally { DB.purchaseNpcInventoryBasket = actualPurchase; }
    assert.equal(Goals.snapshot(9518).current.type, 'progress_level', 'new goal published after native commit survives old result delivery');
    const fundedPacket = [1000, .001, 0, 0, .1, 900, 2509, .05, 1440, 1060];
    const fundedLines = [{ selfId: 2509, amount: 50, unitPrice: 18, funding: { r: .1 } },
        { selfId: 1060, amount: 5, unitPrice: 108, funding: { r: .05 } }];
    state = await seed(9519, 1440, { money: fundedPacket });
    const fundedBasket = await Basket.purchase(state, { seller, lines: fundedLines });
    assert(fundedBasket.ok); assert.equal(await amount(9519, 57), 0);
    assert.equal(await amount(9519, 2509), 50); assert.equal(await amount(9519, 1060), 5);
    assert.deepEqual(fundedBasket.state.stats.money, [1000, .001, 0, 0, .1, 0, 2509, .05, 0, 1060]);
    const fundedRow = (await DB.execute(['SELECT statsJson, mindJson FROM bot_life_state WHERE characterId=9519']))[0];
    assert.deepEqual(SavedStats.merge(fundedRow.statsJson, fundedRow.mindJson).money, fundedBasket.state.stats.money,
        'native receipt persists consumed protection for the next seller');
    const armourSeller = Basket.sellerFor(45, 'Dion', 37560);
    assert(armourSeller && armourSeller.sourceId !== seller.sourceId, 'native second seller is the actual different armour NPC');
    state = await seed(9520, 38460, { money: [1000, .001, 0, 0, .1, 900, 2509, .05, 38460, 45] });
    const firstSeller = await Basket.purchase(state, { seller, lines: [fundedLines[0]] });
    const secondSeller = await Basket.purchase(firstSeller.state, { seller: armourSeller,
        lines: [{ selfId: 45, amount: 1, unitPrice: 37560, autoEquip: false, funding: { r: .05 } }] });
    assert(secondSeller.ok); assert.equal(await amount(9520, 57), 0); assert.equal(await amount(9520, 45), 1);
    state = await seed(9521, 1440, { money: fundedPacket });
    const part = await Basket.purchase(state, { seller, lines: [{ ...fundedLines[0], amount: 20 }, fundedLines[1]] });
    assert(part.ok); assert.equal(await amount(9521, 57), 540);
    assert.deepEqual(part.state.stats.money.slice(4), [.1, 540, 2509, .05, 540, 1060],
        'partial payment preserves the unpaid higher-priority contribution');
    state = await seed(9522, 1440, { money: fundedPacket });
    const originalBasket = DB.purchaseNpcInventoryBasket;
    const pending = await Commit.admit(state, Commit.KINDS.npcBuy);
    await DB.execute(["CREATE TEMP TRIGGER fail_funding_basket BEFORE INSERT ON items WHEN NEW.characterId=9522 AND NEW.selfId=1060 BEGIN SELECT RAISE(ABORT,'funding rollback'); END"]);
    try { await assert.rejects(originalBasket.call(DB, 9522, { seller, lines: fundedLines, economyCommand: pending.command }), /funding rollback/); }
    finally { Commit.finish(9522, pending.command); }
    assert.equal(await amount(9522, 57), 1440);
    const rolledBack = (await DB.execute(['SELECT statsJson, mindJson FROM bot_life_state WHERE characterId=9522']))[0];
    assert.deepEqual(SavedStats.merge(rolledBack.statsJson, rolledBack.mindJson).money, fundedPacket,
        'rollback restores original cumulative protection as well as cash');
    await DB.execute(['DROP TRIGGER fail_funding_basket']);
    state = await seed(9523, 1140, { money: [1000, .001, 0, 0, .1, 600, 2509, .05, 1140, 1060] });
    const craftInputs = await Basket.purchase(state, { seller, lines: [
        { selfId: 1785, amount: 2, unitPrice: 300, funding: { r: .1 } }, fundedLines[1]] });
    assert(craftInputs.ok); assert.equal(await amount(9523, 57), 0); assert.equal(await amount(9523, 1785), 2);
    assert.equal(await amount(9523, 2509), 0, 'input acquisition does not invent the eventual craft product');
    assert.deepEqual(craftInputs.state.stats.money.slice(4), [.1, 0, 2509, .05, 0, 1060]);
    const clanPacket = [1000, .001, 0, 2000];
    state = await seed(9524, 1000, { money: clanPacket });
    const clanCredit = await Basket.purchase(state, { seller, lines: [{ selfId: 736, amount: 1,
        unitPrice: 480, funding: { free: true, clanPart: 480 } }] });
    assert(clanCredit.ok); assert.equal(await amount(9524, 57), 520); assert.equal(await amount(9524, 736), 1);
    assert.deepEqual(clanCredit.state.stats.money, clanPacket, 'already credited clan money does not release personal funded protection');
    state = await seed(9525, 1000, { money: clanPacket });
    await assert.rejects(Basket.purchase(state, { seller, lines: [{ selfId: 736, amount: 1,
        unitPrice: 480, funding: { free: true, clanPart: 0 } }] }), /funding_changed/);
    assert.equal(await amount(9525, 57), 1000); assert.equal(await amount(9525, 736), 0);
    state = await seed(9526, 1000, { money: [1000, .001, 100, 0, .1, 720, 999] });
    await assert.rejects(Basket.purchase(state, { seller, lines: [{ selfId: 736, amount: 1,
        unitPrice: 480, funding: { free: true, clanPart: 300 } }] }), /funding_changed/);
    assert.equal(await amount(9526, 57), 1000, 'the same credit is not also counted as personal unprotected money');
    state = await seed(9527, 1000, { money: [1000, .001, 100, 2000, .002, 700, 999] });
    const nativeSurvival = await Basket.purchase(state, { seller, lines: [{ selfId: 736, amount: 1,
        unitPrice: 480, funding: { free: true, clanPart: 300, survivalCost: 200 } }] });
    assert(nativeSurvival.ok); assert.equal(await amount(9527, 57), 520);
    state = await seed(9528, 1000, { money: [1000, .001, 100, 2000, .002, 700, 999] });
    await assert.rejects(Basket.purchase(state, { seller, lines: [{ selfId: 736, amount: 1,
        unitPrice: 480, funding: { free: true, clanPart: 300, survivalCost: 150, valueHours: .8 } }] }), /funding_changed/);
    assert.equal(await amount(9528, 57), 1000, 'the shared and native value-hours/clan precedence matches exactly');
    // A side purchase (T177) passes the native writer on the money no row holds.
    state = await seed(9540, 1100, { money: [1000, .001, 100, 0, .1, 500, 999] });
    assert((await Basket.purchase(state, { seller, lines: [{ selfId: 736, amount: 1, unitPrice: 480,
        funding: { side: .002 } }] })).ok);
    assert.equal(await amount(9540, 736), 1);
    state = await seed(9541, 1000, { money: [1000, .001, 100, 0, .1, 500, 999] });
    await assert.rejects(Basket.purchase(state, { seller, lines: [{ selfId: 736, amount: 1, unitPrice: 480,
        funding: { side: .002 } }] }), /funding_changed/, 'the queue row keeps its money');
    state = await seed(9542, 5000, { money: [1000, .001, 100, 0] });
    await assert.rejects(Basket.purchase(state, { seller, lines: [{ selfId: 736, amount: 1, unitPrice: 480,
        funding: { side: .0001 } }] }), /funding_changed/, 'a scroll worth less than its price is refused');
    // The whole road: the plan a visit makes commits, the bot leaves with its scrolls.
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    Economy.configure({ spots: [], knowledgeEnabled: false });
    state = await seed(9543, 1000000, { classId: 1, marketReturn: { loc: { locX: 12000, locY: 90000, locZ: -3000 } } });
    state = { ...state, level: 30 };
    const packet = Economy.forState(state).statsPacket;
    // Its earning answer carries the spot's kit use (situations.md §14), as the worker's decision publishes it.
    state = await Life.upsertState(require('./helpers/ratedKit')({ ...state, stats: { ...state.stats, ...packet } }), 'basket_fixture');
    const Restock = invoke('GameServer/Bot/Economy/NpcRestockPlan');
    // A town restock buys from the build's published kit rates (stats.kitRates) over the live bag,
    // not a fresh earning-spot search's target: an outing's survival drinks, never less than one hour's.
    const Potions = invoke('GameServer/Bot/AI/HealingPotionStock'), potionId = Potions.purchasePotionFor(state).selfId;
    const potionLine = value => Restock.collect(value, { town: 'Dion', shots: false, scrolls: false })
        .flatMap(row => row.lines).find(line => line.selfId === potionId)?.amount || 0;
    const rates = Packet.ratesOf(state.stats.kitRates, state.stats.earning);
    assert(rates, 'the build publishes its kit rates');
    // The per-bot rates in stats.kitRates, the spot's use in the earning answer.
    const rated = changes => {
        const named = { ...rates, ...changes };
        return { ...state, stats: { ...state.stats, kitRates: Packet.kitRates(named),
            earning: { ...state.stats.earning, shotsPerHour: named.shotUse, potionsPerHour: named.potionUse } } };
    };
    const published = rated({ potionUse: 15, potionRestUse: 0, outingHours: 1 });
    assert.equal(potionLine(published), 15, 'the errand fills the published line (one hour of use)');
    const potionTarget = value => Potions.restockPlan(value, { unitPrice: Restock.quoteFor(potionId, 'Dion').price }).targetAmount;
    assert.equal(potionTarget(rated({ potionUse: 5, potionRestUse: 0, outingHours: 3 })), 15, 'its target is an outing of that use');
    assert.equal(potionTarget(rated({ potionUse: 5, potionRestUse: 0, outingHours: .5 })), 5, 'never less than one hour of it');
    // The rates are read by kind: a level or weapon change since the build buys its new potion at them.
    assert.equal(potionLine(rated({ potionUse: 15, potionRestUse: 0, outingHours: 1, potionId: 0 })), 15,
        'a row of another potion buys the bot\'s potion at the row\'s rates');
    // The spot's use by one rule on both threads (EquipmentIncomeRoute.spotUseOf): an answer saved before it
    // carried the use, a party member (its hunt is no answer's spot) and a bot holding no answer read the spot
    // table at their spot and level: each has a potion line on main and buys it on a town visit.
    {
        const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
        const { shotsPerHour, potionsPerHour, ...oldAnswer } = state.stats.earning;
        assert(shotsPerHour >= 0 && potionsPerHour > 0, 'fixture: the answer carries the use');
        const shapes = { old: { ...state, stats: { ...state.stats, earning: oldAnswer } },
            party: { ...state, partyId: 'bgp_basket', stats: { ...state.stats, earning: { ...state.stats.earning, potionsPerHour: 0 } } },
            none: { ...state, stats: { ...state.stats, earning: undefined } } };
        for (const [name, shape] of Object.entries(shapes)) {
            assert(Packet.lineOf(shape.stats.kitRates, Route.spotUseOf(shape), 'potions') > 0, `${name}: a potion line on main`);
            assert(potionLine(shape) > 0, `${name}: the town visit buys it`);
        }
    }
    // No build has rated the kit yet: no potion is bought, no basics are built.
    const unrated = { ...state, stats: { ...state.stats, kitRates: undefined } };
    const basics = Economy.basics;
    Economy.basics = () => assert.fail('an unrated kit builds no basics');
    try { assert.equal(potionLine(unrated), 0, 'an unrated bot buys no potions'); } finally { Economy.basics = basics; }
    // Each step of a restock reads the bag after the virtual purchases before
    // it: an extra bought between the potions and the shots is in the sale
    // list the shots' step reads (a new bag, not the potions' one edited).
    {
        const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition'), keptKit = Economy.keptKit;
        const extra = 1835, seen = [];
        assert(Restock.quoteFor(extra, 'Dion'), 'fixture: Dion sells the extra');
        Economy.keptKit = (value, ...rest) => {
            seen.push(Disposition.saleCandidates(value, { unlimited: true, keptAmounts: {} }).find(row => row.selfId === extra)?.count || 0);
            return keptKit(value, ...rest);
        };
        try {
            const bought = Restock.collect(published, { town: 'Dion', scrolls: false, extras: [{ selfId: extra, amount: 10, funding: { r: 1 } }] })
                .flatMap(row => row.lines).find(line => line.selfId === extra)?.amount || 0;
            assert.equal(bought, 10, 'fixture: the extra is bought');
            assert.equal(seen[0], 0, 'the potions\' step sees the bag before it');
            assert.equal(seen.at(-1), 10, 'the shots\' step sees the extra in the sale list');
        } finally { Economy.keptKit = keptKit; }
    }
    // The rates the build just published buy what a fresh foundation buys.
    const Shot = invoke('GameServer/Inventory/ShotStock'), Scrolls = invoke('GameServer/Bot/Travel/ScrollStock');
    const shotId = rates.shotId, shotPrice = Restock.quoteFor(shotId, 'Dion')?.price || 7;
    const potionPrice = Restock.quoteFor(potionId, 'Dion').price, scrollPrice = Restock.quoteFor(736, 'Dion').price;
    const withContext = context => context ? { context } : {};
    const shotPlan = (value, context) => Shot.restockPlan(value, { plan: Shot.planForState(value), unitPrice: shotPrice,
        potionUnitPrice: 0, ...withContext(context) });
    const potionPlan = (value, context) => Potions.restockPlan(value, { unitPrice: potionPrice, ...withContext(context) });
    const scrollPlan = (value, context) => Scrolls.restockPlan(value, { unitPrice: scrollPrice, ...withContext(context) });
    const kept = Economy.keptKit(state), built = Economy.basics(state);
    assert.equal(kept.refillReserve, built.refillReserve, 'the same survival reserve');
    for (const id of [potionId, shotId, 736]) assert.equal(kept.kitCost(id), built.kitCost(id), `the same kit cost of ${id}`);
    assert.deepEqual(shotPlan(state), shotPlan(state, built), 'the same shot restock');
    assert.deepEqual(potionPlan(state), potionPlan(state, built), 'the same potion restock');
    assert.deepEqual([scrollPlan(state).amount, scrollPlan(state).cost], [scrollPlan(state, built).amount, scrollPlan(state, built).cost],
        'the same scroll restock (the row keeps three digits of its hours)');
    // Shots: whether they restock, their use, the stock the bag holds now.
    const shotRow = (shotsCanRestock, shotUse, owned) => ({ ...rated({ shotsPay: true, shotsCanRestock, shotUse, outingHours: 2 }),
        inventory: { ...state.inventory, [shotId]: { selfId: shotId, amount: owned } } });
    const restocking = shotPlan(shotRow(true, 250, 0));
    assert(restocking.needed, 'below one hour of use the bot restocks');
    assert.equal(restocking.targetAmount, 500, 'up to an outing of the published use');
    assert(restocking.amount >= 250, 'the survival part is always funded');
    const capped = shotPlan(shotRow(false, 250, 50));
    assert.equal(capped.targetAmount, 50, 'shots that cannot restock keep at most what the bag holds');
    assert.equal(capped.needed, false, 'and buy none');
    assert.equal(shotPlan(shotRow(false, 250, 80)).targetAmount, 80, 'capped shots follow the bag as it rises');
    const roseRestocking = shotPlan(shotRow(true, 250, 100));
    assert.equal(roseRestocking.targetAmount, 500, 'restockable shots keep the outing target as they rise');
    assert(roseRestocking.needed);
    // Scrolls: the hours one saves, the money a side purchase may take.
    const scrollRow = scrollHours => rated({ scrollHours });
    assert.equal(scrollPlan(scrollRow(rates.scrollHours)).funding.side, rates.scrollHours / scrollPrice, 'a scroll is worth the hours it saves');
    assert.equal(scrollPlan(scrollRow(0)).funding.side, 0, 'no saved hours, no side money');
    assert.equal(scrollPlan(scrollRow(null)).funding.side, 0, 'a row without scroll hours saves none: no route is solved on main');
    assert.equal((await Restock.purchase(state, { town: 'Dion', shots: false, potions: false })).receipts.length, 1);
    assert.equal(await amount(9543, 736), 1, 'a planned side purchase commits through the writer: one scroll for the outing');
    // A refusal the next pass cannot change ends the purchase, never the visit.
    const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
    state = await seed(9544, 1000000, { classId: 1, money: null, townVisit: { town: 'Dion', startedAt: Date.now() },
        marketReturn: { loc: { locX: 12000, locY: 90000, locZ: -3000 } } });
    const left = await Market.finishTownErrands({ ...state, level: 30 });
    assert.equal(left.stats.townVisit.completed, true, 'a refused basket ends the visit, the bot leaves town');
    state = await seed(9529, 10000000);
    const fullStack = await Basket.purchase(state, { seller, lines: [
        { selfId: 2509, amount: 16481, unitPrice: 18 }, { selfId: 1785, amount: 10001, unitPrice: 300 }] });
    assert(fullStack.ok); assert.equal(await amount(9529, 2509), 16481); assert.equal(await amount(9529, 1785), 10001);
    assert.equal(await amount(9529, 57), 10000000 - 16481 * 18 - 10001 * 300,
        'funded stack needs larger than ten thousand are bought in one transaction');
    state = await seed(9530, 10000000);
    await DB.setItem(9530, { selfId: 2509, name: 'Spiritshot', amount: Number.MAX_SAFE_INTEGER });
    await assert.rejects(Basket.purchase(state, { seller,
        lines: [{ selfId: 2509, amount: 1, unitPrice: 18 }] }), /invalid npc stack total/);
    assert.equal(await amount(9530, 57), 10000000); assert.equal(await amount(9530, 2509), Number.MAX_SAFE_INTEGER);
    state = await seed(9531, 1000000000);
    await assert.rejects(Basket.purchase(state, { seller: armourSeller,
        lines: [{ selfId: 45, amount: 10001, unitPrice: 37560, autoEquip: false }] }), /invalid npc purchase/);
    assert.equal(await amount(9531, 57), 1000000000); assert.equal(await amount(9531, 45), 0);
    // The wish's selected dual can differ from the native bridge project
    // still retained in equipmentPlan. Its input order owns the quantity.
    for (const [id, itemId, held, ordered] of [[9532, 126, 0, 2], [9533, 127, 1, 1]]) {
        const quote = invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffers(itemId, 'Giran')[0];
        assert(quote, 'the real NPC sells the selected dual-sword input');
        const swordSeller = Basket.sellerFor(itemId, 'Giran', quote.price);
        state = await seed(id, 10000000, { classId: 2, equipmentPlan: {
            strategy: 'market', status: 'active', target: { selfId: 123, slot: 7 },
            combine: { requirements: [{ selfId: 123, amount: 2 }] }
        } });
        if (held) await DB.setItem(id, { selfId: itemId, name: Data.items.find(row => row.selfId === itemId).template.name,
            amount: held, equipped: false, slot: 7 });
        state = await Life.upsertState({ ...state, level: 40, currentRegion: 'Giran', loc: swordSeller,
            inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)) }, 'dual_input_basket_fixture');
        const bought = await Basket.purchase(state, { seller: swordSeller,
            lines: [{ selfId: itemId, amount: ordered, unitPrice: quote.price, autoEquip: false }] });
        assert(bought.ok);
        assert.equal(await amount(id, itemId), 2, 'the ordered pair completes despite an unrelated bridge project');
        assert.equal(await amount(id, 57), 10000000 - ordered * quote.price, 'only the missing blades are paid for');
        await Basket.purchase(bought.state, { seller: swordSeller, lines: [], original: bought.economyCommand });
        assert.equal(await amount(id, itemId), 2, 'receipt replay cannot duplicate the blades');
    }
    console.log('Native NPC basket: actual seller, multi-item debit, partial progress, restart/replay, aggregate funding, rollback and hot delivery passed');
}
run().then(() => DB.close()).catch(async error => { console.error(error); process.exitCode = 1; await DB.close(); });
