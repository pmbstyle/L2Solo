'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('bot-arrow-cleanup');
require('../src/Global');
fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Arrows = invoke('GameServer/Inventory/ArrowStock');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Policy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const Listing = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const Cleanup = invoke('GameServer/Bot/AI/CompanionInventoryCleanup');
const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const AfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Catalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');
const TownChat = invoke('GameServer/Bot/AI/TownChatter');
const World = invoke('GameServer/World/World');
const Backpack = invoke('GameServer/Actor/Backpack');
const Native = require('./helpers/nativeMarketFixture');
const Rules = invoke('GameServer/Items/NpcSellRules');
Data.init();
const arrowIds = [17, 1341, 1342, 1343, 1344, 1345];
const stack = (selfId, amount) => ({ selfId, amount, stackable: true,
    name: Data.items.find(item => item.selfId === selfId).template.name, kind: 'Other.Arrow' });
const bowTemplate = rank => Data.items.find(item => item.template?.kind === 'Weapon.Bow' && item.etc?.rank === rank);
function equippedBow(rank) {
    const item = bowTemplate(rank);
    return { selfId: item.selfId, amount: 1, equipped: true, equippedCount: 1,
        equippedSlots: [14], slot: 14, stackable: false, kind: 'Weapon.Bow', rank };
}
const state = (classId, inventory) => ({ characterId: 972001, level: 52, phase: 'cold', activity: 'shopping',
    vitals: { hp: 100, mp: 100 }, adena: 100, currentRegion: 'Giran', homeRegion: 'Giran',
    loc: { locX: 83000, locY: 148000, locZ: -3400 }, party: { partyId: null }, inventory,
    stats: { classId, marketSellRetryAfter: Date.now() + 1800000 } });
const restores = [];
function replace(object, key, value) { const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value; }
async function persisted(id, classId, amount = 5000) {
    await Native.character(Database, id, `Arrow${id}`, `bot_arrow_${id}`);
    await Database.execute(['UPDATE characters SET classId=?,level=52 WHERE id=?', [classId,id]]);
    await Database.setItem(id, { selfId: 57, amount: 100 });
    await Database.setItem(id, { selfId: 1341, amount });
    if (classId === 9) await Database.setItem(id, { selfId: bowTemplate('d').selfId, amount: 1, equipped: true, slot: 14 });
    return Life.upsertState({ ...state(classId, Life.inventorySummaryFromItems(await Database.fetchItems(id))),
        characterId: id, name: `Arrow${id}`, accountName: `bot_arrow_${id}` }, 'arrow_fixture');
}
function companion(saved) {
    const actor = { fetchId: () => saved.characterId, fetchClassId: () => saved.stats.classId, fetchLevel: () => 52,
        fetchName: () => saved.name, fetchRace: () => 0, fetchKarma: () => 0, fetchMaxLoad: () => 20000,
        fetchLocX: () => 83000, fetchLocY: () => 148000, fetchLocZ: () => -3400,
        isDead: () => false, fetchIsOnline: () => true,
        state: { fetchHits: () => false }, moves: [], moveTo(move) { this.moves.push(move); } };
    const leader = { actor: { fetchIsOnline: () => true, fetchLocX: () => 83500, fetchLocY: () => 148000, fetchLocZ: () => -3400 } };
    const session = { actor, botSession: true, accountId: saved.accountName, coldLifeState: saved,
        plan: 'shopping', partyCompanion: true, followPlayerSession: leader,
        resumeAfterShopping: { followPlayerSession: leader }, dataSendToMe() {} };
    actor.session = session;
    return { actor, session, leader };
}

(async () => {
    try {
        for (const classId of [0, 14, 20, 40, 41, 43, 51, 55, 57]) {
            const bag = Object.fromEntries(arrowIds.map(id => [id, stack(id, 5000)]));
            const caster = state(classId, bag);
            caster.stats.role = 'archer';
            assert.equal(Arrows.keeps(caster), false, 'a saved party role cannot make this class an archer');
            const sale = Disposition.unusedArrowCandidates(caster);
            assert.deepEqual(sale.map(item => item.selfId).sort((a,b) => a-b), arrowIds);
            assert(sale.every(item => item.count === 5000), 'non-archers sell every unreserved arrow');
            for (const item of sale) {
                assert.equal(Policy.classify(caster, item).action, 'npc');
                assert.equal(Disposition.isWarehouseCandidate({ ...item, amount: item.count }), false);
            }
        }
        for (const classId of [9, 24, 37, 92, 102, 109]) {
            const bow = equippedBow('c');
            const archer = state(classId, { ...Object.fromEntries(arrowIds.map(id => [id, stack(id, 5000)])), [bow.selfId]: bow });
            assert.equal(Roles.inferRole(archer), 'archer');
            const sale = Disposition.unusedArrowCandidates(archer);
            assert.equal(sale.find(item => item.selfId === 1342).count, 3000, 'a C bow retains at most 2000 fine steel arrows');
            assert(sale.filter(item => item.selfId !== 1342).every(item => item.count === 5000), 'every other grade is sold');
            assert.equal(Policy.classify(archer, { ...stack(1341, 5000), count: 5000 }).action, 'npc');
            const protectedStock = { ...archer, inventory: { [bow.selfId]: bow, 1342: stack(1342, 1000) } };
            assert.equal(await Life.applyNpcLiquidation(protectedStock, [{ selfId: 1342, count: 1000, npcPrice: 2 }]), protectedStock,
                'a stale sale proposal cannot liquidate the compatible working stock');
        }
        for (const classId of [7, 22, 35]) {
            const paths = new Set();
            for (let id = 1; id <= 100; id++) {
                const scout = { ...state(classId, { 1341: stack(1341, 100) }), characterId: id, level: 30 };
                const role = Roles.inferRole(scout); paths.add(role);
                assert.equal(Arrows.keeps(scout), role === 'archer', 'split scout classes use their own combat kit');
            }
            assert(paths.has('archer') && paths.has('dagger'));
        }
        const now = Date.now();
        for (const classId of [40, 9]) {
            const value = state(classId, { 17: stack(17, 100) });
            if (classId === 9) { const bow = equippedBow('none'); value.inventory[bow.selfId] = bow; }
            const floor = Floor.forState(value, now, { items: Data.items,
                maxLoad: Floor.stateInventory(value, Data.items).load * 1.8 });
            assert.equal(floor?.reason, classId === 40 ? 'overweight' : undefined,
                'a sale retry cannot postpone unused arrows at the first weight penalty');
        }

        await Database.init(); await Life.init();
        const cold = await persisted(972011, 40);
        assert.equal(Floor.bagFor(cold), null, 'fixture has a sale pause and no weight floor');
        const price = Rules.npcBuyPrice(Data.items.find(item => item.selfId === 1341).template.price);
        const sold = await Listing.open(cold, { now, town: 'Giran' });
        assert.equal(sold.reason, 'sell_retry_cleanup');
        assert.equal(Native.amount(await Database.fetchItems(cold.characterId), 1341), 0,
            'cold bots sell unused arrows at the NPC even during the sale cooldown');
        assert.equal(Native.amount(await Database.fetchItems(cold.characterId), 57), 100 + 5000 * price);
        assert.equal(Native.amount(await Database.fetchWarehouseItems(cold.characterId), 1341), 0);
        assert.equal(sold.state.stats.marketSellRetryAfter, cold.stats.marketSellRetryAfter, 'keep the unrelated market cooldown');
        const bow = await persisted(972012, 9);
        assert.equal((await Listing.open(bow, { now })).reason, 'sell_retry_cleanup');
        assert.equal(Native.amount(await Database.fetchItems(bow.characterId), 1341), 2000);

        const ordinary = await persisted(972015, 9);
        replace(invoke('GameServer/Bot/Economy/BotImprovementService'), 'inTown', () => true);
        replace(AfkMarket, 'canTradeRemotely', () => true);
        replace(AfkMarket, 'reconcile', () => { throw Error('remote showcase cannot replace physical arrow cleanup'); });
        const ordinaryIntent = Population.marketListingIntent(ordinary, { type: 'buy_craft_material' });
        assert.equal(ordinaryIntent.cleanup.cleanupReason, 'unused_arrows', 'every physical town visit clears surplus arrows regardless of its original goal');
        const worn = { ...ordinary, inventory: { ...ordinary.inventory,
            1341: { ...ordinary.inventory[1341], equipped: true, equippedCount: ordinary.inventory[1341].amount } } };
        assert(Arrows.unused(worn).length, 'the raw count still sees surplus');
        assert.equal(Population.marketListingIntent(worn, { type: 'buy_craft_material' }).cleanup, undefined,
            'arrows the NPC sale would not take make no cleanup visit (trigger and sale read one list)');
        await Population.openMarketListing(ordinaryIntent, { type: 'buy_craft_material' });
        assert.equal(Native.amount(await Database.fetchItems(ordinary.characterId), 1341), 2000,
            'an existing remote storefront cannot bypass the NPC cleanup');

        const hot = await persisted(972013, 40);
        const probe = companion(hot);
        probe.actor.backpack = new Backpack({ items: await Database.fetchItems(hot.characterId), paperdoll: {} });
        probe.actor.fetchMaxLoad = () => 50000;
        assert.equal(Floor.forActor(probe.actor, { ...hot, inventory: {} }).reason, 'overweight',
            'hot cleanup reads newly acquired arrows from the live bag during a sale pause');
        const target = { actorId: 973001, npcSelfId: 7001, name: 'Trader', serviceRole: 'generic_merchant',
            town: 'Giran', locX: 83000, locY: 148000, locZ: -3400 };
        replace(Catalog, 'targetFor', (role) => { assert.equal(role, Catalog.ROLES.GENERIC_MERCHANT); return target; });
        replace(World, 'npc', { spawns: [{ fetchId: () => target.actorId, fetchSelfId: () => target.npcSelfId,
            fetchTitle: () => 'Trader', fetchLocX: () => target.locX, fetchLocY: () => target.locY }] });
        replace(World, 'refreshPartyMemberships', () => 0);
        replace(TownChat, 'say', () => true);
        assert.deepEqual(Cleanup.plan(probe.actor, hot), [], 'unused arrows never become warehouse deposits');
        const errand = Cleanup.errand(probe.session, probe.actor, { getClosestTown: () => ({ name: 'Giran' }) });
        assert.equal(errand.kind, 'sell_unused_arrows');
        probe.session.companionShopping = errand; probe.session.shoppingTarget = target;
        await Shopping.sellAndRestock(probe.session, probe.actor, {}, {});
        assert.equal(probe.actor.backpack.fetchItemFromSelfId(1341), undefined);
        assert.equal(probe.actor.backpack.fetchTotalAdena(), 100 + 5000 * price);
        assert.equal(probe.session.plan, 'following');
        assert.equal(probe.actor.moves.at(-1).to.locX, probe.leader.actor.fetchLocX());
        assert.equal(Native.amount(await Database.fetchWarehouseItems(hot.characterId), 1341), 0);

        const lightArcher = await persisted(972016, 9);
        const light = companion(lightArcher);
        light.actor.backpack = new Backpack({ items: await Database.fetchItems(lightArcher.characterId), paperdoll: {} });
        light.actor.fetchMaxLoad = () => 10000;
        light.session.companionShopping = { kind: 'sell_unused_arrows', target };
        light.session.shoppingTarget = target;
        assert.equal(Arrows.keptAmounts(light.actor)[1341], 625,
            'the live load limit leaves less room than the cold profile and the 2000-unit cap');
        await Shopping.sellAndRestock(light.session, light.actor, {}, {});
        assert.equal(Native.amount(await Database.fetchItems(lightArcher.characterId), 1341), 625,
            'native companion cleanup uses the live capacity rather than retaining 2000 arrows');
        assert.equal(light.actor.backpack.fetchItemFromSelfId(1341).fetchAmount(), 625);
        assert(light.actor.backpack.fetchTotalLoad() < light.actor.fetchMaxLoad() / 2,
            'the sale clears the first weight penalty');
        assert.equal(Native.amount(await Database.fetchItems(lightArcher.characterId), 57), 100 + 4375 * price);
        assert.equal(light.session.plan, 'following');
        assert.equal(light.session.companionUnloadRetryAt, 0, 'successful unload needs no repeated cleanup cooldown');

        const delayed = await persisted(972014, 40);
        const pendingProbe = companion(delayed);
        pendingProbe.actor.backpack = new Backpack({ items: await Database.fetchItems(delayed.characterId), paperdoll: {} });
        pendingProbe.session.companionShopping = { kind: 'sell_unused_arrows', target };
        let release, entered = false;
        const gate = new Promise(resolve => { release = resolve; });
        const nativeSale = Database.sellItemsToNpc;
        replace(Database, 'sellItemsToNpc', async (...args) => { entered = true; await gate; return nativeSale.apply(Database, args); });
        const pending = Cleanup.sellUnusedArrows(pendingProbe.session, pendingProbe.actor, target);
        await Promise.resolve(); assert(entered);
        pendingProbe.actor.fetchClassId = () => 9;
        const changedBow = equippedBow('d');
        pendingProbe.actor.backpack.insertItem(973111, changedBow.selfId, { amount: 1, equipped: true, slot: 14 });
        release();
        await assert.rejects(pending, /companion_arrow_sale_interrupted/,
            'a class change during the queued write preserves an archer ammunition');
        assert.equal(Native.amount(await Database.fetchItems(delayed.characterId), 1341), 5000);
        assert.equal(Native.amount(await Database.fetchItems(delayed.characterId), 57), 100);

        await Database.close(); await Database.init();
        for (const id of [cold.characterId, hot.characterId]) {
            assert.equal(Native.amount(await Database.fetchItems(id), 1341), 0);
            assert.equal(Native.amount(await Database.fetchItems(id), 57), 100 + 5000 * price);
        }
        assert.equal(Native.amount(await Database.fetchItems(bow.characterId), 1341), 2000);
        assert.equal(Native.amount(await Database.fetchItems(lightArcher.characterId), 1341), 625,
            'the live-capacity sale survives a SQLite reopen');
        console.log('Bot arrows: class/scout policy, archer protection, no warehouse storage, cold cooldown, native hot NPC payout and SQLite reopen passed');
    } finally {
        restores.reverse().forEach(restore => restore());
        await Database.close();
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
