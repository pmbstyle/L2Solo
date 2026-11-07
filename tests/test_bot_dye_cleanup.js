'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('bot-dye-cleanup');
require('../src/Global');
fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Listing = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const Henna = invoke('GameServer/Henna/HennaRules');
const Rules = invoke('GameServer/Items/NpcSellRules');
const native = require('./helpers/nativeMarketFixture');
const symbol = Henna.symbol(157), timestamp = 1791899609826;
const template = id => Data.items.find(row => row.selfId === id);

async function seed(id, stats) {
    await native.character(Database, id, 'DyeBot' + id, 'bot_dye_' + id);
    await Database.execute(['UPDATE characters SET classId=55,race=4,level=58,hp=1000,maxHp=1000,mp=1000,maxMp=1000 WHERE id=?', [id]]);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000000 });
    await Database.setItem(id, { selfId: 736, name: 'Scroll of Escape', amount: 10 });
    // Non-stackable drop batches must leave the bag through real item rows.
    for (const selfId of [4589, 4601]) for (let n = 0; n < 50; n++)
        await Database.setItem(id, { selfId, name: template(selfId).template.name, amount: 1, equipped: false });
    return Life.upsertState({ characterId: id, accountName: 'bot_dye_' + id, name: 'DyeBot' + id,
        level: 58, phase: 'cold', activity: 'shopping', currentRegion: 'Giran', adena: 1000000,
        loc: { locX: 83000, locY: 148000, locZ: -3400 },
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, timing: {},
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        stats: { classId: 55, race: 4, coldCombat: { classId: 55, skills: [] }, ...stats }
    }, 'dye_cleanup_fixture');
}

async function run() {
    await Database.init(); await Life.init();
    const price = id => Rules.npcBuyPrice(template(id).template.price);
    const cleanup = { now: timestamp, forcedCleanup: { cleanupReason: 'inventory_capacity' } };
    const full = await seed(990420, { hennas: [133, 37, 124], wishFocus: ['stock:shots', 0, 0],
        // The sale retry: the last visit could not place these dyes, nothing new came since.
        marketSellSeen: { items: [4589, 4601], buyers: null } });
    assert.equal((await Database.fetchItems(full.characterId)).length, 102, 'fixture retains legacy separate dye rows');
    const dyeIds = Data.items.filter(row => row.template?.kind === 'Other.Tattoo').map(row => row.selfId);
    assert(dyeIds.every(id => template(id).etc.stackable === true), 'every canonical dye stacks');
    const compacted = await Database.compactStackableInventory(dyeIds, 'test-dye-stacks-v3');
    assert.equal(compacted.rowsRemoved, 98, 'old dye copies merge without spending any quantity');
    const stacked = await Database.fetchItems(full.characterId);
    assert.equal(stacked.length, 4);
    assert.equal(native.amount(stacked, 4589), 50);
    assert.equal(native.amount(stacked, 4601), 50);
    assert.equal((await Database.compactStackableInventory(dyeIds, 'test-dye-stacks-v3')).skipped, true);
    const repaired = Life.normalizeInventoryStackability({ 4601: { selfId: 4601, amount: 50,
        stackable: false, instances: Array.from({ length: 50 }, (_, id) => ({ id, amount: 1 })) } });
    assert.equal(repaired[4601].stackable, true);
    assert.equal(repaired[4601].instances, undefined);
    assert.equal(Disposition.inventorySlotCount({ inventory: repaired }), 1, 'old cold summaries also release dye slots');
    const result = await Listing.open(full, cleanup);
    const physical = await Database.fetchItems(full.characterId);
    assert.equal(native.amount(physical, 4589), 0);
    assert.equal(native.amount(physical, 4601), 0);
    assert.equal(physical.length, 2, 'both physical dye stacks leave the bag');
    assert.equal(native.amount(physical, 736), 10, 'the travel reserve stays owned');
    assert.equal(native.amount(physical, 57), 1000000 + 50 * price(4589) + 50 * price(4601), 'NPC pays exactly for the physical surplus');
    assert.equal(result.state.adena, native.amount(physical, 57));
    assert.equal(result.reason, 'sell_retry_cleanup', 'the capacity cleanup runs behind the sale retry');
    assert.deepEqual(result.state.stats.marketSellSeen, full.stats.marketSellSeen);
    assert.equal(Floor.forState({ ...result.state, inventory: Life.inventorySummaryFromItems(physical) }), null,
        'the next resolve no longer demands another capacity trip');
    assert.equal(invoke('GameServer/AfkTrade/AfkTradeService').ownerRecords(full.characterId).length, 0);

    const selected = await seed(990421, { hennas: [], wishFocus: ['henna:157', 0, 0] });
    await Database.compactStackableInventory(dyeIds, 'test-selected-dye-stacks-v3');
    const hotSale = invoke('GameServer/Bot/Economy/MarketListingPolicy').npcSaleForActor({
        coldLifeState: selected, actor: { fetchId: () => selected.characterId, fetchClassId: () => 55,
            fetchLevel: () => 58, backpack: { fetchItems: () => [
                { selfId: 4589, amount: 50 }, { selfId: 4601, amount: 50 }, { selfId: 57, amount: selected.adena }
            ] } }
    });
    assert.equal(hotSale.get(4589), 50);
    assert.equal(hotSale.get(4601), 40, 'hot NPC cleanup uses the same selected dye reserve');
    const candidates = Disposition.saleCandidates(selected, { unlimited: true, keptAmounts: {}, preparedReservations: {} });
    assert.equal(candidates.find(row => row.selfId === 4601).count, 40, 'prepared sale inputs cannot bypass the selected ten dyes');
    const withNoFocus = { ...selected, stats: { ...selected.stats, wishFocus: ['stock:shots', 0, 0] } };
    const fullSlots = { ...selected, stats: { ...selected.stats, hennas: [133, 37, 124] } };
    const alreadyDrawn = { ...selected, stats: { ...selected.stats, hennas: [157] } };
    const forbidden = { ...selected, stats: { ...selected.stats, classId: 0 } };
    for (const state of [withNoFocus, fullSlots, alreadyDrawn, forbidden])
        assert.equal(Disposition.saleCandidates(state, { unlimited: true, keptAmounts: {} }).find(row => row.selfId === 4601).count, 50,
            'unselected, undrawable or already used symbols do not retain spare dye');
    assert.notEqual(Disposition.reservationInputKey(selected), Disposition.reservationInputKey(withNoFocus), 'changing the selected symbol invalidates cached sale inputs');
    const quote = [{ selfId: 4601, count: 50, npcPrice: price(4601) }];
    const guarded = await Life.applyNpcLiquidation(selected, quote);
    assert.equal(native.amount(await Database.fetchItems(selected.characterId), 4601), 10, 'the native liquidation guard caps an overquoted sale');
    const drawnStock = await Listing.open({ ...guarded, activity: 'shopping' }, cleanup);
    const after = await Database.fetchItems(selected.characterId);
    assert.equal(native.amount(after, 4589), 0);
    assert.equal(native.amount(after, 4601), 10);
    assert.equal(native.amount(after, 57), 1000000 + 50 * price(4589) + 40 * price(4601));
    assert.equal(Disposition.npcLiquidationCandidates(drawnStock.state).length, 0, 'another cleanup cannot resell the retained dyes');
    const draw = await Database.applyBotImprovement(selected.characterId, { kind: 'henna', symbolId: 157,
        materials: [{ selfId: symbol.dyeSelfId, amount: symbol.dyeAmount }], fee: symbol.price }, { coldState: drawnStock.state });
    assert.equal(draw.result, 'henna');
    const worn = await Database.fetchItems(selected.characterId);
    assert.equal(native.amount(worn, 4601), 0, 'the preserved stock still draws the chosen symbol');
    assert.equal(native.amount(worn, 57), native.amount(after, 57) - symbol.price);
    console.log('PASS native dye stacking and cleanup: old copies -> conserved stacks -> NPC payout, selected henna inputs -> native draw');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
});
