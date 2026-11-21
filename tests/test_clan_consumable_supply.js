'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('clan-consumables');
const Native = require('./helpers/nativeMarketFixture');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Shots = invoke('GameServer/Inventory/ShotStock');
const Supply = invoke('GameServer/Clan/ClanConsumableSupply');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Henna = invoke('GameServer/Henna/HennaRules');
const Data = invoke('GameServer/DataCache');
const clanId = 71;
const classId = 4;
const arrows = 17;
const plan = Shots.planForKind('soulshot', 'none');
const sql = (query, ...params) => Database.execute([query, params]);
const amount = async (id, item) => Native.amount(await Database.fetchItems(id), item);
const stock = (item, count, reserved = 0) => sql(`INSERT INTO clan_warehouse_items
    (clanId, selfId, name, amount, reservedAmount) VALUES (?, ?, ?, ?, ?)`,
clanId, item, Data.items.find(row => row.selfId === item).template.name, count, reserved);
const warehouse = async item => (await Database.fetchClanWarehouseItems(clanId))
    .filter(row => row.selfId === item).reduce((sum, row) => sum + row.amount, 0);

async function member(id, phase = 'cold', clan = clanId, adena = 10000, loc = {}, stats = {}) {
    const accountName = `bot_clan_supply_${id}`, name = `ClanSupplies${id}`;
    await Native.character(Database, id, name, accountName, loc);
    await sql('UPDATE characters SET classId = ?, level = 40, clanId = ? WHERE id = ?', classId, clan, id);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: adena });
    return Life.upsertState({
        characterId: id, accountName, name, phase, clanId: clan, activity: 'shopping', level: 40, adena,
        currentRegion: 'Giran', loc, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        stats: { classId, clanId: clan, money: [10000, .0001, 0, 0, .001, 21000, plan.selfId], ...stats }
    }, 'clan_supply_fixture');
}

const giran = { locX: 80518, locY: 147922, locZ: -3506 };
const shotRates = {
    earning: { shotsPerHour: 20.1, potionsPerHour: 0 },
    kitRates: invoke('GameServer/Bot/Economy/StatsPacket').kitRates({
        shotId: plan.selfId, shotBenefit: 1, shotsCanRestock: true, bagHours: 4.5,
        potionId: 1061, potionRestUse: 0, potionBenefit: 0
    })
};
const shotLeaf = { rootKey: 'stock:shots', itemId: plan.selfId, amount: 100 };

async function hotMember(id) {
    const state = await member(id, 'hot', clanId, 10000, giran, shotRates);
    const session = { coldLifeState: state, accountId: state.accountName, plan: 'shopping', dataSendToMe() {} };
    const Backpack = invoke('GameServer/Actor/Backpack');
    const backpack = new Backpack({ id, paperdoll: Array.from({ length: 16 }, () => ({})),
        items: await Database.fetchItems(id) });
    return session.actor = { session, backpack, fetchId: () => id, fetchName: () => state.name,
        fetchClanId: () => clanId, fetchLevel: () => 40, fetchClassId: () => classId, isDead: () => false,
        fetchExp: () => 0, fetchSp: () => 0, fetchLocX: () => giran.locX, fetchLocY: () => giran.locY,
        fetchLocZ: () => giran.locZ, fetchHp: () => 100, fetchMaxHp: () => 100,
        fetchMp: () => 100, fetchMaxMp: () => 100 };
}

async function cooldownDuringWithdrawal() {
    const actor = await hotMember(107);
    await stock(plan.selfId, 40);
    const transfer = Database.transferClanWarehouseToMember;
    const actorState = Economy.stateForActor;
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    Database.transferClanWarehouseToMember = async request => {
        entered.resolve();
        await release.promise;
        return transfer(request);
    };
    Economy.stateForActor = () => actor.session.coldLifeState;
    const giving = Supply.forActorShots(actor, { plan });
    try {
        await Promise.race([entered.promise, giving.then(() => assert.fail('transfer did not start'))]);
        const cooling = Life.markCold(actor.session, 'clan_supply_test_cooldown');
        release.resolve();
        const receipt = await giving;
        const cooled = await cooling;
        assert.equal(receipt.amount, 40);
        assert.equal(cooled.phase, 'cold');
        assert.equal(cooled.inventory[plan.selfId]?.amount, 40);
        const [row] = await sql('SELECT inventorySummary FROM bot_life_state WHERE characterId = ?', 107);
        const summary = invoke('GameServer/Bot/Population/InventorySummary');
        assert.equal(summary.read(row.inventorySummary)[plan.selfId]?.amount, 40);
        assert.equal(await amount(107, plan.selfId), 40);
        assert.equal(await warehouse(plan.selfId), 20);

        // A new earning answer can shrink the ordinary refill below the stock on hand.
        const repriced = await Life.upsertState({ ...cooled,
            stats: { ...cooled.stats, earning: { shotsPerHour: 1, potionsPerHour: 0 } }
        }, 'clan_supply_test_new_earning');
        const kit = Economy.keptKit(repriced);
        assert.equal(kit.stock('shots').survivalMissing, 60);
        assert.equal(kit.kitCost(plan.selfId, 10), 600, 'the started refill still has its survival funding');
        const npc = invoke('GameServer/Bot/Economy/NpcRestockPlan');
        const { receipts, state } = await npc.purchase(repriced, { potions: false, scrolls: false });
        assert.equal(receipts.reduce((sum, row) => sum + row.units, 0), 60, JSON.stringify(receipts));
        assert.equal(await amount(107, plan.selfId), 100);
        assert.equal(state.stats.clanShotRefill ?? null, null);
        console.log('PASS cooldown waits for clan withdrawal, and the cold NPC closes the original refill');
    } finally {
        release.resolve();
        await giving.catch(() => {});
        Database.transferClanWarehouseToMember = transfer;
        Economy.stateForActor = actorState;
    }
}

async function hotDecisionRefill() {
    const actor = await hotMember(108);
    const { session, backpack } = actor;
    await stock(plan.selfId, 40);
    const Events = invoke('GameServer/Bot/AI/DecisionEvents');
    const BotAI = invoke('GameServer/Bot/BotAI');
    const original = { actorState: Economy.stateForActor, raise: Events.raiseDecision, wake: BotAI.wakeup,
        auto: Shots.enableAutoShot, offers: AfkTrade.offers, buy: AfkTrade.buyFromShop };
    const checked = Promise.withResolvers(), events = [], purchases = [];
    try {
        Economy.stateForActor = () => ({ ...session.coldLifeState,
            inventory: Life.inventorySummaryFromItems(backpack.fetchItems()) });
        Events.raiseDecision = (_session, event) => events.push(event);
        BotAI.wakeup = () => checked.resolve();
        Shots.enableAutoShot = () => {};
        AfkTrade.offers = () => [{ store: 'seller', price: 1, count: 100 }];
        AfkTrade.buyFromShop = async (_id, _store, itemId, quantity) => {
            purchases.push(quantity);
            const item = backpack.fetchItemFromSelfId(itemId);
            item.setAmount(item.fetchAmount() + quantity);
            return {};
        };
        assert(Supply.reviewActorDecision(session, shotLeaf));
        await checked.promise;
        assert.deepEqual(events, ['stock_low:shots']);
        assert.equal(backpack.fetchItemFromSelfId(plan.selfId).fetchAmount(), 40);
        const next = await Supply.restockActor(actor, { town: 'Giran', unitPrice: 10, skipNpc: true });
        assert.equal(next.delta, 60, JSON.stringify(next));
        assert.deepEqual(purchases, [60]);
        assert.equal(backpack.fetchItemFromSelfId(plan.selfId).fetchAmount(), 100);
        console.log('PASS the hot decision keeps the shot refill open and buys exactly the remaining 60');
    } finally {
        Economy.stateForActor = original.actorState;
        Events.raiseDecision = original.raise;
        BotAI.wakeup = original.wake;
        Shots.enableAutoShot = original.auto;
        AfkTrade.offers = original.offers;
        AfkTrade.buyFromShop = original.buy;
    }
}

async function coldDecisionRefill() {
    const bot = await member(110, 'cold', clanId, 10000, giran, shotRates);
    const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const decisions = coordinator.economyDecisions, decided = decisions.decided;
    const Board = invoke('GameServer/Bot/Economy/BotAfkMarketService');
    await stock(plan.selfId, 40);
    try {
        decisions.decided = () => ({ activity: shotLeaf });
        const result = await Board.executePlan(bot, {});
        assert.equal(result.restockPending, true);
        assert.equal(await amount(110, plan.selfId), 40);
        await Life.settleWrites([110]);
        const current = Life.cachedState(110);
        assert.equal(Economy.keptKit(current).stock('shots').survivalMissing, 60);
        assert.equal(await warehouse(plan.selfId), 20);
        console.log('PASS the cold board plan preserves the refill after partial clan stock');
    } finally {
        decisions.decided = decided;
    }
}

async function clanDyesInPlanning() {
    const DyeStock = invoke('GameServer/Clan/ClanDyeStock');
    const Providers = invoke('GameServer/Bot/Economy/WishProviders');
    const Improvements = invoke('GameServer/Bot/Economy/BotImprovementService');
    const symbol = Henna.symbolForClass(classId, 3), dye = symbol.dyeSelfId;
    const rootKey = `henna:${symbol.id}`;
    const state = await member(109, 'cold', clanId, symbol.price, giran);
    const base = Economy.forState(state);
    const context = { ...base, deathHours: 1, persona: { primaryDrive: 'progression', traits: {} },
        hunt: { perHour: 100000, expPerHour: 100000 }, price: () => 1000 };
    const wish = () => Providers.build(state, context).nodes.find(row => row.key === rootKey);
    const channel = invoke('GameServer/Bot/Population/ColdTableChannel').shared;
    const TableMirror = invoke('GameServer/Bot/Population/TableMirror');
    const mirror = new TableMirror();
    channel.attach(mirror, 1, payload => {
        assert.deepEqual(mirror.apply(payload.tables), []);
        return true;
    });
    try {
        const before = wish();
        assert.equal(before.paths[0].activity, null);
        assert.equal(before.paths[0].requirements[0].amount, 10);

        await stock(dye, 10, 6);
        channel.flush();
        assert.deepEqual(mirror.rows(DyeStock.TABLE).get(clanId)?.[2], [[dye, 4]]);
        const partial = wish();
        assert.equal(partial.price, symbol.price + 6000);
        assert.equal(partial.paths[0].requirements[0].amount, 6);

        await sql('UPDATE clan_warehouse_items SET reservedAmount = 0 WHERE clanId = ? AND selfId = ?', clanId, dye);
        channel.flush();
        assert.deepEqual(mirror.rows(DyeStock.TABLE).get(clanId)?.[2], [[dye, 10]]);
        const ready = wish();
        assert.equal(ready.price, symbol.price);
        assert.equal(ready.paths[0].activity, 'improving');
        assert.deepEqual(ready.paths[0].requirements, []);
        const { changed, state: improved, reason } = await Improvements.reviewCold(state, {
            decide: () => ({ activity: { ...ready.paths[0], rootKey }, riskWeight: 1 })
        });
        assert.equal(changed, true, reason);
        assert.deepEqual(improved.stats.hennas.filter(Boolean), [symbol.id]);
        assert.equal(await amount(109, 57), 0);
        assert.equal(await amount(109, dye), 0);
        assert.equal(await warehouse(dye), 0);
        channel.flush();
        assert.equal(mirror.rows(DyeStock.TABLE).has(clanId), false);
        console.log('PASS the planner sees only free dyes, and a bot with just the fee draws the henna');
    } finally {
        channel.detach(mirror);
    }
}

async function hotDyePurchase() {
    const actor = await hotMember(111);
    const { session, backpack } = actor;
    const symbol = Henna.symbolForClass(classId, 3), dye = symbol.dyeSelfId;
    const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
    const Restock = invoke('GameServer/Bot/Economy/NpcRestockPlan');
    const seller = invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffersAll(dye).find(row => row.town === 'Giran');
    assert(seller);
    await stock(dye, 4);
    session.heldEconomy = { network: { activity: { activity: 'shopping', rootKey: `henna:${symbol.id}`,
        itemId: dye, amount: 6, heldAtDecision: 0 } } };
    session.companionShopping = { kind: 'npc_equipment_purchase', itemId: dye, amount: 6,
        price: seller.price, sourceId: seller.sourceId, target: { ...seller, name: 'Trader' } };
    const bought = [], restore = [];
    const stub = (object, name, replacement) => {
        const original = object[name];
        restore.push(() => { object[name] = original; });
        object[name] = replacement;
    };
    try {
        stub(Economy, 'stateForActor', () => ({ ...session.coldLifeState,
            inventory: Life.inventorySummaryFromItems(backpack.fetchItems()) }));
        stub(Restock, 'purchaseForActor', async (_actor, { extras }) => {
            bought.push(extras[0].amount);
            return { ok: true, receipts: [{ lines: [{ selfId: dye, unitPrice: seller.price, amount: extras[0].amount }] }] };
        });
        stub(Shopping, 'scheduleRestock', () => {});
        stub(invoke('GameServer/Bot/AI/CompanionEquipmentShopping'), 'planErrand', () => null);
        stub(invoke('GameServer/Bot/AI/BotEquipmentUpgrade'), 'applyBestUpgrades', () => []);
        stub(invoke('GameServer/Bot/BotSkillTraining'), 'review', async () => {});
        stub(invoke('GameServer/Bot/AI/TownChatter'), 'say', () => {});
        await Shopping.sellAndRestock(session, actor, null, {});
        assert.equal(await amount(111, dye), 4);
        assert.deepEqual(bought, [6], 'the plan already subtracted the four clan dyes');
        console.log('PASS a hot dye purchase keeps all six units after the planned clan withdrawal');
    } finally {
        restore.reverse().forEach(reset => reset());
    }
}

async function run() {
    fixture.assertConfigured(options.default);
    Data.init();
    Database.init();
    try {
        await Life.init();
        await sql("INSERT INTO clans(id, name, level, leaderId) VALUES (?, 'Supplies', 1, 1), (72, 'Other', 1, 2)", clanId);
        const first = await member(101), second = await member(102), outsider = await member(103, 'cold', 72);
        const kit = { stock: () => ({ itemId: plan.selfId, target: 100, survivalTarget: 50 }) };
        await stock(plan.selfId, 90, 20);
        await stock(arrows, 500);
        assert.equal(await Supply.forColdShots(outsider, { plan, kit }), null);

        const drawn = await Promise.all([first, second].map(bot => Supply.forColdShots(bot, { plan, kit })));
        assert.equal(drawn.reduce((sum, result) => sum + (result?.amount || 0), 0), 70);
        assert.equal(await warehouse(plan.selfId), 20);
        assert.equal(await warehouse(arrows), 500);
        const receipt = drawn.find(Boolean);
        assert.equal(receipt.state.inventory[plan.selfId].amount, 70);
        assert.equal(await amount(receipt.characterId, plan.selfId), 70);
        assert.equal(await amount(receipt.characterId, 57), 10000);
        assert.equal(await Supply.forColdShots(first, { plan, kit }), null, 'a repeated snapshot cannot withdraw again');
        await sql(`INSERT INTO clan_simulation_clans (clanId, mode, stateJson, createdAt, updatedAt)
            VALUES (?, 'autonomous', ?, 1, 1)`, clanId, JSON.stringify({ warehouseRevision: receipt.warehouseRevision }));

        const symbol = Henna.availableForClass(classId)[0];
        const leaf = { rootKey: `henna:${symbol.id}`, itemId: symbol.dyeSelfId };
        const dye = symbol.dyeSelfId;
        await stock(dye, symbol.dyeAmount + 2);
        await sql(`INSERT INTO clan_orders(clanId, revision, kind, status, itemId, amount)
            VALUES (?, 1, 'gather_item', 'active', ?, ?)`, clanId, dye, symbol.dyeAmount);
        const bot = Life.cachedState(101);
        assert.equal(invoke('GameServer/Clan/ClanDyeStock').amount(bot, dye), 2);
        assert.equal(await Supply.forDecision(bot, { ...leaf, itemId: arrows }), null);
        const partial = await Supply.forDecision(bot, leaf);
        assert.equal(partial.amount, 2);
        assert.equal(await warehouse(dye), symbol.dyeAmount, 'the active order keeps its required units');
        assert.equal(await Supply.forDecision(partial.state, leaf), null);
        await sql("UPDATE clan_orders SET status = 'completed' WHERE clanId = ?", clanId);
        const market = invoke('GameServer/Bot/Economy/ColdMarketService');
        const collected = await market.tryPurchase(partial.state, {
            type: 'buy_craft_material', target: { itemId: dye, amount: symbol.dyeAmount - 2 },
            plan: { wishKey: leaf.rootKey }
        });
        assert.equal(collected.reason, 'clan_stock_filled');
        assert.equal(await amount(101, dye), symbol.dyeAmount);
        assert.equal(await warehouse(dye), 2);
        assert.equal(await amount(101, 57), 10000);
        const seller = invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffersAll(dye).find(row => row.town === 'Giran');
        assert(seller, 'the dye has a real NPC fallback');
        const dyeCost = (symbol.dyeAmount - 2) * seller.price;
        const buyer = await member(106, 'cold', clanId, 100000 + dyeCost, seller);
        const paid = await market.tryPurchase(buyer, {
            type: 'buy_craft_material', target: { itemId: dye, amount: symbol.dyeAmount - 2, adena: seller.price },
            plan: { wishKey: leaf.rootKey, valueRate: 1, marketTown: seller.town, sourceType: 'npc' }
        });
        assert.equal(paid.units, symbol.dyeAmount - 2, paid.reason);
        assert.equal(await amount(106, dye), symbol.dyeAmount);
        assert.equal(await amount(106, 57), 100000, 'only the dyes bought at the NPC cost Adena');

        const balance = { selfId: plan.selfId, amount: 20, at: Date.now(), purpose: 'shots', town: 'Dion' };
        const errands = require('../src/GameServer/Bot/Population/CombinedErrandPolicy');
        await stock(plan.selfId, 9);
        const ordered = await member(105);
        const visiting = await Life.upsertState(errands.enqueue(ordered, balance), 'clan_supply_errand_fixture');
        const taken = await Supply.forShotOrder(visiting, plan.selfId, balance.amount, balance, balance);
        assert.equal(taken.amount, 9);
        assert.equal(errands.pending(taken.state)[0].amount, 11, 'a saved purchase is reduced in the withdrawal transaction');
        await stock(plan.selfId, 11);
        const fulfilled = await market.tryPurchase(taken.state, { type: 'market_errand' });
        assert.equal(fulfilled.reason, 'clan_stock_filled');
        assert.deepEqual(errands.pending(fulfilled.state), []);
        assert.equal(await amount(105, plan.selfId), 20);
        assert.equal(await amount(105, 57), 10000);

        const hot = await member(104, 'hot');
        const session = { coldLifeState: hot, accountId: hot.accountName, plan: 'shopping', dataSendToMe() {} };
        const Backpack = invoke('GameServer/Actor/Backpack');
        const backpack = new Backpack({ id: 104, paperdoll: Array.from({ length: 16 }, () => ({})),
            items: await Database.fetchItems(104) });
        const actor = session.actor = { session, backpack, fetchId: () => 104, fetchClanId: () => clanId,
            fetchLevel: () => 40, fetchClassId: () => classId, isDead: () => false };
        await stock(plan.selfId, 40);
        const original = { actorState: Economy.stateForActor, offers: AfkTrade.offers, buy: AfkTrade.buyFromShop };
        try {
            Economy.stateForActor = () => ({ ...session.coldLifeState,
                inventory: Life.inventorySummaryFromItems(backpack.fetchItems()) });
            AfkTrade.offers = () => [{ store: 'seller', price: 1, count: 100 }];
            const purchases = [];
            AfkTrade.buyFromShop = async (_id, _store, itemId, quantity) => {
                purchases.push(quantity);
                const item = backpack.fetchItemFromSelfId(itemId);
                item.setAmount(item.fetchAmount() + quantity);
                return {};
            };
            const hotKit = { stock: () => ({ itemId: plan.selfId, target: 100, survivalTarget: 20 }) };
            const result = await Supply.restockActor(actor, { plan, kit: hotKit,
                town: 'Giran', unitPrice: 10, potionUnitPrice: 0, skipNpc: true });
            assert.equal(result.delta, 100, JSON.stringify(result));
            assert.equal(result.cost, 60);
            assert.deepEqual(purchases, [60], 'the paid route gets only the remainder after the clan withdrawal');
            assert.equal(backpack.fetchItemFromSelfId(plan.selfId).fetchAmount(), 100);
            assert.equal(await amount(104, plan.selfId), 40, 'the clan part persists in the hot actor inventory');
            assert.equal(await warehouse(plan.selfId), 20);
            const basket = await invoke('GameServer/Bot/Economy/NpcRestockPlan').purchaseForActor(actor, {
                town: 'fixture_without_sellers', kit: hotKit, potions: false, scrolls: false
            });
            assert.deepEqual(basket.receipts, [], 'the NPC refill avoids buying a stack already filled to target');
        } finally {
            Economy.stateForActor = original.actorState;
            AfkTrade.offers = original.offers;
            AfkTrade.buyFromShop = original.buy;
        }
        assert.equal(await warehouse(arrows), 500);
        const ledger = await sql("SELECT amount FROM clan_warehouse_ledger WHERE operation = 'withdraw'");
        const expected = [2, 2, symbol.dyeAmount - 2, 9, 11, 40, 70].sort((a, b) => a - b);
        assert.deepEqual(ledger.map(row => row.amount).sort((a, b) => a - b), expected);
        const [clan] = await sql('SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', clanId);
        assert.equal(JSON.parse(clan.stateJson).warehouseRevision, ledger.length);
        console.log('PASS clan consumables: hot and cold delivery, partial purchase, order and reservation protection, concurrent members');
        await hotDyePurchase();
        await cooldownDuringWithdrawal();
        await hotDecisionRefill();
        await coldDecisionRefill();
        await clanDyesInPlanning();
    } finally {
        await Database.close();
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
