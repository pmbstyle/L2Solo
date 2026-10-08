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

const scratch = path.join(process.cwd(), 'tmp', 'test-group-f-companion-line');
fs.mkdirSync(scratch, { recursive: true });
const directory = fs.mkdtempSync(path.join(scratch, 'world-'));
const originalTmp = process.env.TMPDIR;
process.env.TMPDIR = directory;
const originals = { world: RuntimeWorld.user, restock: Shopping.scheduleRestock, upgrade: Upgrade.applyBestUpgrades, training: Training.review };
const BUYER = 988100;
const SELLER = 988101;
const SABER = 123;

(async () => {
    const fixture = await createWorld([{ id: BUYER, name: 'Buyer', level: 40 },
        { id: SELLER, name: 'Seller', level: 40 }], 'group-f-companion-line');
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
        const savedPlan = () => {
            session.coldLifeState = { characterId: BUYER, level: 40, stats: { classId: 0,
                equipmentPlan: { strategy: 'market', status: 'active', target: { selfId: SABER, name: 'Saber', slot: 7 } } } };
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
