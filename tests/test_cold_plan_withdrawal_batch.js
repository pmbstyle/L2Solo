'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('cold-withdrawal-batch');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
isolated.assertConfigured(options.default);
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const owner = 730064, other = 730065, ids = [1864, 1865, 1867];
const nativeReprice = Database.repriceBoardLines;
let writes = 0, admission = () => {};
Database.repriceBoardLines = async function (...args) {
    writes++; await admission(...args); return nativeReprice.apply(this, args);
};
async function stateFor(id) {
    return Life.refreshInventory(Life.cachedState(id));
}
async function open(id, selected = ids, kind = 'shop') {
    const stock = await Database.fetchItems(id);
    const config = { storeType: Afk.SELL, town: 'Giran', lines: selected.map(selfId => {
        const row = stock.find(item => Number(item.selfId) === selfId);
        return { objectId: row.id, selfId, name: row.name, count: 10, price: 100, stackable: true };
    }) };
    if (kind === 'shop') await Afk.publishBot(id, config);
    else {
        const result = await Database.openBoardRecords(id, kind, [config]);
        result.opened.forEach(Afk.refreshRecord);
    }
    return Afk.boardIndex().ownerLines(id);
}
async function run(withdraw, options = {}) {
    const state = await stateFor(owner);
    writes = 0;
    return Market.executePlan(state, { withdraw }, { step: work => work(), ...options });
}
async function totals(id) {
    const bag = await Database.fetchItems(id), records = await Database.fetchAfkTradeShops(id);
    return ids.map(selfId => Number(bag.find(row => Number(row.selfId) === selfId)?.amount || 0)
        + records.filter(row => row.custodyPolicy !== 1 && row.storeType === Afk.SELL)
            .flatMap(row => row.lines).filter(row => row.selfId === selfId)
            .reduce((sum, row) => sum + Number(row.count), 0));
}
(async () => {
    const world = await createWorld([owner, other].map(id => ({ id, classId: 0, level: 30 })), 'plan-withdrawal-batch');
    try {
        await Life.init();
        for (const id of [owner, other]) {
            const accountName = `bot_withdraw_${id}`;
            await Database.createAccount(accountName, 'fixture');
            await Database.execute(['UPDATE characters SET username=? WHERE id=?', [accountName, id]]);
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
            for (const selfId of ids) await Database.setItem(id, { selfId, name: `Item ${selfId}`, amount: 20, slot: 0 });
            await Life.upsertState({ characterId: id, accountName, level: 30, phase: 'cold', activity: 'hunting',
                loc: { locX: 83396, locY: 147904, locZ: -3400 }, currentRegion: 'Giran',
                stats: { classId: 0 }, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                adena: 100000, timing: {}, vitals: {} }, 'withdrawal_fixture');
        }
        const foreign = (await open(other, [1864]))[0];
        let lines = await open(owner);
        const plan = [lines[0].lineId, lines[1].lineId, lines[1].lineId, foreign.lineId, lines[2].lineId];
        await run(plan);
        assert.equal(writes, 1, 'several same-record lines use one native write, including a duplicate and a foreign ID');
        assert.equal(Afk.boardIndex().ownerLines(owner).length, 0);
        assert.deepEqual(await totals(owner), [20, 20, 20]);
        assert.equal(Afk.boardIndex().ownerLines(other)[0].lineId, foreign.lineId, 'another owner is untouched');
        await run(plan);
        assert.equal(writes, 0, 'already completed withdrawals are idempotent and do not reach SQL');
        assert.deepEqual(await totals(owner), [20, 20, 20]);

        // The actual postcommit order first applies a board review, then the
        // action plan prepared from the same mirror. Reproduce that collision.
        lines = await open(owner);
        const line = lines[0];
        assert.equal((await Market.applyReview(owner, { withdrawals: [{ lineId: line.lineId,
            recordId: line.recordId, expectedRevision: line.revision, previousPricing: line.pricing }] })).changed, 1);
        await run(lines.map(row => row.lineId));
        assert.equal(writes, 1, 'the remaining intent is one batch after the board review');
        assert.equal(Afk.boardIndex().ownerLines(owner).length, 0);
        assert.deepEqual(await totals(owner), [20, 20, 20], 'board review plus plan returns every unit once');

        await open(owner, [1864], 'sell_ad');
        await open(owner, [1865], 'sell_ad');
        lines = Afk.boardIndex().ownerLines(owner);
        const stale = lines.find(row => row.selfId === 1864), valid = lines.find(row => row.selfId === 1865);
        admission = () => Database.execute(['UPDATE afk_trade_shops SET revision=revision+1 WHERE id=?', [stale.recordId]]);
        await assert.rejects(run(lines.map(row => row.lineId)), /economy_plan_line_changed/);
        assert.equal(writes, 1, 'a stale record and a valid record share one guarded native transaction');
        assert.equal(Afk.boardIndex().ownerLines(owner).some(row => row.lineId === valid.lineId), false);
        assert.equal(Afk.boardIndex().ownerLines(owner).some(row => row.lineId === stale.lineId), true);
        assert.deepEqual(await totals(owner), [20, 20, 20], 'rejected stock stays in custody while valid stock returns');
        admission = () => {};
        const refreshed = (await Database.fetchAfkTradeShops(owner))[0]; Afk.refreshRecord(refreshed);
        const held = Afk.boardIndex().ownerLines(owner)[0];
        admission = async () => {
            const update = await nativeReprice.call(Database, owner, [], { updates: [{ lineId: held.lineId,
                recordId: held.recordId, expectedRevision: held.revision, previousPricing: held.pricing,
                pricing: { ...held.pricing, seenCounter: held.pricing.seenCounter + 1 } }] });
            update.shops.forEach(Afk.refreshRecord);
        };
        await assert.rejects(run([held.lineId]), /economy_plan_line_changed/);
        assert.equal(writes, 1);
        assert.equal(Afk.boardIndex().ownerLines(owner)[0].revision, held.revision, 'price observations need not advance the quote revision');
        assert.equal(Afk.boardIndex().ownerLines(owner)[0].pricing.seenCounter, held.pricing.seenCounter + 1);
        assert.deepEqual(await totals(owner), [20, 20, 20], 'changed observations fence the captured price snapshot');
        admission = () => {};
        const fence = Error('cold_postcommit_source_retired');
        await assert.rejects(run([stale.lineId], { beforeWrite: () => { throw fence; } }), error => error === fence);
        assert.equal(Afk.boardIndex().ownerLines(owner).length, 1, 'retired source cannot withdraw live stock');
        assert.deepEqual(await totals(owner), [20, 20, 20]);
        await run([stale.lineId]);

        const funded = await stateFor(owner);
        await Life.upsertState({ ...funded, stats: { ...funded.stats,
            money: [10000, .0001, 100, 0, .001, 2000, 1864] } }, 'withdrawal_bid_fixture');
        const bids = await Database.openBoardRecords(owner, 'buy_ad', [{ storeType: Afk.BUY, town: 'Giran',
            lines: [{ selfId: 1864, name: 'Stem', count: 1, price: 100, stackable: true }] }]);
        bids.opened.forEach(Afk.refreshRecord);
        const bid = Afk.boardIndex().ownerLines(owner)[0];
        assert.equal(bid.storeType, Afk.BUY);
        await assert.rejects(run([bid.lineId]), /economy_plan_line_changed/);
        assert.equal(writes, 0, 'a withdrawal intention for SELL never closes a BUY line');
        assert.equal(Afk.boardIndex().ownerLines(owner)[0].lineId, bid.lineId);
        console.log('PASS native plan withdrawal batch: one write, exactly-once stock, prior review, duplicates, foreign owner, stale record/observations, source fence and BUY preservation');
    } finally {
        Database.repriceBoardLines = nativeReprice; await world.close();
        require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
