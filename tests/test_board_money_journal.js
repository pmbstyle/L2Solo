// The N0 money check on the board (step 3.3): over a run of board moves and
// deals (shop, ads, a player's purchase, a seller's answer to a buy ad, a deal on a bot
// the worker leases and the worker's commit, an expiry, the leave rule), the
// economy journal's flows per item equal the change of everything held:
// bags, sell lines, escrow and settlements. Nothing appears or vanishes
// outside the journal.
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

const databasePath = path.join(process.cwd(), 'tmp', 'test-board-money-journal.sqlite');

function clean() {
    const history = databasePath.replace(/\.sqlite$/, '.history.sqlite');
    for (const file of [databasePath, history]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

let created = 0;
async function character(account, items) {
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, {
        name: `Money${++created}`, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 82700, locY: 148600, locZ: -3470
    })).insertId);
    for (const item of items) await Database.setItem(id, { enchant: 0, equipped: false, slot: 0, ...item });
    if (account.startsWith('bot_')) {
        const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(id));
        await LifeState.upsertState({
            characterId: id, accountName: account, name: `Money${created}`, level: 40, adena: Number(inventory[57]?.amount || 0),
            phase: 'cold', activity: 'hunting', currentRegion: 'Giran', loc: { locX: 82700, locY: 148600, locZ: -3470 },
            inventory, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { generatedCold: true, money: [1000, 0, 0, 0] }, timing: {}
        }, 'test_seed');
    }
    return id;
}

// Everything held, per item: bags, sell lines, escrow, settlements.
async function held() {
    const totals = {};
    const add = (rows) => rows.forEach((row) => { totals[row.selfId] = Number(totals[row.selfId] || 0) + Number(row.amount); });
    add(await Database.execute(['SELECT selfId, SUM(amount) AS amount FROM items GROUP BY selfId']));
    add(await Database.execute([`SELECT lines.selfId, SUM(lines.count) AS amount FROM afk_trade_lines lines
        JOIN afk_trade_shops shops ON shops.id = lines.shopId WHERE shops.storeType = 1 AND shops.custodyPolicy=0 GROUP BY lines.selfId`]));
    add(await Database.execute(['SELECT 57 AS selfId, SUM(escrowAdena) AS amount FROM afk_trade_shops']));
    add(await Database.execute(['SELECT selfId, SUM(amount) AS amount FROM board_settlements GROUP BY selfId']));
    add(await Database.execute(['SELECT selfId,SUM(heldCount) amount FROM board_trade_meeting_lines GROUP BY selfId']));
    add(await Database.execute(['SELECT 57 selfId,SUM(escrowA+escrowB+routeReserveA+routeReserveB) amount FROM board_trade_meetings']));
    return totals;
}

async function journal() {
    await Database.flushJournals();
    await Database.flushHistory();
    const rows = await Database.readHistory(['SELECT selfId, SUM(delta) AS amount FROM economy_flow_hour GROUP BY selfId']);
    return Object.fromEntries(rows.map((row) => [row.selfId, Number(row.amount)]));
}

function difference(after, before) {
    const out = {};
    for (const key of new Set([...Object.keys(after), ...Object.keys(before)])) {
        const delta = Number(after[key] || 0) - Number(before[key] || 0);
        if (delta) out[key] = delta;
    }
    return out;
}

const stemLine = async (id, count, price) => {
    const row = (await Database.fetchItems(id)).find((item) => Number(item.selfId) === 1864);
    return { objectId: Number(row.id), selfId: 1864, name: 'Stem', count, price, stackable: true };
};

async function run() {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();
    await AfkTrade.init();

    const seller = await character('bot_money_seller', [{ selfId: 57, name: 'Adena', amount: 1000 }, { selfId: 1864, name: 'Stem', amount: 100 }]);
    const buyer = await character('bot_money_buyer', [{ selfId: 57, name: 'Adena', amount: 50000 }]);
    const leased = await character('bot_money_leased', [{ selfId: 57, name: 'Adena', amount: 1000 }, { selfId: 1864, name: 'Stem', amount: 40 }]);
    const leaver = await character('bot_money_leaver', [{ selfId: 57, name: 'Adena', amount: 9000 }, { selfId: 1864, name: 'Stem', amount: 30 }]);
    const player = await character('player_money', [{ selfId: 57, name: 'Adena', amount: 20000 }]);
    const heldBefore = await held();
    const journalBefore = await journal();

    const ad = (kind, lines) => ({ kind, storeType: kind === 'sell_ad' ? 1 : 3, title: kind, town: 'Giran', locX: 0, locY: 0, locZ: 0, lines });
    const shop = await AfkTrade.publishBot(seller, { storeType: 1, title: 'Stems', town: 'Giran', locX: 81000, locY: 148000, locZ: -3466,
        appearance: {}, lines: [await stemLine(seller, 30, 120)] });
    await AfkTrade.buyFromShop(player, AfkTrade.recordStore(shop.id), 1864, 5);
    const buyAd = await AfkTrade.publishBot(buyer, { ...ad('buy_ad', [{ selfId: 1864, name: 'Stem', count: 20, price: 150, stackable: true }]), kind: 'shop' });
    // The seller answers the buy ad in its town (the side that acts travels, E45).
    const answer = await stemLine(seller, 20, 150);
    await AfkTrade.sellToShop(seller, AfkTrade.recordStore(buyAd.id), 1864, 20, { objectId: answer.objectId });
    await AfkTrade.publishBot(seller, ad('sell_ad', [await stemLine(seller, 10, 90)]));
    const leasedAd = await AfkTrade.publishBot(leased, { ...ad('sell_ad', [await stemLine(leased, 20, 100)]), kind: 'shop' });
    const claim = await Owner.claim(LifeState.cachedState(leased), { timestamp: Date.now(), leaseMs: 30000 });
    assert(claim.ok);
    await AfkTrade.buyFromShop(player, AfkTrade.recordStore(leasedAd.id), 1864, 7);
    const leasedState = LifeState.cachedState(leased);
    const hunted = structuredClone(leasedState.inventory);
    hunted['57'].amount += 30;
    const [commit] = await Owner.commitAndReleaseBatch([{ token: claim,
        nextState: { ...leasedState, adena: hunted['57'].amount, inventory: hunted,
            simulation: { ...leasedState.simulation, ownerId: Owner.OWNER_ID, revision: claim.revision } },
        proposal: { baseState: { inventory: leasedState.inventory } } }], { timestamp: Date.now() });
    // Small lots are no longer pruned by a fixed minimum (45a13735): the 13
    // remaining Stems stay listed, the owner's bag is untouched, and the
    // worker's commit merges the sale's settlement.
    assert(commit.ok && commit.settled, 'the commit merges the leased bot\'s deal');
    await AfkTrade.settleOwners([leased]);
    const expiring = await AfkTrade.publishBot(leaver, ad('sell_ad', [await stemLine(leaver, 10, 300)]));
    await AfkTrade.publishBot(leaver, ad('buy_ad', [{ selfId: 1865, name: 'Varnish', count: 10, price: 400, stackable: true }]));
    const standing = AfkTrade.activeShops().length;
    assert.strictEqual(standing, 5, 'the seller\'s shop and ad, the leased shop, the leaver\'s two ads');
    assert.notEqual(AfkTrade.recordStore(leasedAd.id), null, 'a small remaining lot stays listed');
    // Records close by events: the owners leave (the leave rule).
    assert.strictEqual(Number(expiring.expiresAt), 0, 'no record has a deadline');
    for (const owner of [seller, leased, leaver, buyer]) await AfkTrade.leave(owner);
    assert.strictEqual(AfkTrade.activeShops().length, 0, 'every record of the run is closed');

    const heldChange = difference(await held(), heldBefore);
    const journalChange = difference(await journal(), journalBefore);
    assert.deepStrictEqual(journalChange, heldChange, 'the journal accounts for every change of what is held');
    assert.deepStrictEqual(heldChange, { 57: 30 }, 'only the leased bot\'s hunt adds money; the board moves, it never makes');
    console.log(`Board money journal: held change ${JSON.stringify(heldChange)} = journal flows ${JSON.stringify(journalChange)}`);

    await AfkTrade._resetForTests();
    await Database.close();
    clean();
}

run().catch(async (error) => {
    console.error(error);
    try { await AfkTrade._resetForTests(); } catch (_) { /* cleanup only */ }
    try { await Database.close(); } catch (_) { /* cleanup only */ }
    clean();
    process.exitCode = 1;
});
