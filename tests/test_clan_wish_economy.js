'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
require('./helpers/databaseIsolation');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-clan-economy-'));
const config = path.join(directory, 'default.ini');
const oldConfig = process.env.L2NODE_CONFIG_FILE, oldShared = process.env.L2NODE_SHARED_CONFIG_FILE;
fs.writeFileSync(config, fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8').replace(
    /^\[Database\]\r?\npath\s*=\s*[^\r\n]+/m,
    `[Database]\npath = ${path.join(directory, 'world.sqlite')}\nhistoryPath = ${path.join(directory, 'history.sqlite')}`));
process.env.L2NODE_CONFIG_FILE = config; delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
const Database = invoke('Database'), Data = invoke('GameServer/DataCache');
const Context = require('../src/GameServer/Clan/ClanEconomyContext');
const Hall = require('../src/GameServer/ClanHall/Policy');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Goals = invoke('GameServer/Clan/ClanGoalService');
const Market = invoke('GameServer/Clan/ClanMarketService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Actions = invoke('GameServer/Clan/ClanActionService');
const Events = require('../src/GameServer/Clan/ClanReviewEvents');
const done = label => console.log('PASS ' + label);
const warehouse = amount => [{ selfId: 57, amount, reservedAmount: 0 }];
const persona = { primaryDrive: 'status', traits: { ambition: 0.8, empathy: 0.8, commitment: 0.5, sociability: 0.7 } };

async function seedBot(id, clanId, adena = 10000) {
    const account = `bot_clan_economy_${id}`;
    await Database.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [account, 'test']]);
    await Database.execute([`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,hp,maxHp,mp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
        VALUES (?,?,?,1,0,40,100000,700000,500,500,250,250,0,0,0,0,83000,148000,-3400,?)`, [id, account, `ClanMember${id}`, clanId]]);
    const inventory = { 57: { selfId: 57, name: 'Adena', amount: adena } };
    // This clan fixture has no personal discretionary wishes. Publish that
    // existing money-queue state explicitly; native payments require its
    // authoritative packet even when a treasury supplies most of the price.
    const reserve = invoke('GameServer/Bot/Economy/EconomyContext').survivalReserve({
        characterId: id, level: 40, adena, inventory, stats: { classId: 1, clanId } });
    const money = invoke('GameServer/Bot/Economy/PurchaseFunding').packetFor({ queue: [], moneyPrice: 0, gap: null }, 0, reserve);
    await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,exp,sp,hp,maxHp,mp,maxMp,adena,phase,activity,currentRegion,
        locX,locY,locZ,inventorySummary,statsJson,updatedAt) VALUES (?,?,?,40,100000,700000,500,500,250,250,?,'cold','shopping','Giran',83000,148000,-3400,?,?,1)`,
        [id, account, `ClanMember${id}`, adena, JSON.stringify(inventory), JSON.stringify({ classId: 1, clanId, money })]]);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: adena, enchant: 0, equipped: false, slot: 0 });
    await Database.execute([`INSERT INTO bot_personas(characterId,seed,primaryDrive,archetype,traitsJson) VALUES (?,'test','status','clan',?)`, [id, JSON.stringify(persona.traits)]]);
}

async function main() {
    Data.init();
    const members = [{ characterId: 1, level: 40, currentRegion: 'Giran', stats: {}, persona }];
    const clan = { id: 1, level: 3, leaderId: 1, members, state: { mode: 'autonomous' } };
    const lot = { ...Hall.catalog.halls[0], ownerId: 0, round: 1 };
    const contexts = [{ inputKey: 'own', persona, hunt: { perHour: 100000, restFraction: 0.25 }, clanHorizon: 30,
        itemUsefulness: () => 4 }];
    const poor = Context.build(clan, { warehouse: warehouse(100000), memberContexts: contexts, halls: [lot] });
    const lowIncome = Context.build(clan, { warehouse: warehouse(50000000), memberContexts: contexts, halls: [lot] });
    assert.equal(poor.hallBid(lot), 0);
    assert(lowIncome.hallBid(lot) < lot.minimumBid,
        'a large purse alone does not make an expensive residence worth its dues income floor');
    assert.equal(lowIncome.moneyPrice, 1 / lowIncome.incomePerHour);
    const establishedMembers = Array.from({ length: invoke('GameServer/Clan/ClanRules').memberLimit(clan.level) },
        (_, at) => ({ ...members[0], characterId: at + 1, currentRegion: lot.town }));
    const establishedContexts = establishedMembers.map(member => ({ ...contexts[0], inputKey: `own:${member.characterId}` }));
    const rich = Context.build({ ...clan, members: establishedMembers }, {
        warehouse: warehouse(50000000), memberContexts: establishedContexts, halls: [lot] });
    assert(rich.hallBid(lot) >= lot.minimumBid);
    assert(rich.hallBid(lot) > lot.minimumBid * 1.15, 'wealth/value replaces minimum plus markup');
    assert(rich.hallBid(lot) + Hall.reserve(lot, Hall.desired(lot, establishedMembers)) <= 50000000);
    assert.equal(rich.incomePerHour, establishedMembers.length * 100000
        * invoke('GameServer/Clan/ClanContributionPolicy').duesRate(establishedContexts.map(context => context.persona.traits)));
    done('one clan purse: marginal money price, own dues and valued residence');

    // A clan item wish needs a real item origin (82e5323c): Ring Mail Breastplate
    // is sold by an NPC; the quest necklace this fixture used has no source.
    const mixed = Context.build(clan, { warehouse: warehouse(200000), memberContexts: contexts, halls: [lot],
        equipment: [{ memberId: 1, plan: { target: { selfId: 347 }, strategy: 'market', status: 'active', market: { price: 150000 } } }] });
    assert.equal(mixed.network.queue.filter(row => row.object.kind === 'equipment').length, 1);
    assert(mixed.network.queue.filter(row => row.funded).reduce((sum, row) => sum + row.price, 0) <= mixed.wallet);
    assert.equal(mixed.hallBid(lot), 0, 'an unfunded earlier wish cannot spend another purse');
    const opaque = Context.build(clan, { warehouse: [{ selfId: 57, amount: 50000000, reservedAmount: 50000000 }], memberContexts: contexts, halls: [lot] });
    assert.equal(opaque.wallet, 0); assert.equal(opaque.hallBid(lot), 0);
    done('member item and hall compete; existing warehouse reservations remain unavailable');

    Database.init(); await Database.initClanHalls();
    for (let id = 100; id < 105; id++) await seedBot(id, 77);
    await Database.execute([`INSERT INTO clans(id,name,level,leaderId) VALUES (77,'WishClan',2,100)`]);
    await Database.execute([`INSERT INTO clan_simulation_clans(clanId,mode,stateJson,createdAt,updatedAt) VALUES (77,'autonomous',?,1,1)`,
        [JSON.stringify({ mode: 'autonomous', leaderId: 100, memberIds: [100,101,102,103,104], warehouseRevision: 0, updatedAt: 1, goal: null })]]);
    await Database.execute([`INSERT INTO clan_warehouse_items(clanId,selfId,name,kind,amount,reservedAmount) VALUES (77,57,'Adena','Other.Currency',500000,0)`]);
    await Database.execute(["INSERT INTO accounts(username,password) VALUES ('clan_proof_seller','test')"]);
    await Database.execute([`INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES (200,'clan_proof_seller','ProofSeller',0,0,100,100,0,0,0,0,83000,148000,-3400)`]);
    const stock = await Database.setItem(200, { selfId: 1419, name: 'Blood Mark', amount: 1, enchant: 0, equipped: false, slot: 0 });
    const sale = await Database.createAfkTradeShop(200, { kind: 'sell_ad', storeType: 1, title: 'Proof of Blood', town: 'Giran',
        locX: 83000, locY: 148000, locZ: -3400, appearance: {},
        lines: [{ objectId: Number(stock.insertId), selfId: 1419, name: 'Blood Mark', count: 1, price: 500000, stackable: true }] });
    assert(sale.shop);
    await Afk.init();
    let wakes = 0;
    await Actions.startEvents(() => { wakes++; });
    await Life.init();
    await new Promise(resolve => setImmediate(resolve));
    assert((await Events.drain(Database)).some(event => event.clanId === 77));
    const beforeMovement = wakes;
    await Database.execute(['UPDATE bot_life_state SET locX=83100,updatedAt=updatedAt+1 WHERE characterId=100']);
    Life.acceptNewerLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=100']))[0]);
    assert.equal(wakes, beforeMovement, 'movement alone is not an economic replan');
    assert.equal(Events.pending(), 0);
    await Database.execute(['UPDATE bot_life_state SET adena=adena+1,updatedAt=updatedAt+1 WHERE characterId=100']);
    Life.acceptNewerLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=100']))[0]);
    assert.equal(Events.pending(), 0,
        'a member wallet publication alone does not replan a clan from every hunting payout');
    // Restore the genuine 10k physical/native wallet for the purchase below.
    await Database.execute(['UPDATE bot_life_state SET adena=10000,updatedAt=updatedAt+1 WHERE characterId=100']);
    Life.acceptNewerLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=100']))[0]);
    await Events.drain(Database);
    done('native Life publications keep member inputs available without movement or wallet wake loops');
    const projection = await Goals.clanProjectionById(77);
    const resolved = await Goals.resolveClan(projection);
    assert(resolved.ok, JSON.stringify(resolved));
    assert.equal(resolved.goal.type, 'item'); assert.equal(resolved.goal.plan.kind, 'market');
    assert.equal(resolved.goal.plan.maxPrice, 500000); assert.equal(resolved.goal.budget, 500000);
    assert(resolved.goal.economy); assert.equal(projection.members[0].persona.traits.ambition, 0.8);
    done('actual registered C4 proof offer becomes a funded level goal before farm preparation');
    await Events.drain(Database);
    // Native metadata publication on the same shop still carries its indexed
    // item keys; the real board subscriber addresses only interested clans.
    Afk.refreshRecord(sale.shop);
    const offerEvents = await Events.drain(Database);
    assert.deepEqual(offerEvents.map(event => event.clanId), [77]);
    assert(offerEvents[0].causes.includes('board'));
    done('native board refresh wakes the clan waiting for that original item');

    const current = await Goals.clanProjectionById(77);
    const protectedPay = await Database.payClanMember({ clanId: 77, characterId: 100, amount: 1, kind: 'member_gear' });
    assert.equal(protectedPay.code, 'clan_funds_short');
    const [moneyBefore] = await Database.execute(['SELECT SUM(amount) AS amount FROM clan_warehouse_items WHERE clanId=77 AND selfId=57']);
    const bad = await Database.payClanMember({ clanId: 77, characterId: 100, amount: 490000, kind: 'clan_level_purchase', progressionGoal: {
        ...current.state.goal, updatedAt: current.state.goal.updatedAt - 1 } });
    assert.equal(bad.code, 'clan_funds_short');
    assert.equal(Number((await Database.execute(['SELECT SUM(amount) AS amount FROM clan_warehouse_items WHERE clanId=77 AND selfId=57']))[0].amount), Number(moneyBefore.amount));
    done('ordinary or stale progression payment cannot consume the earmark');

    const buyer = current.members.find(member => Number(member.characterId) === Number(current.state.goal.assignedMemberIds[0]));
    const memberPart = Math.floor(invoke('GameServer/Bot/Economy/PurchaseFunding').spendable(buyer, 0, { free: true }));
    assert(memberPart > 0 && memberPart < 10000, 'the member retains its native operating reserve');
    const purchase = await Market.resolveClan(current);
    assert(purchase.purchased, JSON.stringify(purchase));
    assert(purchase.advanced.ok, JSON.stringify(purchase.advanced));
    const [advanced] = await Database.execute(['SELECT level FROM clans WHERE id=77']);
    assert.equal(Number(advanced.level), 3);
    const [proof] = await Database.execute(['SELECT COALESCE(SUM(amount),0) AS amount FROM clan_warehouse_items WHERE clanId=77 AND selfId=1419']);
    assert.equal(Number(proof.amount), 0, 'the proof is consumed exactly once');
    const [leader] = await Database.execute(['SELECT sp FROM characters WHERE id=100']);
    assert.equal(Number(leader.sp), 200000, 'native leader SP charge remains');
    const [clanMoney] = await Database.execute(['SELECT SUM(amount) AS amount FROM clan_warehouse_items WHERE clanId=77 AND selfId=57']);
    assert.equal(Number(clanMoney.amount), memberPart,
        'member spends only free money and the clan pays the exact remaining price');
    assert.equal((await Database.fetchItems(100)).filter(row => Number(row.selfId) === 1419).length, 0);
    const replay = await Market.resolveClan(await Goals.clanProjectionById(77));
    assert(replay.skipped);
    done('actual native board purchase, clan deposit, SP/warehouse charge and replay conservation');
    await Events.drain(Database);
    Events.changed(77, 'treasury'); Events.changed(77, 'treasury');
    await Actions.scheduleReviews();
    const queued = await Database.execute(["SELECT actionType,status FROM clan_actions WHERE clanId=77 AND actionKey LIKE '%:event:%'"]);
    assert.deepEqual(queued.map(row => row.actionType).sort(), ['goal_plan', 'supplies']);
    assert(queued.every(row => row.status === 'pending'));
    await Actions.scheduleReviews();
    assert.equal((await Database.execute(["SELECT COUNT(*) AS count FROM clan_actions WHERE clanId=77 AND actionKey LIKE '%:event:%'"]))[0].count, 2);
    done('coalesced addressed events admit one planning/supplies pair and no periodic repeat');

    await Database.execute(['UPDATE clan_warehouse_items SET amount=50000000 WHERE clanId=77 AND selfId=57']);
    const Efficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    for (let id = 100; id < 105; id++) {
        let state = await Life.findByCharacterId(id);
        for (let sample = 0; sample < 3; sample++) state = { ...state, stats: { ...state.stats,
            huntEfficiency: Efficiency.record(state, { spotId: 'hall-income-fixture', cycleMs: 180000,
                adena: 50000, exp: 1000, kills: 5 }) } };
        await Life.upsertState(state, 'test_hall_measured_income');
    }
    const plan = await Database.planClanHallFinance(77);
    assert(plan.ok, JSON.stringify(plan)); assert.equal(plan.goal.status, 'bidding');
    const [bid] = await Database.execute(['SELECT amount FROM clan_hall_bids WHERE clanId=77']);
    assert(Number(bid.amount) > Hall.definition(plan.goal.hallId).minimumBid * 1.15);
    const repeated = await Database.planClanHallFinance(77);
    assert.equal(repeated.goal.bid, Number(bid.amount), 'existing escrow is held instead of placing another bid');
    assert.equal((await Database.execute(['SELECT COUNT(*) AS count FROM clan_hall_bids WHERE clanId=77']))[0].count, 1);
    assert.equal((await Database.execute(['PRAGMA integrity_check']))[0].integrity_check, 'ok');
    done('actual autonomous value-based bid preserves native escrow and re-entry');
    console.log('PASS clan wish economy: 9 groups');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
    Actions.stopEvents(); Afk.stop?.(); await Life.settleWrites([100,101,102,103,104]); await Database.close();
    if (oldConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = oldConfig;
    if (oldShared === undefined) delete process.env.L2NODE_SHARED_CONFIG_FILE; else process.env.L2NODE_SHARED_CONFIG_FILE = oldShared;
    fs.rmSync(directory, { recursive: true, force: true });
});
