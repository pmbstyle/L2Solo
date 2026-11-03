const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const InventorySummary = invoke('GameServer/Bot/Population/InventorySummary');
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

// A deal on a far bot's record (step 3.3) settles at once, and the merge
// moves the row's revision. The worker steps the owner, a buyer or seller
// fills its record, then the worker commits a hunt (+30 adena, 2 Stems)
// projected from the inventory it stepped from: the commit is refused and
// the retry from the merged row keeps the hunt and the deal.
async function fillDuringStep({ label, storeType, lines, ownerItems, counterpartyItems = [], write, settled }) {
    const owner = await makeCharacter(`bot_${label}_owner`, `${label}Owner`, ownerItems);
    const counterparty = await makeCharacter(`pl_${label}`, `${label}Player`, counterpartyItems);
    await coldBot(owner.id, `bot_${label}_owner`, `${label}Owner`);
    await AfkTrade.publishBot(owner.id, {
        storeType, title: label, town: 'Giran', locX: 83000, locY: 148000, locZ: -3400,
        appearance: { model: character(`${label}Owner`) },
        lines: lines(owner.ids)
    });
    const stepped = LifeState.cachedState(owner.id);
    const stepRevision = stepped.simulation.revision;
    const before = await amounts(owner.id);
    const store = AfkTrade.findOwnerProjection(owner.id).actor.fetchPrivateStore();
    await write(store, counterparty, owner);
    const merged = await amounts(owner.id);
    for (const [selfId, delta] of Object.entries(settled)) {
        assert.strictEqual(Number(merged[selfId] || 0), Number(before[selfId] || 0) + delta, `${label}: the deal settles at once`);
    }
    assert.deepStrictEqual(Database.boardSettlementOwners(), [], `${label}: nothing waits on the board`);

    const next = structuredClone(stepped.inventory);
    next['57'].amount += 30;
    next['1864'] = { selfId: 1864, name: 'Stem', amount: 2 };
    const [refused] = await Owner.commitBatch([{ revision: stepRevision,
        nextState: { ...stepped, adena: next['57'].amount, inventory: next },
        proposal: InventorySummary.bagChange(stepped.inventory, next) }], { timestamp: Date.now() });
    assert.strictEqual(refused.reason, 'stale_revision', `${label}: the step from before the deal is refused`);

    const retry = LifeState.cachedState(owner.id);
    assert.strictEqual(retry.adena, merged[57], `${label}: the retry starts from the merged wallet`);
    const hunted = structuredClone(retry.inventory);
    hunted['57'].amount += 30;
    hunted['1864'] = { selfId: 1864, name: 'Stem', amount: 2 };
    const [commit] = await Owner.commitBatch([{ revision: retry.simulation.revision,
        nextState: { ...retry, adena: hunted['57'].amount, inventory: hunted },
        proposal: InventorySummary.bagChange(retry.inventory, hunted) }], { timestamp: Date.now() });
    assert(commit.ok, `${label}: the retry commits`);
    const after = await amounts(owner.id);
    const expected = { ...settled, 57: 30 + Number(settled[57] || 0) };
    for (const [selfId, delta] of Object.entries(expected)) {
        assert.strictEqual(Number(after[selfId] || 0), Number(before[selfId] || 0) + delta,
            `${label}: item ${selfId} holds the hunt and the deal`);
    }
    assert.strictEqual(Number(after[1864] || 0), 2, `${label}: the hunt's stems stay`);
    const cached = LifeState.cachedState(owner.id);
    assert.strictEqual(cached.adena, after[57], `${label}: the bot goes on with the merged wallet`);
    // A cache behind the row's updatedAt would make every later command of
    // this bot stale against the row (L127).
    const [lifeRow] = await Database.execute(['SELECT updatedAt FROM bot_life_state WHERE characterId = ?', [owner.id]]);
    assert.strictEqual(cached.updatedAt, Number(lifeRow.updatedAt), `${label}: the cached checkpoint follows the row`);
}

// The worker steps the owner, the owner's own move (a close, reprice or
// publish) lands, then the worker commits a hunt (+30 adena, 2 Stems)
// projected from the inventory it stepped from.
async function writeDuringStep({ label, storeType, lines, ownerItems, counterpartyItems = [], write }) {
    const owner = await makeCharacter(`bot_${label}_owner`, `${label}Owner`, ownerItems);
    const counterparty = await makeCharacter(`pl_${label}`, `${label}Player`, counterpartyItems);
    await coldBot(owner.id, `bot_${label}_owner`, `${label}Owner`);
    await AfkTrade.publishBot(owner.id, {
        storeType, title: label, town: 'Giran', locX: 83000, locY: 148000, locZ: -3400,
        appearance: { model: character(`${label}Owner`) },
        lines: lines(owner.ids)
    });
    const stepped = LifeState.cachedState(owner.id);
    const stepRevision = stepped.simulation.revision;

    const base = await journalTotals();
    const store = AfkTrade.findOwnerProjection(owner.id).actor.fetchPrivateStore();
    await write(store, counterparty, owner);
    const afterFill = await amounts(owner.id);

    const next = structuredClone(stepped.inventory);
    next['57'].amount += 30;
    next['1864'] = { selfId: 1864, name: 'Stem', amount: 2 };
    const nextState = { ...stepped, adena: next['57'].amount, inventory: next };
    const [commit] = await Owner.commitBatch([{ revision: stepRevision, nextState,
        proposal: InventorySummary.bagChange(stepped.inventory, next) }], { timestamp: Date.now() });
    assert.strictEqual(commit.ok, false, `${label}: the worker commit after the shop write fails its CAS`);
    assert.strictEqual(commit.reason, 'stale_revision');
    assert.deepStrictEqual(await amounts(owner.id), afterFill, `${label}: the rejected commit leaves the fill in items`);

    // The refusal hands the worker the cached row to resolve again
    // (ColdSimulationCoordinator.handleCommitResults).
    const retry = LifeState.cachedState(owner.id);
    assert.strictEqual(retry.inventory['57'].amount, afterFill[57], `${label}: the retry starts from the filled adena`);
    assert.strictEqual(retry.adena, afterFill[57]);
    const traded = [...new Set([...Object.keys(afterFill), ...Object.keys(stepped.inventory)])].map(Number);
    for (const selfId of traded) {
        assert.strictEqual(Number(retry.inventory[selfId]?.amount || 0), Number(afterFill[selfId] || 0),
            `${label}: the retry starts from the filled item ${selfId}`);
    }
    const [row] = await Database.execute(['SELECT adena, inventorySummary FROM bot_life_state WHERE characterId = ?', [owner.id]]);
    assert.strictEqual(Number(row.adena), afterFill[57], `${label}: the stored row holds the filled adena`);

    // The retry commits from the fresh row: the fill and the hunt both stay.
    const hunted = structuredClone(retry.inventory);
    hunted['57'].amount += 30;
    const [second] = await Owner.commitBatch([{ revision: retry.simulation.revision,
        nextState: { ...retry, adena: hunted['57'].amount, inventory: hunted },
        proposal: InventorySummary.bagChange(retry.inventory, hunted) }], { timestamp: Date.now() });
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

    // A sale from a far bot's sell shop: the 250 adena it earned arrive at once.
    await fillDuringStep({
        label: 'sell', storeType: AfkTrade.SELL,
        ownerItems: [item(57, 1000, 'Adena'), item(POTION, 10, 'Lesser Healing Potion')],
        counterpartyItems: [item(57, 5000, 'Adena')],
        lines: (ids) => [{ objectId: ids[POTION], selfId: POTION, name: 'Lesser Healing Potion', count: 10, price: 50, stackable: true }],
        write: (store, buyer) => AfkTrade.buyFromShop(buyer.id, store, POTION, 5, { expectedPrice: 50 }),
        settled: { 57: 250 }
    });

    // A fill of a far bot's buy order: the 5 bought ores arrive at once.
    await fillDuringStep({
        label: 'buy', storeType: AfkTrade.BUY,
        ownerItems: [item(57, 1000, 'Adena'), item(IRON_ORE, 5, 'Iron Ore')],
        counterpartyItems: [item(57, 5000, 'Adena'), item(IRON_ORE, 10, 'Iron Ore')],
        lines: () => [{ selfId: IRON_ORE, name: 'Iron Ore', count: 10, price: 20, stackable: true }],
        write: (store, seller) => AfkTrade.sellToShop(seller.id, store, IRON_ORE, 5,
            { objectId: seller.ids[IRON_ORE], expectedPrice: 20 }),
        settled: { [IRON_ORE]: 5 }
    });

    // Closing a far bot's buy shop returns its 200 escrow adena; they stay.
    await writeDuringStep({
        label: 'closebuy', storeType: AfkTrade.BUY,
        ownerItems: [item(57, 1000, 'Adena')],
        lines: () => [{ selfId: IRON_ORE, name: 'Iron Ore', count: 10, price: 20, stackable: true }],
        write: (store, _, owner) => AfkTrade.stop(owner.id)
    });

    // Closing a far bot's sell shop returns its 10 potions; they stay.
    await writeDuringStep({
        label: 'closesell', storeType: AfkTrade.SELL,
        ownerItems: [item(57, 1000, 'Adena'), item(POTION, 10, 'Lesser Healing Potion')],
        lines: (ids) => [{ objectId: ids[POTION], selfId: POTION, name: 'Lesser Healing Potion', count: 10, price: 50, stackable: true }],
        write: (store, _, owner) => AfkTrade.stop(owner.id)
    });

    // Repricing a far bot's buy line from 20 to 30 reserves 100 more adena.
    await writeDuringStep({
        label: 'reprice', storeType: AfkTrade.BUY,
        ownerItems: [item(57, 1000, 'Adena')],
        lines: () => [{ selfId: IRON_ORE, name: 'Iron Ore', count: 10, price: 20, stackable: true }],
        write: (store, _, owner) => AfkTrade.repriceBot(owner.id, store.items[0].afkTradeLineId, 30,
            AfkTrade.findOwnerProjection(owner.id).shop.revision, null, { match: false })
    });

    // Republishing a far bot's sell shop with 4 of its 10 potions (the
    // prune after a sale does this): 6 come back to the backpack and stay.
    await writeDuringStep({
        label: 'publish', storeType: AfkTrade.SELL,
        ownerItems: [item(57, 1000, 'Adena'), item(POTION, 10, 'Lesser Healing Potion')],
        lines: (ids) => [{ objectId: ids[POTION], selfId: POTION, name: 'Lesser Healing Potion', count: 10, price: 50, stackable: true }],
        write: (store, _, owner) => AfkTrade.publishBot(owner.id, { storeType: AfkTrade.SELL, title: 'publish', town: 'Giran',
            locX: 83000, locY: 148000, locZ: -3400, appearance: { model: character('publishOwner') },
            lines: [{ objectId: owner.ids[POTION], selfId: POTION, name: 'Lesser Healing Potion', count: 4, price: 50, stackable: true }] })
    });

    { // An ad holds no goods: nothing moved, a far bot's step stands.
        const ad = await makeCharacter('bot_ad_owner', 'adOwner', [item(57, 1000, 'Adena')]);
        const far = await coldBot(ad.id, 'bot_ad_owner', 'adOwner');
        await LifeState.upsertState({ ...far, stats: { ...far.stats, money: [36000, 0.001, 0, 0, 0.001, 1000, IRON_ORE] } }, 'test_money_packet');
        const revision = LifeState.cachedState(ad.id).simulation.revision;
        const opened = await Database.openBoardRecords(ad.id, 'buy_ad', [{ storeType: AfkTrade.BUY, title: 'ad', town: 'Giran',
            locX: 83000, locY: 148000, locZ: -3400, appearance: { model: character('adOwner') },
            lines: [{ selfId: IRON_ORE, name: 'Iron Ore', count: 10, price: 20, stackable: true }] }]);
        assert.strictEqual(opened.opened.length, 1, 'the ad stands');
        assert.deepStrictEqual(opened.coldLifeRows, {}, 'an ad fences nobody');
        assert.strictEqual(LifeState.cachedState(ad.id).simulation.revision, revision);
    }

    await AfkTrade._resetForTests();
    await Database.close();
    clean();
    console.log(`Board writes on ${accounts} characters: a deal on a far bot settles at once; its own close, reprice or publish fences its row; nothing lost`);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
