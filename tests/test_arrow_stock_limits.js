'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('arrow-stock-limits');
require('../src/Global'); fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'), DB = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Arrows = invoke('GameServer/Inventory/ArrowStock');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Restock = invoke('GameServer/Bot/Economy/NpcRestockPlan');
const Listing = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Item = invoke('GameServer/Item/Item');
const Native = require('./helpers/nativeMarketFixture');
const point = { locX: 83396, locY: 147904, locZ: -3400 };
Data.init();
const tpl = id => Data.items.find(row => row.selfId === id);
const bow = rank => Data.items.find(row => row.template?.kind === 'Weapon.Bow' && row.etc?.rank === rank);
const stack = (id, amount) => ({ selfId: id, amount, stackable: true, kind: tpl(id).template.kind });
const worn = rank => ({ selfId: bow(rank).selfId, amount: 1, equipped: true, equippedCount: 1,
    equippedSlots: [14], slot: 14, stackable: false, kind: 'Weapon.Bow' });
function state(rank = 'c', bag = {}) {
    const weapon = worn(rank);
    return { characterId: 945001, accountName: 'bot_arrow_limit', name: 'ArrowLimit', level: 52,
        adena: 1000000, phase: 'cold', activity: 'shopping', currentRegion: 'Giran', loc: point,
        timing: {}, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { classId: 9, money: [0, 0, 0, 0] }, inventory: { [weapon.selfId]: weapon, ...bag } };
}
async function seed(id, count = 1990) {
    await Native.character(DB, id, `ArrowLimit${id}`, `bot_arrow_limit_${id}`, point);
    await DB.execute(['UPDATE characters SET classId=9,level=52 WHERE id=?', [id]]);
    await DB.setItem(id, { selfId: 57, amount: 1000000 });
    await DB.setItem(id, { selfId: bow('c').selfId, amount: 1, equipped: true, slot: 14 });
    if (count) await DB.setItem(id, { selfId: 1342, amount: count });
    return Life.upsertState({ ...state(), characterId: id, name: `ArrowLimit${id}`,
        accountName: `bot_arrow_limit_${id}`, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)) }, 'arrow_limit_fixture');
}
const amount = async (id, selfId) => Native.amount(await DB.fetchItems(id), selfId);
async function purchase(saved, lines) {
    return DB.purchaseNpcInventoryBasket(saved.characterId, { lines, coldState: saved });
}
async function run() {
    try {
        for (const [rank, arrowId] of Object.entries(Arrows.BY_RANK)) {
            const bag = Object.fromEntries(Object.values(Arrows.BY_RANK).map(id => [id, stack(id, 5000)]));
            const archer = state(rank, bag);
            assert.equal(Arrows.currentId(archer), arrowId, `${rank} bow matches native player ammunition`);
            assert.equal(Arrows.keptAmounts(archer)[arrowId], Arrows.MAX_AMOUNT);
            const sale = Disposition.unusedArrowCandidates(archer);
            assert.equal(sale.find(row => row.selfId === arrowId).count, 3000);
            assert(sale.filter(row => row.selfId !== arrowId).every(row => row.count === 5000));
        }
        const oldBow = state('d', { 1341: stack(1341, 500), 1342: stack(1342, 500) });
        const upgraded = { ...oldBow, inventory: { ...oldBow.inventory,
            [bow('d').selfId]: { ...worn('d'), equipped: false, equippedCount: 0 }, [bow('c').selfId]: worn('c') } };
        assert.equal(Arrows.saleAmounts(oldBow).get(1341), 0);
        assert.equal(Arrows.saleAmounts(upgraded).get(1341), 500, 'a weapon upgrade releases all old-grade arrows');
        assert.equal(Arrows.saleAmounts(upgraded).get(1342), 0);
        assert.equal(Arrows.currentId({ ...oldBow, inventory: { 1341: stack(1341, 500) } }), null,
            'an archer without an equipped bow has no current ammunition grade');

        const liveWeapon = new Item(100, { ...tpl(bow('c').selfId).template, ...tpl(bow('c').selfId).stats,
            ...tpl(bow('c').selfId).etc, selfId: bow('c').selfId, amount: 1, equipped: true, slot: 14 });
        const ballast = new Item(101, { ...tpl(1864).template, ...tpl(1864).etc, selfId: 1864, amount: 1000 });
        const liveArrow = new Item(102, { ...tpl(1342).template, ...tpl(1342).etc, selfId: 1342, amount: 100 });
        const live = { fetchClassId: () => 9, fetchLevel: () => 52, fetchMaxLoad: () => 12000,
            backpack: { fetchItems: () => [liveWeapon, ballast, liveArrow], fetchEquippedWeapon: () => liveWeapon } };
        const otherWeight = liveWeapon.fetchMass() + ballast.fetchMass() * ballast.fetchAmount();
        const cap = Math.min(2000, Math.floor((5999 - otherWeight) / liveArrow.fetchMass()));
        assert.equal(Arrows.keptAmounts(live)[1342], cap);
        assert.equal(Arrows.purchaseAmount(live, 1342, 5000), cap - 100, 'hot restocks honor both count and physical weight');
        assert.equal(Arrows.purchaseAmount(live, 1341, 5000), 0);
        const loaded = { ...live, fetchMaxLoad: () => 2000 };
        assert.equal(Arrows.keptAmounts(loaded)[1342], Arrows.KEEP_FLOOR, 'other weight past the limit leaves the floor stock');
        assert.equal(Arrows.saleAmounts(loaded).get(1342), 0, 'an overloaded archer does not sell its working ammunition');
        assert.equal(Arrows.purchaseAmount(loaded, 1342, 10), 0, 'nor buys into the overload');

        await DB.init(); await Life.init();
        let saved = await seed(945011);
        const quote = invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffers(1342, 'Giran')[0];
        assert(quote, 'native Giran arrow seller exists');
        const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
        const evidence = require('../src/GameServer/Bot/Economy/WishPurchaseEvidence').reader(saved, { trip },
            { tripCost: trip, npcOffersFor: id => [{ ...quote, selfId: id, sourceType: 'npc' }] });
        assert.equal(evidence(1342).availableUnits, 10, 'wish planning sees finite room instead of unlimited arrow supply');
        assert.equal(evidence(1341), null, 'wrong-grade arrows have no admitted purchase path');
        assert.equal(Arrows.purchaseAmount({ ...saved, acceptedIncoming: { 1342: 10 } }, 1342, 10), 0,
            'already accepted deliveries also occupy the stock limit');
        const planned = Restock.collect(saved, { potions: false, shots: false, scrolls: false,
            extras: [{ selfId: 1342, amount: 5000, offer: quote }] });
        assert.equal(planned.flatMap(row => row.lines).find(row => row.selfId === 1342).amount, 10,
            'the planner buys only the missing working stock');
        assert.equal(Life.marketPurchaseBlocker(saved, { selfId: 1342 }, 11, { commanded: true }), 'arrow_stock_limit',
            'a worker command meets the same stock gate as an ordinary purchase');
        assert.equal(Life.marketPurchaseBlocker(saved, { selfId: 1342 }, 10, { commanded: true }), null);
        const outcomes = await Promise.allSettled([purchase(saved, [{ selfId: 1342, amount: 10, unitPrice: 2 }]),
            purchase(saved, [{ selfId: 1342, amount: 10, unitPrice: 2 }])]);
        assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
        assert.match(outcomes.find(row => row.status === 'rejected').reason.message, /arrow_stock_limit/);
        assert.equal(await amount(saved.characterId, 1342), 2000);
        assert.equal(await amount(saved.characterId, 57), 1000000 - 20, 'a concurrent refill cannot debit money for rejected excess');
        await assert.rejects(purchase(saved, [{ selfId: 1341, amount: 1, unitPrice: 1 }]), /arrow_stock_limit/);

        saved = await seed(945012, 1000);
        const maximum = Profile.profileFor(saved).maxLoad, limit = Math.ceil(maximum / 2) - 1;
        const unitMass = tpl(1342).template.mass, stemMass = tpl(1864).template.mass;
        const target = Math.floor((limit - Floor.stateInventory(saved, Data.items).load - unitMass * 5) / stemMass);
        await DB.setItem(saved.characterId, { selfId: 1864, amount: target });
        saved = await Life.upsertState({ ...saved, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(saved.characterId)) }, 'arrow_limit_ballast');
        const room = Arrows.purchaseAmount(saved, 1342, 1000);
        assert(room >= 5 && room < 7);
        await assert.rejects(purchase(saved, [{ selfId: 1342, amount: room + 1, unitPrice: 2 }]), /arrow_stock_limit/);
        await assert.rejects(purchase(saved, [{ selfId: 1342, amount: room, unitPrice: 2 },
            { selfId: 1060, amount: 1, unitPrice: 1 }]), /arrow_stock_limit/, 'the whole basket includes the weight of later lines');
        assert.equal(await amount(saved.characterId, 1060), 0, 'rejected mixed restocks roll back every line');
        assert.equal(await amount(saved.characterId, 57), 1000000);
        await purchase(saved, [{ selfId: 1342, amount: room, unitPrice: 2 }]);
        const finalBag = { ...saved, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(saved.characterId)) };
        assert(Floor.stateInventory(finalBag, Data.items).load < maximum / 2);

        saved = await seed(945013, 2500);
        await DB.setItem(saved.characterId, { selfId: 1341, amount: 5000 });
        saved = await Life.upsertState({ ...saved, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(saved.characterId)),
            stats: { ...saved.stats, marketSellRetryAfter: Date.now() + 1800000 } }, 'arrow_limit_surplus');
        const sale = await Listing.open(saved, { town: 'Giran' });
        assert.equal(sale.reason, 'sell_retry_cleanup');
        assert.equal(await amount(saved.characterId, 1342), 2000);
        assert.equal(await amount(saved.characterId, 1341), 0);
        assert.equal(await amount(saved.characterId, 57), 1000000 + 500 * 2 + 5000);
        assert.equal(Native.amount(await DB.fetchWarehouseItems(saved.characterId), 1341), 0);

        // The same final guard protects native player-shop and backed-board purchases.
        const buyer = await seed(945014, 1999), seller = await seed(945015, 5000);
        const source = (await DB.fetchItems(seller.characterId)).find(row => row.selfId === 1342);
        await assert.rejects(DB.buyFromLivePrivateStore(buyer.characterId, { sellerId: seller.characterId,
            objectId: source.id, selfId: 1342, amount: 2, price: 2, validate() {} }), /arrow_stock_limit/);
        assert.equal(await amount(buyer.characterId, 57), 1000000);
        const [character] = await DB.execute(['SELECT * FROM characters WHERE id=?', [seller.characterId]]);
        await Afk.publishBot(seller.characterId, { storeType: 1, title: 'Arrows', town: 'Giran', ...point,
            appearance: { model: character }, lines: [{ objectId: source.id, selfId: 1342, name: 'Fine Steel Arrow',
                count: 50, price: 2, enchant: 0, stackable: true }] });
        const shop = Afk.findOwnerProjection(seller.characterId).shop;
        await assert.rejects(DB.buyFromAfkTradeShop(buyer.characterId, { shopId: shop.id || shop.shopId,
            lineId: shop.lines[0].id, ownerId: seller.characterId, amount: 2 }), /arrow_stock_limit/);
        assert.equal(await amount(buyer.characterId, 1342), 1999);
        const actors = [buyer.characterId, seller.characterId];
        await DB.replaceBoardRecords(buyer.characterId, 'buy_ad', [{ storeType: 3, town: 'Giran', ...point,
            lines: [{ selfId: 1342, count: 2, price: 2, stackable: true,
                intent: { itemId: 1342, amount: 2, price: 2, key: 'resale:1342', recipeId: 0, valueHours: 2, valueRate: 100 } }] }], { expected: {} });
        const need = (await DB.fetchAfkTradeShops(buyer.characterId)).find(row => row.kind === 'buy_ad');
        const participants = await Promise.all(actors.map(id => DB.prepareTradeParticipant(id)));
        const sourceRow = participants[1].inventory.find(row => row.selfId === 1342);
        const request = count => ({ token: `arrow-meeting-${count}`, actorA: actors[0], actorB: actors[1],
            seqA: participants[0].sequence, seqB: participants[1].sequence, town: 'Giran', point,
            lines: [{ payer: 0, itemId: sourceRow.id, selfId: 1342, count, price: 2,
                needAdId: need.id, needAdRevision: need.revision,
                certificate: (() => { const value = JSON.parse(need.lines[0].intentJson); value[1] = count; return value; })() }],
            parties: participants.map(party => ({ ...party, route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })) });
        const prepared = { freshPreparation: true, validatePreparation: () => true };
        await assert.rejects(DB.acceptTradeMeeting(request(2), prepared), /arrow_stock_limit/,
            'meeting admission checks aggregate incoming ammunition');
        const accepted = await DB.acceptTradeMeeting(request(1), prepared);
        await assert.rejects(purchase(buyer, [{ selfId: 1342, amount: 1, unitPrice: 2 }]), /arrow_stock_limit/,
            'a pending meeting cannot be topped up a second time through the NPC');
        await DB.setItem(buyer.characterId, { selfId: 1342, amount: 1 });
        await DB.execute(["UPDATE bot_life_state SET activity='shopping',statsJson=json_remove(statsJson,'$.travel') WHERE characterId IN (?,?)", actors]);
        const terminal = await DB.arriveTradeMeeting(accepted.meeting.id);
        assert.equal(terminal.meeting.state, 'cancelled', 'new loot during the trip cannot overflow the stock on arrival');
        assert.equal(terminal.meeting.reason, 'arrow_stock_limit');
        for (const id of actors) await DB.settleBoardOwner(id);
        assert.equal(await amount(buyer.characterId, 1342), 2000, 'only the independently acquired arrow remains');
        assert.equal(await amount(buyer.characterId, 57), 1000000, 'cancelled arrival refunds the exact payment');
        assert.equal(await amount(seller.characterId, 1342), 4950, 'the seller gets the held arrow back beside its existing escrow');
        console.log('PASS arrow limits: grades, weapon change, weight, bounded planning, concurrent native NPC buys, mixed basket rollback, cleanup, shops and meeting cancellation/refund');
    } finally {
        await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
