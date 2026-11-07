const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../src/Global');
const { createWorld } = require('./helpers/c4QuestHarness');
const Database = invoke('Database');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const RuntimeWorld = invoke('GameServer/World/World');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Equipment = invoke('GameServer/Bot/AI/CompanionEquipmentShopping');
const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
const Upgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const Training = invoke('GameServer/Bot/BotSkillTraining');
const Supply = invoke('GameServer/Bot/AI/BotSupplyErrand');

const scratch = path.join(process.cwd(), 'tmp', 'test-group-f-companion-line');
fs.mkdirSync(scratch, { recursive: true });
const directory = fs.mkdtempSync(path.join(scratch, 'world-'));
const originalTmp = process.env.TMPDIR;
process.env.TMPDIR = directory;
const originals = { world: RuntimeWorld.user, restock: Shopping.scheduleRestock, upgrade: Upgrade.applyBestUpgrades, training: Training.review };
const BUYER = 988100;
const SELLER = 988101;
const RESELLER = 988102;
const SABER = 123;

(async () => {
    const fixture = await createWorld([{ id: BUYER, name: 'Buyer', level: 40 },
        { id: SELLER, name: 'Seller', level: 40 }, { id: RESELLER, name: 'Reseller', level: 40 }], 'group-f-companion-line');
    try {
        await Database.setItem(BUYER, { selfId: 57, name: 'Adena', amount: 100000,
            enchant: 0, equipped: false, slot: 0 });
        const session = await fixture.session(BUYER);
        const bot = session.actor;
        Object.assign(session, { botSession: true, accountId: 'bot_group_f_companion', plan: 'shopping', partyCompanion: true });
        Object.assign(bot, { session, fetchLocX: () => 83000, fetchLocY: () => 148000, fetchLocZ: () => -3400 });
        RuntimeWorld.user = { sessions: [session] };
        Shopping.scheduleRestock = () => {};
        // Certify arrival and real escrow settlement; equipping/restocking is
        // covered elsewhere and requires a full world actor beyond this harness.
        Upgrade.applyBestUpgrades = () => [];
        // The quest harness is a bag/packet actor, not a full skill actor.
        // Skill training is certified separately; keep this exact-line native
        // purchase fixture confined to arrival, money and escrow settlement.
        Training.review = async () => null;
        // A bot's board purchase is admitted through its saved economy owner
        // (71143511, EconomyCommit): a bot account, a saved hot life state and
        // the worker's money packet that funds the Saber (FX-E3 rows).
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        await LifeState.init();
        await Database.createAccount('bot_group_f_companion', 'pw');
        await Database.execute(['UPDATE characters SET username = ? WHERE id = ?', ['bot_group_f_companion', BUYER]]);
        const plan = { strategy: 'market', status: 'active', target: { selfId: SABER, name: 'Saber', slot: 7 } };
        const hot = await LifeState.upsertState({ characterId: BUYER, accountName: 'bot_group_f_companion', name: 'Buyer',
            level: 40, phase: 'hot', activity: 'shopping', currentRegion: 'Giran', adena: 100000,
            loc: { locX: 83000, locY: 148000, locZ: -3400 }, inventory: { 57: { selfId: 57, amount: 100000 } },
            vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { classId: 0, equipmentPlan: plan, money: [100000, .0001, 0, 0, .001, 10, SABER] },
            timing: { lastHotAt: 1 } }, 'group_f_companion_fixture');
        const savedPlan = () => {
            session.coldLifeState = { ...(LifeState.cachedState(BUYER) || hot), stats: { ...(LifeState.cachedState(BUYER) || hot).stats,
                classId: 0, equipmentPlan: plan } };
        };
        const open = async () => {
            const first = Number((await Database.setItem(SELLER, { selfId: SABER, name: 'Saber +3',
                amount: 1, enchant: 3, equipped: false, slot: 0 })).insertId);
            const second = Number((await Database.setItem(SELLER, { selfId: SABER, name: 'Saber',
                amount: 1, enchant: 0, equipped: false, slot: 0 })).insertId);
            const result = await Database.createAfkTradeShop(SELLER, { kind: 'shop', storeType: 1, town: 'Giran',
                locX: 83000, locY: 148000, locZ: -3400, lines: [
                    { objectId: first, selfId: SABER, name: 'Saber +3', count: 1, price: 50, enchant: 3, stackable: false },
                    { objectId: second, selfId: SABER, name: 'Saber', count: 1, price: 10, enchant: 0, stackable: false }
                ] });
            AfkTrade.refreshRecord(result.shop);
            return result.shop;
        };
        const store = await open();
        savedPlan();
        const selected = Market.bestOffer(SABER, { town: 'Giran', buyerCharacterId: BUYER });
        const errand = Equipment.planErrand(session, bot, { name: 'Giran' });
        assert.equal(selected.lineId, store.lines[1].id, 'the cheap second line is selected');
        assert.equal(errand.price, 10);
        session.companionShopping = errand;
        await Shopping.sellAndRestock(session, bot, null, { say() {} });
        assert.equal(await fixture.amount(BUYER, SABER), 1, 'arrival executes the selected second line');
        assert.equal(await fixture.amount(BUYER, 57), 99990);
        assert.equal(await fixture.amount(SELLER, 57), 10);
        assert.equal(errand.lineId, store.lines[1].id, 'the errand retains exact board identity');
        const [remaining] = await Database.execute(['SELECT count FROM afk_trade_lines WHERE id = ?', [store.lines[0].id]]);
        assert.equal(remaining.count, 1, 'the first, enchanted copy remains escrowed');
        assert.match(session.lastTradeSummary, /bought 1x Saber from/);
        assert(!session.lastTradeSummary.includes('Saber +3'), 'summary names the executed copy');
        const bought = (await Database.fetchItems(BUYER)).find(item => item.selfId === SABER);
        assert.equal(bought.enchant, 0);
        console.log('PASS companion exact board line: second Saber, 10a, first enchanted copy retained');

        // Replay the exact completed line against a record that still has a
        // different copy of this item. Match its price deliberately: identity,
        // rather than a lucky price mismatch, must prevent substitution.
        const repriced = await Database.repriceAfkTradeShop(SELLER, store.lines[0].id, 10);
        AfkTrade.refreshRecord(repriced.shop);
        const beforeMoney = await fixture.amount(BUYER, 57);
        const beforeUnits = await fixture.amount(BUYER, SABER);
        session.companionShopping = { ...errand };
        await Shopping.sellAndRestock(session, bot, null, { say() {} });
        assert.equal(await fixture.amount(BUYER, 57), beforeMoney, 'stale exact line cannot pay for another copy');
        assert.equal(await fixture.amount(BUYER, SABER), beforeUnits, 'stale exact line cannot receive another copy');
        assert.match(session.lastTradeSummary, /could not buy/);
        const [untouched] = await Database.execute(['SELECT count FROM afk_trade_lines WHERE id = ?', [store.lines[0].id]]);
        assert.equal(untouched.count, 1);
        console.log('PASS stale exact board line refuses equal-price enchanted substitute');

        // A companion buys on the player's visit, not from its own money queue:
        // a packet with no row for the item (a rich bot's usual packet, the
        // live shape) still pays for the upgrade from the wallet above the reserve.
        const LONG_SWORD = 2, LEATHER_SHIRT = 27, LEATHER_HELMET = 44, COMPOSITION_BOW = 273, RESERVE = 500, unfunded = [100000, .0001, RESERVE, 0];
        const withoutRow = async (selfId, name, market = {}) => {
            const current = LifeState.cachedState(BUYER);
            session.coldLifeState = await LifeState.upsertState({ ...current, stats: { ...current.stats, money: unfunded,
                equipmentPlan: { strategy: 'market', status: 'active', market, target: { selfId, name, slot: 7 } } } },
            'group_f_companion_unfunded');
            session.heldEconomy = undefined;
        };
        const stock = Number((await Database.setItem(RESELLER, { selfId: LONG_SWORD, name: 'Long Sword',
            amount: 1, enchant: 0, equipped: false, slot: 0 })).insertId);
        AfkTrade.refreshRecord((await Database.createAfkTradeShop(RESELLER, { kind: 'shop', storeType: 1, town: 'Giran',
            locX: 83000, locY: 148000, locZ: -3400, lines: [{ objectId: stock, selfId: LONG_SWORD, name: 'Long Sword',
                count: 1, price: 300, enchant: 0, stackable: false }] })).shop);
        await withoutRow(LONG_SWORD, 'Long Sword');
        const boardErrand = Equipment.planErrand(session, bot, { name: 'Giran' });
        assert.equal(boardErrand?.kind, 'market_purchase');
        const boardMoney = await fixture.amount(BUYER, 57);
        session.companionShopping = boardErrand;
        await Shopping.sellAndRestock(session, bot, null, { say() {} });
        assert.equal(await fixture.amount(BUYER, LONG_SWORD), 1, session.lastTradeSummary);
        assert.equal(await fixture.amount(BUYER, 57), boardMoney - 300);
        console.log('PASS companion buys a board upgrade its money queue does not fund');

        // The basket saves the hot body's vitals with the town it stands in.
        Object.assign(bot, { fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100 });
        const shop = Market.npcOffers(LEATHER_SHIRT, 'Giran')[0];
        assert(shop, 'the C4 Giran armour shop sells the shirt');
        await withoutRow(LEATHER_SHIRT, 'Hard Leather Shirt', { sourceType: 'npc' });
        const shopErrand = Equipment.planErrand(session, bot, { name: 'Giran' });
        assert.equal(shopErrand?.kind, 'npc_equipment_purchase');
        const shopMoney = await fixture.amount(BUYER, 57);
        session.companionShopping = shopErrand;
        await Shopping.sellAndRestock(session, bot, null, { say() {} });
        assert.equal(await fixture.amount(BUYER, LEATHER_SHIRT), 1, session.lastTradeSummary);
        assert.equal(await fixture.amount(BUYER, 57), shopMoney - shop.price);
        console.log('PASS companion buys an NPC upgrade its money queue does not fund');

        // The player's own order at a board shop: the same terms, the same writer.
        const ordered = Number((await Database.setItem(RESELLER, { selfId: LEATHER_HELMET, name: 'Leather Helmet',
            amount: 1, enchant: 0, equipped: false, slot: 0 })).insertId);
        const record = (await Database.createAfkTradeShop(RESELLER, { kind: 'shop', storeType: 1, town: 'Giran',
            locX: 83000, locY: 148000, locZ: -3400, lines: [{ objectId: ordered, selfId: LEATHER_HELMET, name: 'Leather Helmet',
                count: 1, price: 200, enchant: 0, stackable: false }] })).shop;
        AfkTrade.refreshRecord(record);
        await withoutRow(LEATHER_SHIRT, 'Hard Leather Shirt');
        const order = await Supply.purchaseAtDestination(bot, { sourceType: 'afk_player_store', itemId: LEATHER_HELMET, amount: 1,
            unitPrice: 200, totalCost: 200, recordId: record.id, lineId: record.lines[0].id, target: { town: 'Giran' } });
        assert.equal(await fixture.amount(BUYER, LEATHER_HELMET), 1, String(order.reason));
        console.log('PASS companion buys a board item the player ordered');

        const bow = Market.npcOffers(COMPOSITION_BOW, 'Giran')[0];
        const wallet = amount => bot.backpack.fetchItemFromSelfId(57).setAmount(amount);
        await withoutRow(COMPOSITION_BOW, 'Composition Bow', { sourceType: 'npc' });
        wallet(bow.price + RESERVE);
        assert.equal(Equipment.planErrand(session, bot, { name: 'Giran' })?.itemId, COMPOSITION_BOW);
        await withoutRow(COMPOSITION_BOW, 'Composition Bow', { sourceType: 'npc' });
        wallet(bow.price + RESERVE - 1);
        assert.notEqual(Equipment.planErrand(session, bot, { name: 'Giran' })?.itemId, COMPOSITION_BOW,
            'the reserve stays with the companion');
        console.log('PASS companion keeps its reserve');
    } finally {
        Shopping.scheduleRestock = originals.restock;
        Upgrade.applyBestUpgrades = originals.upgrade;
        Training.review = originals.training;
        RuntimeWorld.user = originals.world;
        AfkTrade._resetForTests();
        await fixture.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    fs.rmSync(directory, { recursive: true, force: true });
});
