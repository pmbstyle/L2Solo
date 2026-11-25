'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('companion-unload');
require('../src/Global');
fixture.assertConfigured(options.default);

const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Native = require('./helpers/nativeMarketFixture');
const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const World = invoke('GameServer/World/World');
const Cleanup = invoke('GameServer/Bot/AI/CompanionInventoryCleanup');
const Following = invoke('GameServer/Bot/AI/States/FollowingState');
const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
const Catalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');
const Buffs = invoke('GameServer/Bot/AI/BotBuffs');
const Chat = invoke('GameServer/Bot/AI/BotPartyChat');
const TownChat = invoke('GameServer/Bot/AI/TownChatter');
const Travel = invoke('GameServer/Bot/AI/BotTownTravel');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Trade = invoke('GameServer/Bot/BotTradeService');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
Data.init();
let nextId = 971000;
const townPoint = { locX: -12736, locY: 122816, locZ: -3112 };
const fieldPoint = { ...townPoint, locZ: -7500 };
function item(selfId, amount, extras = {}) {
    const template = Data.items.find(row => row.selfId === selfId);
    return new Item(++nextId, { ...utils.crushOb(template), amount, ...extras });
}
function owner(items, maximum = 20000) {
    const actor = { fetchId: () => 971001, fetchName: () => 'Overloaded companion', fetchClassId: () => 0,
        fetchLevel: () => 20, fetchRace: () => 0, fetchMaxLoad: () => maximum,
        fetchHp: () => 100, fetchMaxHp: () => 100, fetchHead: () => 0,
        position: townPoint, fetchLocX() { return this.position.locX; },
        fetchLocY() { return this.position.locY; }, fetchLocZ() { return this.position.locZ; },
        fetchIsOnline: () => true, isDead: () => false, fetchKarma: () => 0,
        backpack: new Backpack({ items: [], paperdoll: {} }),
        state: { seated: true, fetchSeated() { return this.seated; }, setSeated(value) { this.seated = value; },
            fetchTowards: () => false, fetchHits: () => false, fetchCasts() { return !!this.casting; },
            setCasts(value) { this.casting = value; }, fetchAnimated: () => false, setAnimated() {} },
        automation: { abortAll() {} }, unselect() {}, moves: [], moveTo(move) { this.moves.push(move); } };
    actor.backpack.items = items;
    const leader = { actor: { fetchId: () => 971002, fetchIsOnline: () => true,
        fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        position: fieldPoint, fetchLocX() { return this.position.locX; },
        fetchLocY() { return this.position.locY; }, fetchLocZ() { return this.position.locZ; } } };
    const session = { actor, partyCompanion: true, followPlayerSession: leader, plan: 'following',
        dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    actor.session = session;
    return { actor, session, leader };
}
const target = { actorId: 90001, npcSelfId: 3001, name: 'Warehouse Keeper',
    town: 'Gludio', serviceRole: 'warehouse', ...townPoint };
const town = { name: target.town, x: townPoint.locX, y: townPoint.locY, z: townPoint.locZ };
const BotAI = { getClosestTown: () => town };
const restores = [];
function replace(object, key, value) {
    const previous = object[key]; restores.push(() => { object[key] = previous; }); object[key] = value;
}
function shopping(probe) {
    probe.session.plan = 'shopping';
    probe.session.companionShopping = { kind: 'unload_inventory', target, town };
    probe.session.shoppingTarget = target;
    probe.session.shoppingServicePhase = 'warehouse';
    probe.session.resumeAfterShopping = { followPlayerSession: probe.leader };
}

(async () => {
    try {
        replace(Catalog, 'targetFor', () => target);
        replace(Buffs, 'needsNewbieRefresh', () => false);
        const announcements = [];
        let chatAvailable = true;
        replace(Chat, 'announce', (_session, entry) => {
            if (!chatAvailable) return false;
            announcements.push(entry);
            return true;
        });
        replace(TownChat, 'say', () => true);
        replace(World, 'refreshPartyMemberships', () => 0);
        replace(World, 'npc', { spawns: [{ fetchId: () => target.actorId, fetchSelfId: () => target.npcSelfId,
            fetchTitle: () => 'Warehouse Keeper', fetchLocX: () => target.locX, fetchLocY: () => target.locY }] });
        const worn = item(347, 1, { equipped: true }), shots = item(1835, 10000);
        const quest = item(1865, 10, { kind: 'Other.Quest' }), locked = item(1867, 10); locked.petInUse = true;
        const probe = owner([worn, shots, quest, locked, item(57, 100000)]);
        const beforeLoad = probe.actor.backpack.fetchTotalLoad();
        assert(beforeLoad > probe.actor.fetchMaxLoad());
        let requested = null;
        replace(Travel, 'request', (...args) => { requested = args; return 'walk'; });
        const context = { ...probe, bot: probe.actor, BotAI, playerSession: probe.leader,
            player: probe.leader.actor, role: 'dps', partyThreat: null, leaderTargetId: null };
        probe.actor.position = fieldPoint;
        assert.equal(Following.tickInventoryCleanup(context), false, 'a companion stays with the player in the field');
        probe.leader.actor.position = townPoint;
        assert.equal(Following.tickInventoryCleanup(context), false, 'the companion must reach town with the player first');
        probe.actor.position = townPoint;
        probe.session.activeTrade = {};
        assert.equal(Cleanup.errand(probe.session, probe.actor, BotAI), null, 'never leave an active player trade');
        delete probe.session.activeTrade;
        assert.equal(Following.tickInventoryCleanup({ ...context, partyThreat: {} }), false, 'combat defers the warehouse trip');
        assert.equal(Following.tickInventoryCleanup({ ...context, pulling: { target: {} } }), false, 'do not abandon an active pull');
        const companions = invoke('GameServer/Bot/AI/PartyCompanionService');
        const regroupActive = companions.regroupActive;
        companions.regroupActive = () => true;
        try { assert.equal(Following.tickInventoryCleanup(context), false, 'Regroup holds the town unload'); }
        finally { companions.regroupActive = regroupActive; }
        assert.equal(probe.session.plan, 'following');
        const acted = Following.tickInventoryCleanup(context);
        assert.equal(acted, true);
        assert.equal(probe.session.plan, 'shopping');
        assert.equal(probe.actor.state.seated, false, 'stand up to unload even when the party was resting');
        assert.equal(probe.session.companionShopping.kind, 'unload_inventory');
        assert.equal(probe.session.shoppingServicePhase, 'warehouse');
        assert.equal(probe.session.followPlayerSession, probe.leader);
        assert.equal(requested, null, 'an in-town player companion starts a local visit, with no town travel');

        probe.leader.actor.position = fieldPoint;
        let aborted = 0;
        probe.actor.automation.abortAll = () => { aborted++; };
        probe.session.townEscape = {};
        probe.actor.state.setCasts(true);
        Shopping.tick(probe.session, probe.actor, {}, BotAI);
        assert.equal(probe.session.plan, 'following', 'when the player leaves town the ongoing unload is cancelled');
        assert.equal(probe.session.shoppingTarget, undefined);
        assert.equal(probe.session.townEscape, undefined);
        assert.equal(probe.actor.state.fetchCasts(), false);
        assert.equal(aborted, 1);
        assert.deepEqual(probe.actor.moves, []);

        for (const kind of ['sell_junk', 'sell_resources', 'sell_unused_arrows', 'restock_shots']) {
            probe.session.plan = 'shopping';
            probe.session.companionShopping = { kind };
            probe.session.shoppingTarget = target;
            Shopping.tick(probe.session, probe.actor, {}, BotAI);
            assert.equal(probe.session.plan, 'following', `${kind} stops before retrying a merchant outside the party's town visit`);
        }
        assert.deepEqual(probe.actor.moves, []);

        probe.actor.position = fieldPoint;
        probe.leader.accountId = 'bot_unload_leader';
        assert.equal(Following.tickInventoryCleanup(context), true, 'bot-led parties still start a field unload');
        assert.equal(requested[4].allowCompanion, true);
        assert.equal(requested[4].preserveShoppingTarget, true);

        const pack = owner([], 1000);
        let load = 0;
        pack.actor.backpack.fetchTotalLoad = () => load;
        const notice = (value) => {
            load = value;
            Cleanup.announceCapacity(pack.session, pack.actor);
        };
        announcements.length = 0;
        notice(600);
        assert.equal(announcements.length, 0, 'exactly 60% does not prompt an unload');
        chatAvailable = false;
        notice(610);
        chatAvailable = true;
        for (const value of [610, 690, 700, 710, 800, 900, 1000, 1100, 990, 1000]) notice(value);
        assert.deepEqual(announcements.map(({ key }) => Number(key.split(':').at(-1))), [60, 70, 80, 90, 100]);
        assert(announcements.every(({ text }) => text.includes('Can we head to town so I can unload?')));
        notice(500);
        pack.actor.backpack.items = Array.from({ length: 49 }, () => item(347, 1));
        pack.leader.actor.position = townPoint;
        notice(0);
        assert.equal(announcements.length, 5, 'a player in town is not asked to head to town');
        pack.leader.actor.position = fieldPoint;
        notice(0);
        assert.match(announcements.at(-1).text, /61% of my inventory slots/, 'after unloading, slot pressure can start a new warning cycle');
        pack.leader.accountId = 'bot_pack_leader';
        notice(1000);
        assert.equal(announcements.length, 6, 'bot parties do not ask a player for a town trip');

        const immovable = owner([item(347, 1, { equipped: true })], 10000);
        immovable.leader.actor.position = townPoint;
        assert.equal(Cleanup.errand(immovable.session, immovable.actor, BotAI), null);
        assert(immovable.session.companionUnloadRetryAt > Date.now(), 'an unfixable bag must not loop through town');
        const arrows = owner([item(1341, 5000), item(1864, 4000)]);
        arrows.leader.actor.position = townPoint;
        assert.equal(Cleanup.errand(arrows.session, arrows.actor, BotAI)?.kind, 'sell_unused_arrows');
        const sale = Disposition.unusedArrowCandidates;
        Disposition.unusedArrowCandidates = () => [];
        try {
            assert.equal(Cleanup.errand(arrows.session, arrows.actor, BotAI)?.kind, 'unload_inventory',
                'arrows the NPC sale would not take send the companion to the warehouse, not to the merchant again');
        } finally { Disposition.unusedArrowCandidates = sale; }
        const light = owner([item(1835, 10)]);
        assert.equal(Cleanup.errand(light.session, light.actor, BotAI), null);
        assert.equal(light.session.plan, 'following');

        const reserved = item(1865, 500), protectedProbe = owner([reserved], 100);
        assert(Warehouse.hasActorDepositCandidates(protectedProbe.actor, { inventory: {}, stats: {} }, null, { unload: true }));
        replace(Disposition, 'unreservedActorItems', (_state, items) => items.filter(item => item !== reserved));
        assert(!Warehouse.hasActorDepositCandidates(protectedProbe.actor, { inventory: {}, stats: {} }, null, { unload: true }),
            'preserve materials committed to crafting or another owner');

        // Native SQLite transfer: retain exact quantities and metadata across
        // a reopen, including personal shots that normal sales keep entirely.
        await Database.init();
        await Native.character(Database, 971001, 'UnloadCompanion', 'unload_companion');
        await Database.setItem(971001, { selfId: 1835, amount: 10000 });
        await Database.setItem(971001, { selfId: 347, amount: 1, equipped: true, slot: 10 });
        const actual = owner([]);
        actual.actor.backpack = new Backpack({ items: await Database.fetchItems(971001), paperdoll: {} });
        shopping(actual);
        const startingShots = 10000;
        await Shopping.depositAtWarehouse(actual.session, actual.actor, {}, BotAI, target);
        assert.equal(actual.session.plan, 'following');
        assert.equal(actual.session.followPlayerSession, actual.leader);
        assert.equal(actual.session.companionShopping, undefined);
        assert(actual.actor.backpack.fetchTotalLoad() < actual.actor.fetchMaxLoad() / 2);
        assert.equal(actual.actor.moves.at(-1).to.locX, actual.leader.actor.fetchLocX(), 'return to the current leader location');
        const carried = actual.actor.backpack.fetchItemFromSelfId(1835).fetchAmount();
        const stored = await Database.fetchWarehouseItems(971001);
        assert.equal(carried + stored.find(row => row.selfId === 1835).amount, startingShots);
        assert(actual.actor.backpack.fetchItems().some(item => item.fetchEquipped()), 'do not store equipped armor');
        await Database.close(); await Database.init();
        assert.equal((await Database.fetchItems(971001)).find(row => row.selfId === 1835).amount, carried);
        assert.equal((await Database.fetchWarehouseItems(971001)).find(row => row.selfId === 1835).amount, startingShots - carried);
        const unavailable = owner([item(1835, 10000)]);
        shopping(unavailable);
        const savedNpcs = World.npc;
        World.npc = { spawns: [] };
        await Shopping.depositAtWarehouse(unavailable.session, unavailable.actor, {}, BotAI, target);
        World.npc = savedNpcs;
        assert.equal(unavailable.session.plan, 'following', 'an unavailable warehouse releases the shopping action');
        assert(unavailable.session.companionUnloadRetryAt > Date.now(), 'failed storage backs off instead of repeating the trip');
        assert.equal(unavailable.actor.backpack.fetchItemFromSelfId(1835).fetchAmount(), 10000, 'failed storage keeps the original items');

        // The trade weight guard runs again inside the native transaction:
        // losing capacity while the character flush waits must write nothing.
        await Native.character(Database, 971002, 'UnloadLeader', 'unload_leader');
        await Database.setItem(971002, { selfId: 1835, amount: 100 });
        const donor = owner([]);
        donor.actor.fetchId = () => 971002;
        donor.actor.backpack = new Backpack({ items: await Database.fetchItems(971002), paperdoll: {} });
        donor.session.accountId = 'player_unload_leader';
        donor.session.partyCompanion = false;
        actual.session.accountId = 'bot_unload_companion';
        actual.session.followPlayerSession = donor.session;
        actual.actor.fetchMaxLoad = () => 100000;
        assert(Trade.startPlayerTrade(donor.session, actual.session).ok);
        assert(Trade.addItem(donor.session, donor.actor.backpack.fetchItemFromSelfId(1835).fetchId(), 20).ok);
        let finishTrade, entered = false;
        const tradeGate = new Promise(resolve => { finishTrade = resolve; });
        const nativeTrade = Database.transferInventoryBetweenCharacters;
        replace(Database, 'transferInventoryBetweenCharacters', async (...args) => {
            entered = true; await tradeGate; return nativeTrade.apply(Database, args);
        });
        const committing = Trade.commit(donor.session);
        await Promise.resolve();
        assert(entered, 'preflight admits the trade before the delayed native transaction');
        actual.actor.fetchMaxLoad = () => actual.actor.backpack.fetchTotalLoad() + 79;
        finishTrade();
        assert.equal((await committing).reason, 'inventory_weight');
        assert.equal((await Database.fetchItems(971002)).find(row => row.selfId === 1835).amount, 100);
        assert.equal((await Database.fetchItems(971001)).find(row => row.selfId === 1835).amount, carried);
        Trade.cancel(donor.session, 'test_cleanup', false);

        // A native write can wait behind a flush. Revalidate ownership and NPC
        // proximity inside its transaction before moving either side.
        const interrupted = owner([item(1835, 10000)]);
        shopping(interrupted);
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const transfer = Database.transferInventoryToWarehouse;
        replace(Database, 'transferInventoryToWarehouse', async (...args) => { await gate; return transfer.apply(Database, args); });
        const pending = Warehouse.depositActorAtWarehouse(interrupted.actor, { inventory: {}, stats: {} }, interrupted.session, target, { unload: true });
        for (let tick = 0; tick < 20; tick++) await new Promise(resolve => setImmediate(resolve));
        interrupted.session.actor = light.actor;
        release();
        await assert.rejects(pending, /warehouse_actor_changed/);
        assert.equal((await Database.fetchWarehouseItems(971001)).find(row => row.selfId === 1835).amount, startingShots - carried);
        console.log('Companion unload: player town boundaries, bot-party field departures, inventory warnings and native warehouse transfers passed');
    } finally {
        restores.reverse().forEach(restore => restore());
        await Database.close();
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
