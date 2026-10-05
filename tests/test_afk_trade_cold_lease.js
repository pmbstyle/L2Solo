const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const World = invoke('GameServer/World/World');
const databasePath = path.join(process.cwd(), 'tmp', 'test-afk-trade-cold-lease.sqlite');
const IRON_ORE = 1869;
const POTION = 1060; // not a material: the rest of the lot stays listed

function clean() {
    const history = databasePath.replace(/\.sqlite$/, '.history.sqlite');
    for (const file of [databasePath, history]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

function character(name) {
    return { name, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 83000, locY: 148000, locZ: -3400 };
}

function item(selfId, amount, name = `Item ${selfId}`) {
    return { selfId, name, amount, enchant: 0, equipped: false, slot: 0 };
}

async function amounts(characterId) {
    const totals = {};
    for (const row of await Database.fetchItems(characterId)) {
        totals[row.selfId] = Number(totals[row.selfId] || 0) + Number(row.amount);
    }
    return totals;
}

// Journal deltas per operation and item since `base` (see journalTotals).
async function journalTotals() {
    await Database.flushJournals();
    const rows = await Database.readHistory(['SELECT operation, selfId, SUM(delta) AS delta FROM economy_flow_hour GROUP BY operation, selfId'],
        'test:journal');
    return new Map(rows.map((row) => [`${row.operation}|${row.selfId}`, Number(row.delta)]));
}

function journalSince(base, now) {
    const changed = {};
    for (const [key, delta] of now) {
        const diff = delta - Number(base.get(key) || 0);
        if (diff !== 0) changed[key] = diff;
    }
    return changed;
}

let accounts = 0;
async function makeCharacter(account, name, items) {
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, character(name))).insertId);
    accounts += 1;
    const ids = {};
    for (const entry of items) ids[entry.selfId] = Number((await Database.setItem(id, entry)).insertId);
    return { id, ids };
}

async function coldBot(id, account, name) {
    return LifeState.upsertState({
        characterId: id, accountName: account, name, level: 20, exp: 1000, sp: 100,
        phase: 'cold', activity: 'hunting', currentRegion: 'Giran',
        loc: { locX: 83000, locY: 148000, locZ: -3400 },
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(id)),
        adena: (await amounts(id))[57] || 0,
        vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 }, stats: { generatedCold: true }, timing: {}
    }, 'test_cold_seed');
}

// A deal on a leased bot's record (step 3.3) touches only the records: what
// the deal owes the bot waits on the board and the worker's commit merges it.
// The worker leases the owner, a buyer or seller fills its record, then the
// worker commits a hunt (+30 adena, 2 Stems) projected from the inventory it
// leased: the commit succeeds and the bot has the hunt and the deal.
async function fillUnderLease({ label, storeType, lines, ownerItems, counterpartyItems = [], write, settled }) {
    const owner = await makeCharacter(`bot_${label}_owner`, `${label}Owner`, ownerItems);
    const counterparty = await makeCharacter(`pl_${label}`, `${label}Player`, counterpartyItems);
    await coldBot(owner.id, `bot_${label}_owner`, `${label}Owner`);
    await AfkTrade.publishBot(owner.id, {
        storeType, title: label, town: 'Giran', locX: 83000, locY: 148000, locZ: -3400,
        appearance: { model: character(`${label}Owner`) },
        lines: lines(owner.ids)
    });
    const leased = LifeState.cachedState(owner.id);
    const claim = await Owner.claim(leased, { timestamp: Date.now(), leaseMs: 30000 });
    assert(claim.ok, `${label}: the worker leases the owner`);
    const before = await amounts(owner.id);
    const store = AfkTrade.findOwnerProjection(owner.id).actor.fetchPrivateStore();
    await write(store, counterparty, owner);
    assert.deepStrictEqual(await amounts(owner.id), before, `${label}: the deal leaves the leased bot's bag alone`);
    assert.deepStrictEqual(Database.boardSettlementOwners(), [owner.id], `${label}: what the deal owes waits on the board`);

    const next = structuredClone(leased.inventory);
    next['57'].amount += 30;
    next['1864'] = { selfId: 1864, name: 'Stem', amount: 2 };
    const nextState = { ...leased, adena: next['57'].amount, inventory: next,
        simulation: { ...leased.simulation, ownerId: Owner.OWNER_ID, revision: claim.revision } };
    const [commit] = await Owner.commitAndReleaseBatch([{ token: claim, nextState,
        proposal: { baseState: { inventory: leased.inventory } } }], { timestamp: Date.now() });
    assert(commit.ok, `${label}: the worker commit after the deal succeeds`);
    assert.strictEqual(commit.settled, true, `${label}: the commit merges the deal`);
    const after = await amounts(owner.id);
    const expected = { ...settled, 57: 30 + Number(settled[57] || 0) };
    for (const [selfId, delta] of Object.entries(expected)) {
        assert.strictEqual(Number(after[selfId] || 0), Number(before[selfId] || 0) + delta,
            `${label}: item ${selfId} holds the hunt and the deal`);
    }
    assert.strictEqual(Number(after[1864] || 0), 2, `${label}: the hunt's stems stay`);
    const cached = LifeState.cachedState(owner.id);
    assert.strictEqual(cached.adena, after[57], `${label}: the bot goes on with the merged wallet`);
    assert.deepStrictEqual(Database.boardSettlementOwners(), [], `${label}: nothing waits after the commit`);
}

// The worker leases the owner, the owner's own move (a close, reprice or
// publish) lands, then the worker commits a hunt (+30 adena, 2 Stems)
// projected from the inventory it leased.
async function writeUnderLease({ label, storeType, lines, ownerItems, counterpartyItems = [], write }) {
    const owner = await makeCharacter(`bot_${label}_owner`, `${label}Owner`, ownerItems);
    const counterparty = await makeCharacter(`pl_${label}`, `${label}Player`, counterpartyItems);
    await coldBot(owner.id, `bot_${label}_owner`, `${label}Owner`);
    await AfkTrade.publishBot(owner.id, {
        storeType, title: label, town: 'Giran', locX: 83000, locY: 148000, locZ: -3400,
        appearance: { model: character(`${label}Owner`) },
        lines: lines(owner.ids)
    });
    const leased = LifeState.cachedState(owner.id);
    const claim = await Owner.claim(leased, { timestamp: Date.now(), leaseMs: 30000 });
    assert(claim.ok, `${label}: the worker leases the owner`);

    const base = await journalTotals();
    const store = AfkTrade.findOwnerProjection(owner.id).actor.fetchPrivateStore();
    await write(store, counterparty, owner);
    const afterFill = await amounts(owner.id);

    const next = structuredClone(leased.inventory);
    next['57'].amount += 30;
    next['1864'] = { selfId: 1864, name: 'Stem', amount: 2 };
    const nextState = { ...leased, adena: next['57'].amount, inventory: next,
        simulation: { ...leased.simulation, ownerId: Owner.OWNER_ID, revision: claim.revision } };
    const [commit] = await Owner.commitAndReleaseBatch([{ token: claim, nextState,
        proposal: { baseState: { inventory: leased.inventory } } }], { timestamp: Date.now() });
    assert.strictEqual(commit.ok, false, `${label}: the worker commit after the shop write fails its CAS`);
    assert.strictEqual(commit.reason, 'stale_revision');
    assert.deepStrictEqual(await amounts(owner.id), afterFill, `${label}: the rejected commit leaves the fill in items`);

    // The coordinator releases the rejected lease and hands the worker the
    // cached row to resolve again (ColdSimulationCoordinator.handleCommitResults).
    const [released] = await Owner.releaseBatch([claim], { timestamp: Date.now(), releaseInvalidated: true });
    assert(released.ok, `${label}: the rejected lease is released`);
    const retry = LifeState.cachedState(owner.id);
    assert.strictEqual(retry.inventory['57'].amount, afterFill[57], `${label}: the retry starts from the filled adena`);
    assert.strictEqual(retry.adena, afterFill[57]);
    const traded = [...new Set([...Object.keys(afterFill), ...Object.keys(leased.inventory)])].map(Number);
    for (const selfId of traded) {
        assert.strictEqual(Number(retry.inventory[selfId]?.amount || 0), Number(afterFill[selfId] || 0),
            `${label}: the retry starts from the filled item ${selfId}`);
    }
    const [row] = await Database.execute(['SELECT adena, inventorySummary FROM bot_life_state WHERE characterId = ?', [owner.id]]);
    assert.strictEqual(Number(row.adena), afterFill[57], `${label}: the stored row holds the filled adena`);

    // The retry commits from the fresh row: the fill and the hunt both stay.
    const again = await Owner.claim(retry, { timestamp: Date.now(), leaseMs: 30000 });
    assert(again.ok, `${label}: the worker leases the fresh row`);
    const hunted = structuredClone(retry.inventory);
    hunted['57'].amount += 30;
    const [second] = await Owner.commitAndReleaseBatch([{ token: again,
        nextState: { ...retry, adena: hunted['57'].amount, inventory: hunted,
            simulation: { ...retry.simulation, ownerId: Owner.OWNER_ID, revision: again.revision } },
        proposal: { baseState: { inventory: retry.inventory } } }], { timestamp: Date.now() });
    assert(second.ok, `${label}: the retry commits`);
    assert.deepStrictEqual(await amounts(owner.id), { ...afterFill, 57: afterFill[57] + 30 },
        `${label}: no adena or items lost`);
    const commits = Object.fromEntries(Object.entries(journalSince(base, await journalTotals()))
        .filter(([key]) => key.startsWith('bot-life:cold-owner-commit-release-batch/')));
    assert.deepStrictEqual(commits, { 'bot-life:cold-owner-commit-release-batch/resolve|57': 30 },
        `${label}: the journal of the commits shows only the hunt, nothing taken back`);
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();

    // A sale from a leased bot's sell shop: the 250 adena it earned arrive
    // with the commit.
    await fillUnderLease({
        label: 'sell', storeType: AfkTrade.SELL,
        ownerItems: [item(57, 1000, 'Adena'), item(POTION, 10, 'Lesser Healing Potion')],
        counterpartyItems: [item(57, 5000, 'Adena')],
        lines: (ids) => [{ objectId: ids[POTION], selfId: POTION, name: 'Lesser Healing Potion', count: 10, price: 50, stackable: true }],
        write: (store, buyer) => AfkTrade.buyFromShop(buyer.id, store, POTION, 5, { expectedPrice: 50 }),
        settled: { 57: 250 }
    });

    // A fill of a leased bot's buy order: the 5 bought ores arrive with the
    // commit.
    await fillUnderLease({
        label: 'buy', storeType: AfkTrade.BUY,
        ownerItems: [item(57, 1000, 'Adena'), item(IRON_ORE, 5, 'Iron Ore')],
        counterpartyItems: [item(57, 5000, 'Adena'), item(IRON_ORE, 10, 'Iron Ore')],
        lines: () => [{ selfId: IRON_ORE, name: 'Iron Ore', count: 10, price: 20, stackable: true }],
        write: (store, seller) => AfkTrade.sellToShop(seller.id, store, IRON_ORE, 5,
            { objectId: seller.ids[IRON_ORE], expectedPrice: 20 }),
        settled: { [IRON_ORE]: 5 }
    });

    // Closing a leased bot's buy shop returns its 200 escrow adena; they stay.
    await writeUnderLease({
        label: 'closebuy', storeType: AfkTrade.BUY,
        ownerItems: [item(57, 1000, 'Adena')],
        lines: () => [{ selfId: IRON_ORE, name: 'Iron Ore', count: 10, price: 20, stackable: true }],
        write: (store, _, owner) => AfkTrade.stop(owner.id)
    });

    // Closing a leased bot's sell shop returns its 10 potions; they stay.
    await writeUnderLease({
        label: 'closesell', storeType: AfkTrade.SELL,
        ownerItems: [item(57, 1000, 'Adena'), item(POTION, 10, 'Lesser Healing Potion')],
        lines: (ids) => [{ objectId: ids[POTION], selfId: POTION, name: 'Lesser Healing Potion', count: 10, price: 50, stackable: true }],
        write: (store, _, owner) => AfkTrade.stop(owner.id)
    });

    // Repricing a leased bot's buy line from 20 to 30 reserves 100 more adena.
    await writeUnderLease({
        label: 'reprice', storeType: AfkTrade.BUY,
        ownerItems: [item(57, 1000, 'Adena')],
        lines: () => [{ selfId: IRON_ORE, name: 'Iron Ore', count: 10, price: 20, stackable: true }],
        write: (store, _, owner) => AfkTrade.repriceBot(owner.id, store.items[0].afkTradeLineId, 30,
            AfkTrade.findOwnerProjection(owner.id).shop.revision, null, { match: false })
    });

    // Republishing a leased bot's sell shop with 4 of its 10 potions (the
    // prune after a sale does this): 6 come back to the backpack and stay.
    await writeUnderLease({
        label: 'publish', storeType: AfkTrade.SELL,
        ownerItems: [item(57, 1000, 'Adena'), item(POTION, 10, 'Lesser Healing Potion')],
        lines: (ids) => [{ objectId: ids[POTION], selfId: POTION, name: 'Lesser Healing Potion', count: 10, price: 50, stackable: true }],
        write: (store, _, owner) => AfkTrade.publishBot(owner.id, { storeType: AfkTrade.SELL, title: 'publish', town: 'Giran',
            locX: 83000, locY: 148000, locZ: -3400, appearance: { model: character('publishOwner') },
            lines: [{ objectId: owner.ids[POTION], selfId: POTION, name: 'Lesser Healing Potion', count: 4, price: 50, stackable: true }] })
    });

    // A fill on a bot the worker does not lease leaves its revision alone.
    const free = await makeCharacter('bot_free_owner', 'FreeOwner', [item(57, 1000, 'Adena'), item(POTION, 4, 'Lesser Healing Potion')]);
    const freeBuyer = await makeCharacter('pl_free', 'FreePlayer', [item(57, 1000, 'Adena')]);
    await coldBot(free.id, 'bot_free_owner', 'FreeOwner');
    await AfkTrade.publishBot(free.id, { storeType: AfkTrade.SELL, title: 'free', town: 'Giran',
        locX: 83000, locY: 148000, locZ: -3400, appearance: { model: character('FreeOwner') },
        lines: [{ objectId: free.ids[POTION], selfId: POTION, name: 'Lesser Healing Potion', count: 4, price: 10, stackable: true }] });
    const before = LifeState.cachedState(free.id).simulation.revision;
    const freeTrade = await Database.buyFromAfkTradeShop(freeBuyer.id, { shopId: AfkTrade.findOwnerProjection(free.id).shop.id,
        ownerId: free.id, lineId: AfkTrade.findOwnerProjection(free.id).actor.fetchPrivateStore().items[0].afkTradeLineId, amount: 1 });
    assert.deepStrictEqual(freeTrade.coldLifeRows, {}, 'a legacy-owned row is not fenced');
    assert.deepStrictEqual(freeTrade.settlementOwners, [free.id], 'the deal leaves the owner a settlement');
    await AfkTrade.settleOwners(freeTrade.settlementOwners);
    assert.strictEqual(LifeState.cachedState(free.id).adena, 1010, 'a bot the worker does not hold gets it at once');
    const [freeRow] = await Database.execute(['SELECT simulationRevision FROM bot_life_state WHERE characterId = ?', [free.id]]);
    assert.strictEqual(Number(freeRow.simulationRevision), Number(before) + 1, 'the settle is a save of the bot');
    const freeClose = await Database.closeAfkTradeShop(free.id);
    assert(freeClose.closed);
    assert.deepStrictEqual(freeClose.coldLifeRows, {}, 'closing the shop of a legacy-owned row does not fence it');
    const [closedRow] = await Database.execute(['SELECT simulationRevision FROM bot_life_state WHERE characterId = ?', [free.id]]);
    assert.strictEqual(Number(closedRow.simulationRevision), Number(before) + 1);

    await AfkTrade._resetForTests();
    await Database.close();
    clean();
    console.log(`Board writes on ${accounts} characters: a deal on a leased bot waits for its commit; its own close, reprice or publish fences its row; nothing lost`);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
