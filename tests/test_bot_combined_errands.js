'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'combined-errands-'));
const oldConfig = process.env.L2NODE_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'test.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
const defaults = fs.readFileSync(path.resolve(__dirname, '../config/default.ini'), 'utf8');
fs.appendFileSync(process.env.L2NODE_CONFIG_FILE, '\n' + defaults.slice(defaults.indexOf('[AuthServer]')));
require('./helpers/databaseIsolation');
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const Errands = invoke('GameServer/Bot/Population/CombinedErrandPolicy');
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Goals = invoke('GameServer/Bot/Goals/GoalExecutor');
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const Background = invoke('GameServer/Bot/Population/BackgroundResolver');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Actor = invoke('GameServer/Model/Actor');
const Backpack = invoke('GameServer/Actor/Backpack');
const Skill = invoke('GameServer/Model/Skill');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const withNativeInput = require('./helpers/nativeEconomyInput');
let serial = 0;
async function seed(items) {
    const account = `bot_combined_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `Combined${serial}`, race: 0, classId: 0,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 22000, locY: 140000, locZ: -3000 })).insertId);
    for (const item of items) await Database.setItem(id, { equipped: false, slot: 0, enchant: 0, ...item });
    return Life.upsertState({ characterId: id, accountName: account, name: `Combined${serial}`, level: 20,
        phase: 'cold', activity: 'hunting', loc: { locX: 22000, locY: 140000, locZ: -3000 },
        currentRegion: 'Dion fields', inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        adena: Number(items.find(item => item.selfId === 57)?.amount || 0),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { generatedCold: true, classId: 0 }, timing: {} }, 'combined_seed');
}
function held(state, id) { return Number(state.inventory?.[id]?.amount || 0); }
function physical(rows, id) { return rows.filter(row => Number(row.selfId) === id).reduce((n, row) => n + Number(row.amount), 0); }
async function run() {
    Database.init(); assert(Database.isReady()); Data.init(); await Life.init(); await Afk.init();
    // The mandatory floor has no economic/HP percentage threshold.
    assert.equal(Floor.evaluate({ hp: 1, mp: 1, slots: 79, load: 499, maxLoad: 1000 }), null);
    assert.equal(Floor.evaluate({ hp: 0 }).action, 'revive');
    assert.equal(Floor.evaluate({ hp: 1, mp: 4, manaRequired: true, castCosts: [5] }).reason, 'no_mp');
    assert.equal(Floor.evaluate({ hp: 1, mp: 4, manaRequired: true, castCosts: [4] }), null);
    assert.equal(Floor.evaluate({ hp: 1, mp: 0, castCosts: [5] }), null, 'melee is not forced to rest for mana');
    assert.equal(Floor.evaluate({ hp: 1, slots: 80 }).reason, 'no_slot');
    assert.equal(Floor.evaluate({ hp: 1, slots: 80, slotLimit: Floor.inventoryLimit(4) }), null);
    assert.deepEqual([0.499, 0.5, 2 / 3, 0.8, 1].map(share => Floor.weightPenalty(1000 * share, 1000)), [0, 1, 2, 3, 4]);
    console.log('PASS game floor boundaries');

    const mage = { characterId: 900001, level: 7, activity: 'hunting', phase: 'cold', inventory: {},
        vitals: { hp: 100, maxHp: 100, mp: 0, maxMp: 100 }, stats: { classId: 10 } };
    // Owned characters fight with their learned kit only (113e1791): the mage
    // carries the skills a level 7 Human Mystic has learned.
    mage.stats.coldCombat = Profile.legacySnapshot(mage, Profile.skillRecordsFromTree(10, 7));
    const profile = Profile.profileFor(mage);
    const skills = Profile.offensiveSkills(profile);
    assert(skills.some(skill => skill.mp > 0), 'shipped mage has an actual usable spell');
    const actor = new Actor({ classId: 10, race: 0, level: 7, hp: 100, maxHp: 100, mp: 0, maxMp: profile.maxMp,
        maxLoad: profile.maxLoad });
    actor.backpack = new Backpack({ paperdoll: {}, items: [] });
    actor.skillset = { fetchSkills: () => skills.map(skill => new Skill(skill)) };
    assert.equal(Floor.forActor(actor).reason, 'no_mp');
    assert.equal(Floor.forState(mage).reason, 'no_mp');
    const mandatoryRest = Needs.evaluate(mage)[0];
    assert.deepEqual({ type: mandatoryRest.type, priority: mandatoryRest.priority, kind: mandatoryRest.plan.kind },
        { type: 'recover', priority: 100, kind: 'rest' }, 'the native no-MP floor selects mandatory rest');
    assert.equal(Background.resolveSolo({ state: mage, timestamp: Date.now(), elapsedMs: 1000 }).patch.activity, 'resting');
    const lowHp = { ...mage, vitals: { ...mage.vitals, hp: 1, mp: profile.maxMp } };
    assert.equal(Needs.evaluate(lowHp).some(goal => goal.type === 'recover' && goal.priority === 100), false,
        'alive low HP retains ordinary recovery rather than a mandatory death floor');
    console.log('PASS hot/cold actual skill and live HP floor');

    actor.setMp(profile.maxMp);
    actor.backpack.insertItem(17, 17, { amount: 1 });
    const arrows = actor.backpack.fetchItemFromSelfId(17), array = actor.backpack.fetchItems();
    assert.equal(Floor.forActor(actor), null);
    const revision = actor.backpack.inventoryRevision;
    arrows.setAmount(Math.ceil(profile.maxLoad / arrows.fetchMass()));
    assert.equal(actor.backpack.fetchItems(), array, 'quantity-only producer keeps the original array');
    assert(actor.backpack.inventoryRevision > revision, 'direct native item setter invalidates this bag in O(1)');
    assert.equal(Floor.forActor(actor).reason, 'overweight');
    actor.backpack.items = [];
    Floor.forActor(actor);
    const retiredRevision = actor.backpack.inventoryRevision;
    arrows.setAmount(1);
    assert.equal(actor.backpack.inventoryRevision, retiredRevision, 'removed source cannot dirty the current bag');
    console.log('PASS quantity events and retired bag binding');

    const before = { ...mage, stats: { classId: 0 }, inventory: { 1835: { selfId: 1835, amount: 10 } }, adena: 1000 };
    assert.equal(Errands.edge(before, { ...before, inventory: structuredClone(before.inventory) }), null);
    assert.equal(Errands.edge(before, { ...before, adena: 2000 }), 'deal');
    assert.equal(Errands.edge(before, { ...before, inventory: { 1835: { selfId: 1835, amount: 9 } } }), 'shots');
    assert.equal(Errands.edge(before, before, { materialize: { items: [{ selfId: 1869, amount: 1 }] } }), 'bag');
    assert.equal(Errands.edge(before, { ...before, activity: 'traveling', adena: 2000 }), null);
    assert.equal(Errands.edge(before, { ...before, activity: 'resting', adena: 2000 }), null);
    console.log('PASS bag/shot/deal edges without passive checks');

    const seller = await seed([{ selfId: 1869, name: 'Iron Ore', amount: 3 }]);
    const source = (await Database.fetchItems(seller.characterId)).find(row => Number(row.selfId) === 1869);
    const records = await Afk.openBotRecords(seller.characterId, 'sell_ad', [{ storeType: Afk.SELL,
        town: 'Dion', locX: 15631, locY: 142885, locZ: -2704, title: 'Materials',
        lines: [{ objectId: source.id, selfId: 1869, name: 'Iron Ore', count: 3, price: 60, enchant: 0, slot: 0, stackable: true }] }]);
    assert.equal(records.opened.length, 1);
    let buyer = await seed([{ selfId: 57, name: 'Adena', amount: 500000 }, { selfId: 736, name: 'Scroll of Escape', amount: 3 },
        { selfId: 86, name: 'Sword of Revolution', amount: 1, equipped: true, slot: 7 }]);
    const now = Date.now();
    // A trip must pay for itself before travel (24512a44); a planned errand
    // carries its originating value (ColdMarketService.fundingTerms).
    const jobs = [
        { selfId: 1869, amount: 2, town: 'Dion', purpose: 'craft_input', maxPrice: 80, valueHours: 10, at: now },
        { selfId: 1060, amount: 2, town: 'Dion', purpose: 'healing', money: 50000, at: now },
        { selfId: 736, amount: 1, town: 'Dion', purpose: 'scrolls', money: 50000, at: now },
        { selfId: 1061, amount: 1, town: 'Giran', purpose: 'future_visit', at: now }
    ];
    for (const job of jobs) buyer = Errands.enqueue(buyer, job, now);
    buyer = Errands.enqueue(buyer, { ...jobs[0], amount: 2 }, now);
    assert.equal(Errands.pending(buyer).length, 4, 'refreshing a need adds no reservation or duplicate errand');
    const travel = Goals.beginMarketTravel(buyer, Market.errandGoal(jobs[0]), now);
    assert(travel && travel.activity === 'traveling');
    assert.equal(travel.stats.travel.townName, 'Dion');
    assert.equal(held(travel, 736), held(buyer, 736) - Number(!!travel.stats.travel.paid?.scroll), 'one paid departure');
    const fee = Number(travel.stats.travel.paid?.fee || 0);
    assert.equal(travel.adena, buyer.adena - fee);
    const originalReturn = structuredClone(travel.stats.marketReturn);
    const departed = await Life.upsertState(travel, 'combined_departure');
    const arrival = Background.resolveSolo({ state: departed, timestamp: travel.stats.travel.arrivalAt,
        elapsedMs: travel.stats.travel.arrivalAt - now });
    const arrived = await Life.applyResolve(departed, arrival);
    assert.equal(arrived.activity, 'shopping');
    assert.equal(arrived.currentRegion, 'Dion');
    assert.equal(Goals.finishMarketVisit(arrived), null, 'return waits for this town\'s work');
    // The record changed while the buyer travelled. That unavailable job must
    // neither use its saved price nor prevent the other native purchases.
    const sale = records.opened[0];
    await Afk.repriceBot(seller.characterId, sale.lines[0].id, 90, sale.revision);
    const policyFinished = await withNativeInput(arrived, accepted => Market.finishTownErrands(accepted));
    const beforeExecution = await Database.fetchItems(buyer.characterId);
    const basics = invoke('GameServer/Bot/Economy/EconomyContext').basics(policyFinished);
    assert.equal(arrived.level, invoke('GameServer/Progression/ProgressionCap').levelForExperience(arrived.exp || 0, buyer.level),
        'native arrival projects the original EXP0; the historical Life20 input does not grant XP');
    assert.equal(basics.kitCost(1060), 0, 'full HP supplies no missing healing kit');
    assert.equal(basics.kitCost(736), 0, 'the existing escape scroll stack supplies the kit');
    assert.equal(basics.stock('shots').target, 0, 'these unchanged arrival facts supply no economic shot stock');
    assert.equal(physical(beforeExecution, 1869), 0, 'changed quote remains refused');
    assert.equal(physical(beforeExecution, 1060), 0, 'an unvalued legacy healing errand is not funded');
    assert.equal(physical(beforeExecution, 736), held(arrived, 736), 'the unneeded scroll errand makes no purchase');
    assert.equal(policyFinished.adena, arrived.adena, 'no selected budget means no automatic payment');

    // Explicit execution seam for the original same-town quantities: native
    // merchant quote, physical SQL debit and unchanged scalar economy CAS.
    // This is NOT a voluntary E3 funding claim for those refused jobs.
    let finished = await Life.upsertState(policyFinished, 'combined_native_visit_finished');
    assert(finished, 'the actual completion marker is published before separate SQL execution');
    for (const job of jobs.slice(1, 3)) {
        const quoted = Market.planPurchase(finished, job.selfId, job.amount,
            { towns: ['Dion'], money: job.money, timestamp: now });
        assert(quoted && quoted.npcPrice > 0, 'the original stack has an authored local merchant quote');
        const Opportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
        const quote = [...Opportunity.npcOffersAll(job.selfId), ...Opportunity.fixedStoreOffers(job.selfId)]
            .find(offer => offer.town === 'Dion' && Number(offer.price) === Number(quoted.npcPrice));
        assert(quote, 'execution uses the actual source shop price');
        const beforeWallet = finished.adena;
        const bought = await Database.purchaseNpcInventoryItem(finished.characterId,
            { selfId: job.selfId, amount: job.amount, unitPrice: Number(quote.price), coldState: finished });
        assert(bought.ok && bought.coldLifeRow);
        const old = finished;
        finished = Life.acceptLifecycleRow(bought.coldLifeRow);
        assert.equal(finished.adena, beforeWallet - job.amount * Number(quote.price));
        await assert.rejects(Database.purchaseNpcInventoryItem(old.characterId,
            { selfId: job.selfId, amount: 1, unitPrice: Number(quote.price), coldState: old }), /economy_state_changed/);
        assert.equal(Life.snapshot(finished.characterId).adena, finished.adena, 'stale execution rolls back its physical debit');
    }
    const bag = await Database.fetchItems(buyer.characterId);
    assert.equal(physical(bag, 1869), 0, 'changed offer is rechecked against its authored price cap');
    assert.equal(physical(bag, 1060), 2, 'other same-town NPC errand is completed');
    assert.equal(physical(bag, 736), held(arrived, 736) + 1, 'scroll errand is not another town payment');
    assert.equal(Errands.pending(finished, Date.now(), 'Dion').length, 0);
    assert.equal(Errands.pending(finished).length, 1, 'a different town does not get smuggled into this visit');
    assert.deepEqual(finished.stats.marketReturn, originalReturn, 'original physical return remains');
    const shotPlan = ShotStock.planForState(finished);
    assert(shotPlan.perAction > 0);
    assert.equal(held(finished, shotPlan.selfId), 0, 'the refused stock has not been invented by explicit other-item executions');
    assert(finished.adena < arrived.adena, 'actual purchases debit the wallet');
    assert.equal(physical(bag, 57), finished.adena, 'physical and lifecycle wallet remain equal');
    console.log('PHYSICAL_EXECUTION_SEAM', JSON.stringify({ inputLevel: buyer.level, arrivalLevel: arrived.level,
        exp: arrived.exp, policyWallet: policyFinished.adena, executedWallet: finished.adena,
        healing: physical(bag, 1060), scrolls: physical(bag, 736), shots: physical(bag, shotPlan.selfId) }));
    const returning = Goals.finishMarketVisit(finished);
    assert(returning && returning.activity === 'traveling');
    assert.equal(held(returning, 736), held(finished, 736), 'return consumes no second departure scroll');
    console.log('PASS native one-town queue, changed quote, supplies and one return');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (oldConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = oldConfig;
    console.log('CLEANUP', !fs.existsSync(directory));
});
