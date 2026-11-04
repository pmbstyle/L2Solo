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
Data.init();
let nextId = 971000;
function item(selfId, amount, extras = {}) {
    const template = Data.items.find(row => row.selfId === selfId);
    return new Item(++nextId, { ...utils.crushOb(template), amount, ...extras });
}
function owner(items, maximum = 20000) {
    const actor = { fetchId: () => 971001, fetchName: () => 'Overloaded companion', fetchClassId: () => 0,
        fetchLevel: () => 20, fetchRace: () => 0, fetchMaxLoad: () => maximum,
        fetchHp: () => 100, fetchMaxHp: () => 100, fetchHead: () => 0,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchIsOnline: () => true, isDead: () => false, fetchKarma: () => 0,
        backpack: new Backpack({ items: [], paperdoll: {} }),
        state: { seated: true, fetchSeated() { return this.seated; }, setSeated(value) { this.seated = value; },
            fetchTowards: () => false, fetchHits: () => false, fetchCasts: () => false },
        automation: { abortAll() {} }, unselect() {}, moves: [], moveTo(move) { this.moves.push(move); } };
    actor.backpack.items = items;
    const leader = { actor: { fetchId: () => 971002, fetchIsOnline: () => true,
        fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        fetchLocX: () => 20000, fetchLocY: () => 0, fetchLocZ: () => 0 } };
    const session = { actor, partyCompanion: true, followPlayerSession: leader, plan: 'following',
        dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    actor.session = session;
    return { actor, session, leader };
}
const target = { actorId: 90001, npcSelfId: 3001, name: 'Warehouse Keeper',
    town: 'Talking Island', serviceRole: 'warehouse', locX: 0, locY: 0, locZ: 0 };
const town = { name: target.town, x: 0, y: 0, z: 0 };
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
        replace(Chat, 'announce', () => true);
        replace(TownChat, 'say', () => true);
        replace(World, 'refreshPartyMemberships', () => 0);
        replace(World, 'npc', { spawns: [{ fetchId: () => target.actorId, fetchSelfId: () => target.npcSelfId,
            fetchTitle: () => 'Warehouse Keeper', fetchLocX: () => 0, fetchLocY: () => 0 }] });
        const worn = item(347, 1, { equipped: true }), shots = item(1835, 10000);
        const quest = item(1865, 10, { kind: 'Other.Quest' }), locked = item(1867, 10); locked.petInUse = true;
        const probe = owner([worn, shots, quest, locked, item(57, 100000)]);
        const beforeLoad = probe.actor.backpack.fetchTotalLoad();
        assert(beforeLoad > probe.actor.fetchMaxLoad());
        const planned = Cleanup.plan(probe.actor);
        assert(planned.length);
        assert(planned.every(row => row.source === shots), 'worn gear, quest items, pet-locked items and money stay owned in the bag');
        const removed = planned.reduce((sum, row) => sum + row.amount * row.source.fetchMass(), 0);
        assert(beforeLoad - removed < 10000, 'deposit enough to clear the first native weight penalty');
        assert(planned[0].amount < shots.fetchAmount(), 'keep combat ammunition');
        assert.equal(probe.actor.backpack.fetchTotalLoad(), beforeLoad, 'planning does not mutate items');
        assert.equal(Cleanup.errand(probe.session, probe.actor, BotAI).kind, 'unload_inventory', 'field followers may leave for the warehouse');
        probe.session.activeTrade = {};
        assert.equal(Cleanup.errand(probe.session, probe.actor, BotAI), null, 'never leave an active player trade');
        delete probe.session.activeTrade;

        // Execute the real FollowingState admission, retaining party identity
        // and the existing native travel owner rather than teleporting here.
        let requested = null;
        replace(Travel, 'request', (...args) => { requested = args; return 'walk'; });
        const context = { ...probe, bot: probe.actor, BotAI, playerSession: probe.leader,
            player: probe.leader.actor, role: 'dps', partyThreat: null, leaderTargetId: null };
        assert.equal(Following.tickInventoryCleanup({ ...context, partyThreat: {} }), false, 'combat defers the warehouse trip');
        assert.equal(Following.tickInventoryCleanup({ ...context, pulling: { target: {} } }), false, 'do not abandon an active pull');
        assert.equal(probe.session.plan, 'following');
        const acted = Following.tickInventoryCleanup(context);
        assert.equal(acted, true);
        assert.equal(probe.session.plan, 'shopping');
        assert.equal(probe.actor.state.seated, false, 'stand up to unload even when the party was resting');
        assert.equal(probe.session.companionShopping.kind, 'unload_inventory');
        assert.equal(probe.session.shoppingServicePhase, 'warehouse');
        assert.equal(probe.session.followPlayerSession, probe.leader);
        assert.equal(requested[4].allowCompanion, true);
        assert.equal(requested[4].preserveShoppingTarget, true);

        const immovable = owner([item(347, 1, { equipped: true })], 10000);
        assert.deepEqual(Cleanup.plan(immovable.actor), []);
        assert.equal(Cleanup.errand(immovable.session, immovable.actor, BotAI), null);
        assert(immovable.session.companionUnloadRetryAt > Date.now(), 'an unfixable bag must not loop through town');
        const light = owner([item(1835, 10)]);
        assert.equal(Cleanup.errand(light.session, light.actor, BotAI), null);
        assert.equal(light.session.plan, 'following');

        const reserved = item(1865, 500), free = item(1835, 6000), protectedProbe = owner([reserved, free]);
        replace(Disposition, 'unreservedActorItems', (_state, items) => items.filter(item => item !== reserved));
        assert(Cleanup.plan(protectedProbe.actor, { inventory: {}, stats: {} }).every(row => row.source !== reserved),
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
        const pending = Cleanup.deposit(interrupted.session, interrupted.actor, target);
        await Promise.resolve(); await Promise.resolve();
        interrupted.session.actor = light.actor;
        release();
        await assert.rejects(pending, /companion_unload_interrupted/);
        assert.equal((await Database.fetchWarehouseItems(971001)).find(row => row.selfId === 1835).amount, startingShots - carried);
        console.log('Companion unload: field departure, protected inventory, partial shot storage, native SQLite conservation/reopen, leader return and interrupted writes passed');
    } finally {
        restores.reverse().forEach(restore => restore());
        await Database.close();
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
