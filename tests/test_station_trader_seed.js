'use strict';
// The station traders: the craft services' pass seats one bot per trader seat
// (SupplierRoles.SEATS) as a merchant standing in its town, a static service that
// never hunts and steps only when a raise wakes it; its step stocks C/B/A gear of
// its town's grades on consignment and lists it on its shop in its own town.
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Pins the x50 restock pace.
process.env.L2NODE_PROGRESSION_RATE = 'x50';
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('station-trader-seed');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Database = invoke('Database');
invoke('GameServer/DataCache').init();
const World = invoke('GameServer/World/World');
World.user = World.user || { sessions: [], revision: 0 };
const Seeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SupplierRoles = invoke('GameServer/Bot/Economy/SupplierRoles');
const Identity = invoke('GameServer/Bot/AI/BotServiceIdentity');
const Cold = invoke('GameServer/Bot/Economy/ColdMarketService');
const Anchor = invoke('GameServer/Bot/Economy/PriceAnchor');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Kernel = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Stock = invoke('GameServer/Bot/Economy/CrafterStock');
const TableChannel = require('../src/GameServer/Bot/Population/ColdTableChannel');
const { BoardIndex, recordOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const { lineEvents, recordClosed } = require('../src/GameServer/Bot/Economy/MarketBuyerWaiters');

async function run() {
    await Database.init();
    await Seeder.ensureCraftServices();

    // 1. Every seat has its trader, standing in its town as a merchant that never hunts.
    const traders = [];
    for (const { slot, town } of SupplierRoles.SEATS) {
        const [character] = await Database.fetchCharacters(`bot_trade_${String(slot + 1).padStart(2, '0')}`);
        assert(character, `seat ${slot} (${town}) has its character`);
        const state = await LifeState.findByCharacterId(character.id);
        assert.equal(state.activity, 'merchant', `${town} trader is a merchant`);
        assert.equal(state.currentRegion, town, `${town} trader stands in its town`);
        assert.equal(state.spotId, null, `${town} trader has no hunting spot`);
        assert.deepEqual(state.stats.stationTrader, { slot, town });
        assert.equal(SupplierRoles.roleOf(state), 'trader');
        assert(Identity.isStaticService(state), `${town} trader is a static service (no clan, party or war)`);
        // The generated population's filters (party candidates, clan recruits, the
        // population counts) read generatedCold and the bot_pop_/bot_scale_ accounts.
        assert.notEqual(state.stats.generatedCold, true, `${town} trader is no generated population bot`);
        traders.push(state);
    }
    assert.equal(traders.length, 16, 'sixteen station traders');
    assert.equal(traders.filter(state => state.currentRegion === 'Giran').length, 3, 'three in Giran');
    const facts = { leaderParty: () => null };
    assert.equal(Kernel.lifecycleKind(traders[0], facts), 'event_driven', 'a trader steps only when woken');

    // 2. A second pass keeps the seats: no new bot.
    const again = await Seeder.ensureStationTraders();
    assert.equal(again.created, 0, 'a second pass creates no trader');

    // 3. A Giran trader's step stocks B/A gear on consignment and lists it in Giran.
    const giran = traders.find(state => state.currentRegion === 'Giran');
    const reviewed = await Cold.stationTraderReview(giran);
    const owed = Object.keys(reviewed.stats.gnomeStock || {}).map(Number);
    assert(owed.length > 0, 'the trader stocked gear on consignment');
    const lines = AfkTrade.boardIndex().ownerLines(Number(giran.characterId)).filter(line => line.storeType === 1);
    const gear = lines.filter(line => owed.includes(Number(line.selfId)));
    assert(gear.length > 0, `the trader lists its gear (lines ${JSON.stringify(lines.map(line => line.selfId))})`);
    const grades = new Map(Stock.townOffers(giran).map(offer => [offer.selfId, offer.grade]));
    for (const line of gear) {
        assert(['b', 'a'].includes(grades.get(Number(line.selfId))), `a Giran trader lists B/A gear (${line.selfId})`);
        const cost = reviewed.stats.gnomeStock[line.selfId].cost;
        assert(line.price >= cost && line.price <= Anchor.anchor(line.selfId),
            `ask ${line.price} within [cost ${cost}, anchor]`);
    }
    const shops = AfkTrade.ownerRecords(giran.characterId).filter(record => record.kind === 'shop');
    assert(shops.length && shops.every(record => record.town === 'Giran'), 'its shop stands in Giran');

    // 4. A trader whose only line sells out is woken and restocks. Its stock is held to one
    // B piece; a player buys it, the deal closes the emptied shop, and the worker's view of
    // that board change (lineEvents, recordClosed on the table's put and remove) raises
    // goal_done:line on it: a trader steps only when woken (event_driven), so the wake
    // starts its step at once. An hour on, that step lists another piece.
    const HOUR = 3600000;
    const seat = traders.filter(state => state.currentRegion === 'Giran')[1];
    const held = { ...seat, stats: { ...seat.stats, gnomeAllowance: { b: { pieces: 1, at: Date.now() }, a: { pieces: 0, at: Date.now() } } } };
    const stocked = await Cold.stationTraderReview(await LifeState.upsertState(held, 'test_one_piece'));
    const projection = AfkTrade.findOwnerProjection(stocked.characterId);
    const store = projection.actor.fetchPrivateStore();
    assert.equal(store.items.length, 1, `the trader lists its one piece (${JSON.stringify(store.items.map(line => line.selfId))})`);
    const [piece] = store.items;
    assert.equal(stocked.stats.gnomeStock[piece.selfId].owed, 1, 'the piece is owed to the store');
    const mirror = new BoardIndex();
    mirror.put(recordOf(projection.boardRow));
    const kernel = new Kernel.ColdSimulationKernel({ now: () => Date.now(),
        planLifecycle: ({ state }) => ({ plannedState: state }),
        resolveSolo: () => ({ patch: {}, events: [], materialize: { items: [] }, nextResolveAt: null }),
        emit: () => true });
    try {
        kernel.upsert({ ...stocked, timing: { ...stocked.timing, nextResolveAt: null } });
        const wake = (id, name) => kernel.situationWake(id, name);
        const changes = [], changed = TableChannel.shared.changed.bind(TableChannel.shared);
        TableChannel.shared.changed = (name, change) => { if (name === 'board') changes.push(change); return changed(name, change); };
        try {
            await Database.createAccount('trader_buyer', 'pw');
            const buyer = Number((await Database.createCharacter('trader_buyer', { name: 'TraderBuyer', race: 0, classId: 0,
                maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, locX: 83000, locY: 148000, locZ: -3466 })).insertId);
            await Database.setItem(buyer, { selfId: 57, name: 'Adena', amount: piece.price, equipped: false, enchant: 0, slot: 0 });
            await AfkTrade.buyFromShop(buyer, store, piece.selfId, 1, { lineId: piece.afkTradeLineId });
        } finally { TableChannel.shared.changed = changed; }
        assert.equal(AfkTrade.findOwnerProjection(stocked.characterId), null, 'the sold-out shop closed');
        for (const change of changes) {
            const key = change.removed === true ? change.key : change[0], previous = mirror.records.get(Number(key)) || [];
            if (change.removed === true) { mirror.remove(key); recordClosed(previous, wake); continue; }
            const record = recordOf(change);
            mirror.put(record);
            lineEvents(record, previous, mirror, wake);
        }
        assert(kernel.states.get(Number(stocked.characterId)).stepWake?.raises?.['goal_done:line'] !== undefined,
            'the sold-out line raises goal_done:line on the trader');
        assert(kernel.raiseWakeups.has(Number(stocked.characterId)), 'the wake starts the trader\'s step');
    } finally { await kernel.shutdown(); }
    const later = await LifeState.findByCharacterId(stocked.characterId);
    const aged = { ...later, stats: { ...later.stats, gnomeAllowance: { b: { pieces: 0, at: Date.now() - HOUR }, a: { pieces: 0, at: Date.now() } } } };
    const restocked = await Cold.stationTraderReview(await LifeState.upsertState(aged, 'test_an_hour_on'));
    const relisted = AfkTrade.findOwnerProjection(restocked.characterId)?.actor.fetchPrivateStore().items || [];
    assert(relisted.length > 0, 'the woken trader lists gear again');

    // 5. A trader at its owed limit whose pieces sold pays the store and restocks on its next
    // wake. A Dion trader stocks C gear to its owed limit (OWED_PIECES x its share) and lists
    // it; a player buys its shop out. The sale money waits on the board (board_settlements):
    // its wallet alone pays no piece, so a step that settled from its bag alone would pay
    // nothing, stock nothing (still at the limit) and never be woken again. Its next step
    // (PopulationService.resolveColdState, as a wake runs it) takes that money first, pays
    // each sold piece and stocks again.
    const ownedUnits = state => Object.values(state.stats.gnomeStock || {}).reduce((sum, row) => sum + Number(row.owed || 0), 0);
    const settlements = async id => Number((await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS amount FROM board_settlements WHERE ownerId = ? AND selfId = 57', [id]]))[0].amount);
    const limit = Math.floor(12 * SupplierRoles.ROLES.trader.share);
    const dion = traders.find(state => state.currentRegion === 'Dion');
    const full = await Cold.stationTraderReview(await LifeState.upsertState({ ...dion, stats: { ...dion.stats,
        gnomeAllowance: { c: { pieces: limit, at: Date.now() } } } }, 'test_owed_limit'));
    assert.equal(ownedUnits(full), limit, `the trader stocks up to its owed limit (${JSON.stringify(full.stats.gnomeStock)})`);
    const wallet = Number(full.adena || 0);
    const dionStore = () => AfkTrade.findOwnerProjection(full.characterId)?.actor.fetchPrivateStore();
    const sold = dionStore().items.map(line => ({ selfId: Number(line.selfId), price: Number(line.price), count: Number(line.count) }));
    // C4 (PrivateStoreLimits): a sell store holds 3 lines, +1 for a dwarf; no class learns Expand Trade.
    assert.equal(sold.length, 4, 'the dwarf trader\'s shop holds four lines (3 + 1 for a dwarf)');
    assert(sold.every(line => Number(full.stats.gnomeStock[line.selfId].cost) > wallet), 'its wallet alone pays no sold piece');
    await Database.createAccount('trader_buyer_two', 'pw');
    const buyer = Number((await Database.createCharacter('trader_buyer_two', { name: 'TraderBuyerTwo', race: 0, classId: 0,
        maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, locX: 15600, locY: 142800, locZ: -2700 })).insertId);
    const takings = sold.reduce((sum, line) => sum + line.price * line.count, 0);
    await Database.setItem(buyer, { selfId: 57, name: 'Adena', amount: takings, equipped: false, enchant: 0, slot: 0 });
    for (const line of sold) {
        const store = dionStore(), item = store.items.find(row => Number(row.selfId) === line.selfId);
        await AfkTrade.buyFromShop(buyer, store, line.selfId, line.count, { lineId: item.afkTradeLineId });
    }
    assert.equal(await settlements(full.characterId), takings, 'the sale money waits on the board');
    const due = sold.reduce((sum, line) => sum + Number(full.stats.gnomeStock[line.selfId].cost) * line.count, 0);
    const woken = await LifeState.findByCharacterId(full.characterId);
    const step = await invoke('GameServer/Bot/Population/PopulationService').resolveColdState(await LifeState.upsertState({ ...woken,
        stats: { ...woken.stats, gnomeAllowance: { c: { pieces: 0, at: Date.now() - HOUR } } } }, 'test_next_wake'));
    assert.equal(step.ok, true, 'the trader steps');
    assert.equal(await settlements(full.characterId), 0, 'the step takes the sale money into its bag');
    const after = await LifeState.findByCharacterId(full.characterId);
    assert.equal(Number(after.adena), wallet + takings - due, 'the store is paid each sold piece\'s cost from the takings');
    assert(ownedUnits(after) > ownedUnits(full) - sold.reduce((sum, line) => sum + line.count, 0), 'paid, the trader stocks again');
    assert((dionStore()?.items || []).length > 0, 'and lists its new stock');
    console.log('PASS station trader seed: sixteen traders stand in their towns, a Giran trader lists its B/A gear, a sold-out trader is woken and restocks, and a trader at its owed limit pays from its sales and restocks on its next wake');
}

run().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
