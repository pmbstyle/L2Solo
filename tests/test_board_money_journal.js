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
const InventorySummary = invoke('GameServer/Bot/Population/InventorySummary');
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

// A bot's sell shop republished with other lines keeps its record: its
// revision moves (a move naming the old one is refused), a line that stands
// keeps its row, a changed count moves only the difference, a line gone gives
// its stock back, and lines stay in the order published. The journal check at
// the end of the run counts these moves too.
async function republishKeepsRecord(seller, shopId) {
    const current = async () => (await Database.fetchAfkTradeShops(seller)).find((record) => record.kind === 'shop');
    const bag = async (selfId) => (await Database.fetchItems(seller)).filter((item) => Number(item.selfId) === selfId)
        .reduce((sum, item) => sum + Number(item.amount), 0);
    // A kept line as the sell review passes it back (BotAfkMarketService.sellLines).
    const kept = (line, count = line.count) => ({ objectId: Number(line.sourceObjectId || 0), selfId: line.selfId, name: line.name,
        count, price: line.price, enchant: line.enchant, slot: line.slot, stackable: Number(line.stackable) === 1,
        petData: line.petData || null, fills: line.fills, pricing: line.pricing });
    const varnish = async (count) => ({ objectId: Number((await Database.fetchItems(seller)).find((item) => Number(item.selfId) === 1865).id),
        selfId: 1865, name: 'Varnish', count, price: 300, stackable: true });
    const publish = (record, lines) => AfkTrade.publishBot(seller, { storeType: 1, title: 'Stems', town: 'Giran',
        locX: 81000, locY: 148000, locZ: -3466, appearance: {}, lines, expectedRevision: record.revision });
    const opened = await current();
    const stem = opened.lines[0];
    assert.strictEqual([stem.count, stem.fills].join(), '25,1', 'the player bought 5 of the 30 stems');

    let shop = await publish(opened, [kept(stem), await varnish(4)]);
    let after = await current();
    assert.strictEqual(shop.id, shopId, 'the republished shop keeps its record');
    assert.strictEqual(after.revision, opened.revision + 1, 'its revision moves');
    assert.deepStrictEqual(after.lines[0], stem, 'the line that stands keeps its row as it was');
    assert.deepStrictEqual(after.lines.map((line) => [line.selfId, line.count]), [[1864, 25], [1865, 4]], 'a new line comes last');
    assert.deepStrictEqual([await bag(1864), await bag(1865)], [70, 6], 'only the new line took from the bag');
    await assert.rejects(publish(opened, [kept(stem)]), /afk_trade_shop_changed/, 'a move naming the old revision is refused');

    const moved = after;
    shop = await publish(moved, [kept(moved.lines[0], 20)]);
    after = await current();
    assert.strictEqual(shop.id, shopId);
    assert.deepStrictEqual(after.lines.map((line) => [line.id, line.count, line.fills]), [[stem.id, 20, 1]],
        'a smaller count stays on its row with its fills; the line gone leaves');
    assert.deepStrictEqual([await bag(1864), await bag(1865)], [75, 10], 'the difference and the line gone went back to the bag');

    // A kept line published after a new one would sort before it: it is
    // given back and taken again as a new row, in the published order.
    shop = await publish(after, [await varnish(2), kept(after.lines[0])]);
    after = await current();
    assert.strictEqual(shop.id, shopId);
    assert.deepStrictEqual(after.lines.map((line) => [line.selfId, line.count]), [[1865, 2], [1864, 20]]);
    assert.notEqual(after.lines[1].id, stem.id);
    assert.deepStrictEqual([after.lines[1].fills, after.lines[1].pricingPrice], [1, stem.pricingPrice], 'the line keeps its fills and pricing');
    assert.deepStrictEqual([await bag(1864), await bag(1865)], [75, 8]);
    assert.strictEqual(AfkTrade.findOwnerProjection(seller).shop.id, shopId, 'the shop standing in the town is the same record');
    await publish(after, [kept(after.lines[1])]);
    assert.deepStrictEqual([await bag(1864), await bag(1865)], [75, 10]);

    // A production input the bot keeps (a shot craft set up: 15 batches of 5
    // Stems, ItemDisposition) is checked as a reopen would: the shop's own
    // stock counts as offered again, the bag still covers the reserve. 75
    // reserved, 75 in the bag: the 20 listed stand, 21 are refused.
    const crafting = LifeState.cachedState(seller);
    await LifeState.upsertState({ ...crafting, stats: { ...crafting.stats,
        shotCraft: { preparing: { at: Date.now(), recipeId: 28, batches: 15 } } } }, 'test_craft_setup');
    const reserved = await current();
    await publish(reserved, [kept(reserved.lines[0])]);
    const standing = await current();
    assert.strictEqual(standing.revision, reserved.revision + 1, 'the unchanged line within the reserve is republished');
    await assert.rejects(publish(standing, [kept(standing.lines[0], 21)]), /economy_material_protected/);
    assert.deepStrictEqual(await current(), standing, 'a refused republish moves nothing');
    assert.strictEqual(await bag(1864), 75);
    await LifeState.upsertState({ ...LifeState.cachedState(seller), stats: crafting.stats }, 'test_craft_done');
}

async function run() {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();
    await AfkTrade.init();

    const seller = await character('bot_money_seller', [{ selfId: 57, name: 'Adena', amount: 1000 }, { selfId: 1864, name: 'Stem', amount: 100 },
        { selfId: 1865, name: 'Varnish', amount: 10 }]);
    const buyer = await character('bot_money_buyer', [{ selfId: 57, name: 'Adena', amount: 50000 }]);
    const leased = await character('bot_money_leased', [{ selfId: 57, name: 'Adena', amount: 1000 }, { selfId: 1864, name: 'Stem', amount: 40 }]);
    const near = await character('bot_money_near', [{ selfId: 57, name: 'Adena', amount: 1000 }, { selfId: 1864, name: 'Stem', amount: 10 }]);
    const leaver = await character('bot_money_leaver', [{ selfId: 57, name: 'Adena', amount: 9000 }, { selfId: 1864, name: 'Stem', amount: 30 }]);
    const player = await character('player_money', [{ selfId: 57, name: 'Adena', amount: 20000 }]);
    const heldBefore = await held();
    const journalBefore = await journal();

    const ad = (kind, lines) => ({ kind, storeType: kind === 'sell_ad' ? 1 : 3, title: kind, town: 'Giran', locX: 0, locY: 0, locZ: 0, lines });
    const shop = await AfkTrade.publishBot(seller, { storeType: 1, title: 'Stems', town: 'Giran', locX: 81000, locY: 148000, locZ: -3466,
        appearance: {}, lines: [await stemLine(seller, 30, 120)] });
    await AfkTrade.buyFromShop(player, AfkTrade.recordStore(shop.id), 1864, 5);
    await republishKeepsRecord(seller, shop.id);
    const buyAd = await AfkTrade.publishBot(buyer, { ...ad('buy_ad', [{ selfId: 1864, name: 'Stem', count: 20, price: 150, stackable: true }]), kind: 'shop' });
    // The seller answers the buy ad in its town (the side that acts travels, E45).
    const answer = await stemLine(seller, 20, 150);
    await AfkTrade.sellToShop(seller, AfkTrade.recordStore(buyAd.id), 1864, 20, { objectId: answer.objectId });
    await AfkTrade.publishBot(seller, ad('sell_ad', [await stemLine(seller, 10, 90)]));
    const leasedAd = await AfkTrade.publishBot(leased, { ...ad('sell_ad', [await stemLine(leased, 20, 100)]), kind: 'shop' });
    // A far bot's step starts from its row; the player's deal leaves the
    // price on the board without moving that row, so the step commits its hunt
    // and merges the price in the same save: nothing lost, nothing twice.
    const leasedState = LifeState.cachedState(leased);
    await AfkTrade.buyFromShop(player, AfkTrade.recordStore(leasedAd.id), 1864, 7);
    await AfkTrade.settleOwners([leased]);
    const hunted = structuredClone(leasedState.inventory);
    hunted['57'].amount += 30;
    const hunt = () => Owner.commitBatch([{ revision: leasedState.simulation.revision,
        nextState: { ...leasedState, adena: hunted['57'].amount, inventory: hunted },
        proposal: InventorySummary.bagChange(leasedState.inventory, hunted) }], { timestamp: Date.now() });
    const [commit] = await hunt();
    assert(commit.ok && commit.settled, 'the step started before the deal commits the hunt and the price');
    const [replayed] = await hunt();
    assert(!replayed.ok, 'a replay of the step is refused');
    // Small lots are no longer pruned by a fixed minimum (45a13735): the 13
    // remaining Stems stay listed and the owner's bag is untouched.
    assert.strictEqual(LifeState.cachedState(leased).adena, 1000 + 30 + 700, 'the far row carries the hunt and the price once');
    // A far bot that turns near (its row hot) before its step commit gets the
    // price at that hand-over, with no step and no clock.
    const nearAd = await AfkTrade.publishBot(near, { ...ad('sell_ad', [await stemLine(near, 10, 100)]), kind: 'shop' });
    await AfkTrade.buyFromShop(player, AfkTrade.recordStore(nearAd.id), 1864, 4);
    assert(Database.boardSettlementOwners().includes(near), 'the far owner\'s price waits on the board');
    await LifeState.upsertState({ ...LifeState.cachedState(near), phase: 'hot' }, 'spawn');
    for (let turn = 0; turn < 100 && Database.boardSettlementOwners().includes(near); turn++) await new Promise(resolve => setTimeout(resolve, 5));
    const adena = (await Database.fetchItems(near)).filter(item => Number(item.selfId) === 57).reduce((sum, item) => sum + Number(item.amount), 0);
    assert.strictEqual(adena, 1000 + 400, 'the bot handed to main holds the price in its bag');
    const expiring = await AfkTrade.publishBot(leaver, ad('sell_ad', [await stemLine(leaver, 10, 300)]));
    await AfkTrade.publishBot(leaver, ad('buy_ad', [{ selfId: 1865, name: 'Varnish', count: 10, price: 400, stackable: true }]));
    const standing = AfkTrade.activeShops().length;
    assert.strictEqual(standing, 6, 'the seller\'s shop and ad, the leased and near shops, the leaver\'s two ads');
    assert.notEqual(AfkTrade.recordStore(leasedAd.id), null, 'a small remaining lot stays listed');
    // Records close by events: the owners leave (the leave rule).
    assert.strictEqual(Number(expiring.expiresAt), 0, 'no record has a deadline');
    for (const owner of [seller, leased, near, leaver, buyer]) await AfkTrade.leave(owner);
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
