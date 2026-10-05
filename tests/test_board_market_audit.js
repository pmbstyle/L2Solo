// Focused review regressions on disposable fixtures. These assertions describe
// the board's promised stale-move, retry and restart behavior; the reviewed
// base failed them. No running world or server is used.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const TendencyRoll = invoke('GameServer/Bot/AI/TendencyRoll');
const { BoardIndex, rowOf, recordOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const databasePath = path.join(process.cwd(), 'tmp', 'test-board-market-audit.sqlite');
let sequence = 0;
let rolledBackOwner = null;

function clean() {
    for (const file of [databasePath, databasePath.replace(/\.sqlite$/, '.history.sqlite')]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

async function bot(items) {
    const account = `bot_market_audit_${++sequence}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, {
        name: `MarketAudit${sequence}`, race: 0, classId: 0, maxHp: 100, maxMp: 100,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 83000, locY: 148000, locZ: -3466
    })).insertId);
    for (const item of items) await Database.setItem(id, { equipped: false, enchant: 0, slot: 0, ...item });
    const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(id));
    await LifeState.upsertState({
        characterId: id, accountName: account, name: `MarketAudit${sequence}`, phase: 'cold',
        activity: 'hunting', level: 40, adena: Number(inventory[57]?.amount || 0), inventory,
        loc: { locX: 83000, locY: 148000, locZ: -3466 }, currentRegion: 'Giran',
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { generatedCold: true }, timing: {}
    }, 'market_audit_seed');
    return id;
}

const buyAd = (selfId, price) => ({ storeType: 3, town: 'Giran',
    lines: [{ selfId, name: `Item ${selfId}`, count: 1, price, stackable: true }] });

async function sellAd(id, count = 10) {
    const stock = (await Database.fetchItems(id)).find(item => Number(item.selfId) === 1864);
    return { kind: 'sell_ad', storeType: 1, town: 'Giran',
        lines: [{ objectId: stock.id, selfId: 1864, name: 'Stem', count, price: 100, stackable: true }] };
}

async function bag(id, selfId) {
    return (await Database.fetchItems(id)).filter(item => Number(item.selfId) === selfId)
        .reduce((sum, item) => sum + Number(item.amount), 0);
}

const failures = [];
async function check(name, work) {
    try { await work(); console.log(`${name}: pass`); }
    catch (error) { failures.push(name); console.error(`${name}: FAIL ${error.message}`); }
}

async function run() {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    invoke('GameServer/World/World').user = { sessions: [], revision: 0 };
    await LifeState.init();

    await check('stale replacement must check record identities', async () => {
        const owner = await bot([{ selfId: 57, name: 'Adena', amount: 10000 }]);
        const first = await Database.replaceBoardRecords(owner, 'buy_ad', [buyAd(1864, 100)], { expected: {} });
        const original = first.opened[0];
        const expected = { [original.id]: original.revision };
        const moved = await Database.replaceBoardRecords(owner, 'buy_ad', [buyAd(1872, 300)], { expected });
        const before = moved.opened[0];
        let rejected = false;
        try { await Database.replaceBoardRecords(owner, 'buy_ad', [buyAd(1865, 200)], { expected }); }
        catch (error) { assert.match(error.message, /afk_trade_shop_changed/); rejected = true; }
        const after = (await Database.fetchAfkTradeShops(owner))[0];
        console.log(JSON.stringify({ case: 'stale replacement', rejected, beforeItem: before.lines[0].selfId,
            afterItem: after.lines[0].selfId, beforeEscrow: before.escrowAdena, afterEscrow: after.escrowAdena }));
        assert.strictEqual(await bag(owner, 57) + after.escrowAdena, 10000, 'replacement preserves money');
        for (const incomplete of [{}, { [after.id]: null }, { [after.id]: after.revision, 999999: 1 }]) {
            await assert.rejects(Database.replaceBoardRecords(owner, 'buy_ad', [buyAd(1865, 200)],
                { expected: incomplete }), /afk_trade_shop_changed/);
            assert.strictEqual((await Database.fetchAfkTradeShops(owner))[0].id, after.id);
            assert.strictEqual(await bag(owner, 57) + after.escrowAdena, 10000);
        }
        assert.strictEqual((await Database.closeBoardRecord(owner, after.id)).closed, true);
        assert.strictEqual((await Database.closeBoardRecord(owner, after.id)).closed, false);
        assert.strictEqual(await bag(owner, 57), 10000, 'repeated close refunds escrow exactly once');
        assert(rejected, 'a stale snapshot replaced a different record with the same record count');
        assert.strictEqual(after.id, before.id);
    });

    await check('settlement rollback must remain discoverable for retry', async () => {
        const owner = await bot([{ selfId: 1864, name: 'Stem', amount: 10 }]);
        rolledBackOwner = owner;
        const buyer = await bot([{ selfId: 57, name: 'Adena', amount: 1000 }]);
        const sale = await Database.createAfkTradeShop(owner, await sellAd(owner));
        await Database.buyFromAfkTradeShop(buyer, { shopId: sale.shop.id, ownerId: owner,
            lineId: sale.shop.lines[0].id, amount: 3, expectedPrice: 100, expectedRevision: 1 });
        await Database.execute([`CREATE TEMP TRIGGER audit_settlement_failure
            BEFORE UPDATE OF inventorySummary ON main.bot_life_state WHEN NEW.characterId = ${owner}
            BEGIN SELECT RAISE(ABORT, 'injected settlement snapshot failure'); END`]);
        try { await assert.rejects(Database.settleBoardOwner(owner), /injected settlement snapshot failure/); }
        finally { await Database.execute(['DROP TRIGGER temp.audit_settlement_failure']); }
        const [pending] = await Database.execute(['SELECT SUM(amount) AS amount FROM board_settlements WHERE ownerId = ?', [owner]]);
        assert.strictEqual(pending.amount, 300);
        assert(Database.boardSettlementOwners().includes(owner), 'rollback restores discovery before the retry');
        assert.strictEqual(await bag(owner, 57), 0);
        const retry = await Database.settleBoardOwner(owner);
        console.log(JSON.stringify({ case: 'settlement rollback', owner, durablePending: pending.amount,
            discovered: Database.boardSettlementOwners().includes(owner), retrySettled: retry.settled,
            ownerAdena: await bag(owner, 57) }));
        assert.strictEqual(retry.settled, true, 'rolled-back settlement became invisible to retry');
        assert.strictEqual(await bag(owner, 57), 300);
        assert.strictEqual((await Database.settleBoardOwner(owner)).settled, false, 'successful settlement applies once');
    });

    await check('failed trade must roll back newly discovered settlement and deal count', async () => {
        const owner = await bot([{ selfId: 1864, name: 'Stem', amount: 10 }]);
        const buyer = await bot([{ selfId: 57, name: 'Adena', amount: 1000 }]);
        const sale = (await Database.createAfkTradeShop(owner, await sellAd(owner))).shop;
        const before = (await Database.fetchRecentBoardDeals()).dealCounts;
        await Database.execute([`CREATE TEMP TRIGGER audit_trade_failure
            BEFORE UPDATE OF count ON main.afk_trade_lines WHEN NEW.id = ${sale.lines[0].id}
            BEGIN SELECT RAISE(ABORT, 'injected trade failure'); END`]);
        try { await assert.rejects(Database.buyFromAfkTradeShop(buyer, { shopId: sale.id, ownerId: owner,
            lineId: sale.lines[0].id, amount: 3 }), /injected trade failure/); }
        finally { await Database.execute(['DROP TRIGGER temp.audit_trade_failure']); }
        assert(!Database.boardSettlementOwners().includes(owner));
        assert.strictEqual((await Database.execute(['SELECT COUNT(*) AS n FROM board_settlements WHERE ownerId = ?', [owner]]))[0].n, 0);
        assert.strictEqual(await bag(buyer, 57), 1000);
        assert.strictEqual((await Database.fetchAfkTradeShops(owner))[0].lines[0].count, 10);
        assert.deepStrictEqual((await Database.fetchRecentBoardDeals()).dealCounts, before);
    });

    await check('cold batch rollback must retry both settlements exactly once', async () => {
        const owners = [];
        const buyer = await bot([{ selfId: 57, name: 'Adena', amount: 2000 }]);
        for (let index = 0; index < 2; index++) {
            const id = await bot([{ selfId: 1864, name: 'Stem', amount: 10 }]);
            const sale = (await Database.createAfkTradeShop(id, await sellAd(id))).shop;
            await Database.buyFromAfkTradeShop(buyer, { shopId: sale.id, ownerId: id, lineId: sale.lines[0].id, amount: 3 });
            const token = await Owner.claim(LifeState.cachedState(id), { timestamp: Date.now(), leaseMs: 30000 });
            assert(token.ok);
            const state = LifeState.cachedState(id);
            owners.push({ id, token, state, request: { token, nextState: structuredClone(state),
                proposal: { baseState: { inventory: state.inventory } } } });
        }
        await Database.execute([`CREATE TEMP TRIGGER audit_batch_failure
            BEFORE UPDATE OF inventorySummary ON main.bot_life_state WHEN NEW.characterId = ${owners[1].id}
            BEGIN SELECT RAISE(ABORT, 'injected later batch failure'); END`]);
        try { await assert.rejects(Owner.commitAndReleaseBatch(owners.map(owner => owner.request),
            { timestamp: Date.now() }), /injected later batch failure/); }
        finally { await Database.execute(['DROP TRIGGER temp.audit_batch_failure']); }
        for (const { id, token } of owners) {
            assert(Database.boardSettlementOwners().includes(id));
            assert.strictEqual(await bag(id, 57), 0);
            const row = (await Database.execute(['SELECT simulationRevision, simulationLeaseId FROM bot_life_state WHERE characterId = ?', [id]]))[0];
            assert.strictEqual(row.simulationRevision, token.revision);
            assert.strictEqual(row.simulationLeaseId, token.leaseId);
        }
        const results = await Owner.commitAndReleaseBatch(owners.map(owner => owner.request), { timestamp: Date.now() });
        assert(results.every(result => result.ok && result.settled));
        const repeated = await Owner.commitAndReleaseBatch(owners.map(owner => owner.request), { timestamp: Date.now() });
        assert(repeated.every(result => !result.ok));
        for (const { id } of owners) {
            assert.strictEqual(await bag(id, 57), 300);
            assert(!Database.boardSettlementOwners().includes(id));
            assert.strictEqual((await Database.settleBoardOwner(id)).settled, false);
        }
    });

    await check('COMMIT failure must restore settlement discovery', async () => {
        const owner = await bot([{ selfId: 1864, name: 'Stem', amount: 10 }]);
        const buyer = await bot([{ selfId: 57, name: 'Adena', amount: 1000 }]);
        const sale = (await Database.createAfkTradeShop(owner, await sellAd(owner))).shop;
        await Database.buyFromAfkTradeShop(buyer, { shopId: sale.id, ownerId: owner, lineId: sale.lines[0].id, amount: 3 });
        await Database.execute(['CREATE TABLE audit_deferred (ownerId INTEGER REFERENCES characters(id) DEFERRABLE INITIALLY DEFERRED)']);
        await Database.execute([`CREATE TEMP TRIGGER audit_commit_failure
            AFTER UPDATE OF inventorySummary ON main.bot_life_state WHEN NEW.characterId = ${owner}
            BEGIN INSERT INTO audit_deferred VALUES (99999999); END`]);
        try { await assert.rejects(Database.settleBoardOwner(owner), /FOREIGN KEY constraint failed/); }
        finally {
            await Database.execute(['DROP TRIGGER temp.audit_commit_failure']);
            await Database.execute(['DROP TABLE audit_deferred']);
        }
        assert(Database.boardSettlementOwners().includes(owner));
        assert.strictEqual(await bag(owner, 57), 0);
        assert.strictEqual((await Database.settleBoardOwner(owner)).settled, true);
        assert.strictEqual(await bag(owner, 57), 300);
        assert.strictEqual((await Database.settleBoardOwner(owner)).settled, false);
    });

    await check('partial fill must fence a stale price look', async () => {
        const owner = await bot([{ selfId: 1864, name: 'Stem', amount: 10 }]);
        const buyer = await bot([{ selfId: 57, name: 'Adena', amount: 1000 }]);
        const sale = await AfkTrade.publishBot(owner, await sellAd(owner));
        const line = sale.lines[0];
        const review = { reprices: [{ recordId: sale.id, lineId: line.id, selfId: line.selfId,
            price: 80, expectedRevision: sale.revision }],
        withdrawals: [{ recordId: sale.id, lineId: line.id, expectedRevision: sale.revision }] };
        await AfkTrade.buyFromShop(buyer, AfkTrade.recordStore(sale.id), 1864, 3);
        const result = await BotMarket.applyReview(owner, review);
        const after = (await Database.fetchAfkTradeShops(owner))[0];
        console.log(JSON.stringify({ case: 'partial stale look', changed: result.changed,
            revision: after.revision, remaining: after.lines[0].count, price: after.lines[0].price }));
        assert.strictEqual(result.changed, 0, 'a stale look changed the price after a partial fill');
        assert.strictEqual(after.lines[0].price, 100);
    });

    await check('price-only change fences stale moves while valid records proceed', async () => {
        const owner = await bot([{ selfId: 1864, name: 'Stem', amount: 20 }, { selfId: 1865, name: 'Varnish', amount: 20 }]);
        const first = await AfkTrade.publishBot(owner, await sellAd(owner));
        const stock = (await Database.fetchItems(owner)).find(item => Number(item.selfId) === 1865);
        const second = await AfkTrade.publishBot(owner, { kind: 'sell_ad', storeType: 1, town: 'Giran',
            lines: [{ objectId: stock.id, selfId: 1865, name: 'Varnish', count: 10, price: 100, stackable: true }] });
        const move = (record, price) => ({ recordId: record.id, lineId: record.lines[0].id,
            expectedRevision: record.revision, price });
        const old = move(first, 80);
        await AfkTrade.repriceBot(owner, first.lines[0].id, 110, first.revision);
        const result = await BotMarket.applyReview(owner, { reprices: [old, move(second, 90)], withdrawals: [old] });
        assert.strictEqual(result.changed, 1);
        const records = await Database.fetchAfkTradeShops(owner);
        assert.strictEqual(records.find(record => record.id === first.id).lines[0].price, 110);
        assert.strictEqual(records.find(record => record.id === second.id).lines[0].price, 90);
        assert.strictEqual(records.find(record => record.id === first.id).lines[0].id, old.lineId);
        const fresh = records.find(record => record.id === second.id);
        assert.strictEqual((await BotMarket.applyReview(owner, { withdrawals: [old, move(fresh)] })).changed, 1);
        assert.strictEqual((await Database.fetchAfkTradeShops(owner)).length, 1);
        assert.strictEqual(await bag(owner, 1865), 20, 'valid withdrawal returns its stock once');
        assert.strictEqual((await BotMarket.applyReview(owner, { withdrawals: [move(fresh)] })).changed, 0);
    });

    await check('one snapshot can reprice and withdraw several shop lines', async () => {
        const owner = await bot([1864, 1865, 1872].map(selfId => ({ selfId, name: `Item ${selfId}`, amount: 20 })));
        const stock = await Database.fetchItems(owner);
        const shop = await AfkTrade.publishBot(owner, { storeType: 1, town: 'Giran',
            lines: stock.map(item => ({ objectId: item.id, selfId: item.selfId, name: item.name, count: 10, price: 100, stackable: true })) });
        const row = rowOf(AfkTrade.recordStore(shop.id));
        assert.strictEqual(recordOf(row).revision, shop.revision);
        assert.strictEqual(recordOf(row.slice(0, 7)).revision, null, 'old board rows remain readable');
        const moves = AfkTrade.boardIndex().ownerLines(owner).map(line => ({ recordId: line.recordId,
            lineId: line.lineId, expectedRevision: line.revision, price: 90 }));
        assert(moves.every(move => move.expectedRevision === shop.revision));
        const result = await BotMarket.applyReview(owner, { reprices: moves.slice(0, 2), withdrawals: moves.slice(2) });
        assert.strictEqual(result.changed, 3);
        const after = (await Database.fetchAfkTradeShops(owner))[0];
        assert.strictEqual(after.id, shop.id);
        assert.deepStrictEqual(after.lines.map(line => [line.id, line.count, line.price]),
            shop.lines.slice(0, 2).map(line => [line.id, 10, 90]));
        assert.strictEqual(await bag(owner, shop.lines[2].selfId), 20);
        assert.strictEqual((await BotMarket.applyReview(owner, { reprices: moves.slice(0, 2), withdrawals: moves.slice(2) })).changed, 0);
        assert.strictEqual((await BotMarket.applyReview(owner, { reprices: [{ lineId: after.lines[0].id, price: 80 }] })).changed, 0,
            'a proposal from an old worker without a fence waits for a fresh look');
    });

    await check('worker pricing produces fenced reprices and withdrawals', async () => {
        const owner = await bot([1864, 1865].map(selfId => ({ selfId, name: `Item ${selfId}`, amount: 20 })));
        const stock = await Database.fetchItems(owner);
        const shop = await AfkTrade.publishBot(owner, { storeType: 1, town: 'Giran',
            lines: stock.map(item => ({ objectId: item.id, selfId: item.selfId, name: item.name, count: 10, price: 100, stackable: true })) });
        const choose = PriceDecision.chooseAsk;
        const roll = TendencyRoll.roll;
        let proposal;
        try {
            PriceDecision.chooseAsk = belief => belief.selfId === 1864 ? { price: 90 } : { npc: true };
            TendencyRoll.roll = () => 0;
            proposal = MarketPricing.look({ stats: {}, activity: 'resting' }, AfkTrade.boardIndex().ownerLines(owner), {
                characterId: owner, timestamp: Date.now(), understanding: 0.5, hour: 1000, adena: 1000,
                trader: {}, board: AfkTrade.boardIndex(), npcOffersFor: () => []
            });
        } finally { PriceDecision.chooseAsk = choose; TendencyRoll.roll = roll; }
        assert(proposal);
        assert.strictEqual(proposal.reprices.length, 1);
        assert.strictEqual(proposal.withdrawals.length, 1);
        assert([...proposal.reprices, ...proposal.withdrawals].every(move => move.recordId === shop.id
            && move.expectedRevision === shop.revision));
        assert.strictEqual((await BotMarket.applyReview(owner, proposal)).changed, 2);
        const after = (await Database.fetchAfkTradeShops(owner))[0];
        assert.deepStrictEqual(after.lines.map(line => [line.selfId, line.price, line.count]), [[1864, 90, 10]]);
        assert.strictEqual(await bag(owner, 1865), 20);
    });

    await check('restart replay must retain unseen own sale evidence', async () => {
        const owner = 555001;
        const timestamp = Date.now() - 48 * 3600000;
        MarketCounters.reset();
        const rows = Array.from({ length: 100 }, (_, index) => ({
            selfId: 1864, unitPrice: 100, quantity: 1, occurredAt: timestamp - (100 - index) * 60000,
            sellerCharacterId: 999, buyerCharacterId: 998, town: 'Giran'
        }));
        MarketCounters.load(rows);
        const ctx = { characterId: owner, understanding: 0.5, timestamp,
            board: new BoardIndex({ groupOf: MarketCounters.counterOf }) };
        const book = PriceBelief.readBook({});
        const belief = PriceBelief.ensure(book, 1864, ctx);
        belief.ask = 100;
        const saved = PriceBelief.writeBook(book);
        rows.push({ ...rows[0], sellerCharacterId: owner, occurredAt: timestamp + 1000 });
        MarketCounters.deal(1864, 100, 1, timestamp + 1000, owner, 'Giran', 998);
        const liveBook = PriceBelief.readBook({ priceBeliefs: saved });
        const live = PriceBelief.lookObservations(liveBook, liveBook.beliefs.get(1864), ctx, { ask: 100, lines: 1 });
        assert.strictEqual(live.sales, 1, 'the running process sees the own sale');
        for (const [index, row] of rows.entries()) {
            await Database.recordMarketTrade({ ...row, eventKey: `audit-replay:${index}`, channel: 'bot_wts',
                sourceType: 'afk_bot_store' });
        }
        await Database.recordMarketTrade({ eventKey: 'audit-replay:recent', channel: 'bot_wts',
            sourceType: 'afk_bot_store', selfId: 1865, unitPrice: 100, quantity: 1, occurredAt: Date.now(), town: 'Giran' });
        const replay = (await Database.fetchRecentBoardDeals({ perItem: MarketCounters.REPLAY_DEALS }))
            .filter(row => Number(row.selfId) === 1864);
        assert.strictEqual(replay.length, MarketCounters.REPLAY_DEALS, 'the real DB query truncates this older item');
        MarketCounters.reset();
        MarketCounters.load(replay);
        const restored = PriceBelief.readBook({ priceBeliefs: saved });
        const after = PriceBelief.lookObservations(restored, restored.beliefs.get(1864), ctx, { ask: 100, lines: 1 });
        console.log(JSON.stringify({ case: 'restart evidence', storedSeenItem: saved.b[0][10],
            replayDeals: MarketCounters.itemDeals(1864).deals, liveSales: live.sales, restoredSales: after.sales }));
        assert.strictEqual(after.sales, live.sales, 'bounded replay reset the cursor of a persisted belief');
    });

    // The successful retry remains paid after reopening; no duplicate money.
    await Database.close();
    Database.init();
    assert(!Database.boardSettlementOwners().includes(rolledBackOwner));
    assert.strictEqual((await Database.settleBoardOwner(rolledBackOwner)).settled, false);
    assert.strictEqual(await bag(rolledBackOwner, 57), 300);
    assert.strictEqual((await Database.settleBoardOwner(rolledBackOwner)).settled, false);
    console.log('settlement after DB reopen: 300 Adena remains paid exactly once');

    if (failures.length) throw new Error(`${failures.length} market audit regressions: ${failures.join('; ')}`);
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    AfkTrade._resetForTests();
    BotMarket._resetForTests();
    MarketCounters.reset();
    await Database.close();
    clean();
});
