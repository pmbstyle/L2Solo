// A clan's market purchase is made in the seller's town (group C, б5): the
// member who buys it goes there on an errand (ColdMarketService.acquire)
// and deposits the item at a later resolve; nothing is bought from afar.
const assert = require('assert');
require('../src/Global');

invoke('GameServer/DataCache').init();
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const ClanOrderService = invoke('GameServer/Clan/ClanOrderService');
const ClanCrestService = invoke('GameServer/Clan/ClanCrestService');
const ClanMarketService = invoke('GameServer/Clan/ClanMarketService');

const BLOOD_MARK = 1419;
const originals = {
    cachedState: LifeState.cachedState, acquire: ColdMarketService.acquire, marketMembers: ClanOrderService.marketMembers,
    memberOffer: ClanOrderService.memberOffer, fetchItems: Database.fetchItems,
    transfer: Database.transferInventoryToClanWarehouse, upsertDemand: Database.upsertClanMarketDemand,
    syncSignal: Database.syncClanMarketDemandSignal, recordEvent: Database.recordClanGoalEvent,
    advance: Database.advanceAutonomousClanLevel, crest: ClanCrestService.ensureAutonomousCrest
};

async function run() {
    const clan = { id: 77, level: 2, state: { goal: { type: 'item', plan: { kind: 'market' }, progress: 0, required: 1,
        target: { itemId: BLOOD_MARK, itemName: 'Blood Mark' }, assignedMemberIds: [501], updatedAt: 5 } } };
    let member = { characterId: 501, name: 'Buyer', phase: 'cold', activity: 'hunting', currentRegion: 'Giran', adena: 900000,
        inventory: {}, stats: {}, simulationRevision: 3 };
    const acquired = [];
    const deposits = [];
    LifeState.cachedState = (id) => (Number(id) === 501 ? member : null);
    ClanOrderService.marketMembers = () => [{ characterId: 501 }];
    ClanOrderService.memberOffer = () => ({ price: 50000, sourceType: 'afk_bot_store', sourceId: 900, town: 'Giran' });
    ColdMarketService.acquire = async (state, selfId, amount, options) => {
        acquired.push({ selfId, amount, options });
        member = { ...state, activity: 'traveling', stats: { ...state.stats, marketErrand: { selfId, amount, town: 'Giran',
            purpose: options.purpose, tag: options.tag } } };
        return { state: member, bought: false, traveling: true };
    };
    Database.fetchItems = async () => [{ id: 1, selfId: BLOOD_MARK, amount: 1 }];
    Database.transferInventoryToClanWarehouse = async (request) => { deposits.push(request); return { ok: true }; };
    Database.upsertClanMarketDemand = async () => null;
    Database.syncClanMarketDemandSignal = async () => null;
    Database.recordClanGoalEvent = async () => null;
    Database.advanceAutonomousClanLevel = async () => ({ ok: false });
    ClanCrestService.ensureAutonomousCrest = async () => null;

    const leaving = await ClanMarketService.resolveClan(clan);
    assert.strictEqual(leaving.reason, 'market_buyer_traveling', 'the member goes to the seller\'s town');
    assert.deepStrictEqual(acquired.map((entry) => [entry.selfId, entry.amount, entry.options.towns[0], entry.options.purpose]),
        [[BLOOD_MARK, 1, 'Giran', 'clan']]);
    assert.strictEqual(acquired[0].options.maxPrice, 50000);
    assert.strictEqual(deposits.length, 0, 'nothing is deposited before the purchase');
    assert.strictEqual((await ClanMarketService.resolveClan(clan)).reason, 'market_buyer_traveling', 'still on its way');
    assert.strictEqual(acquired.length, 1, 'one errand at a time');

    // Back from its errand (bought on arrival): it deposits the item.
    member = { ...member, activity: 'hunting', inventory: { [BLOOD_MARK]: { selfId: BLOOD_MARK, amount: 1 } },
        stats: { lastErrand: { purpose: 'clan', selfId: BLOOD_MARK, units: 1, tag: member.stats.marketErrand.tag, at: 9 } } };
    const deposited = await ClanMarketService.resolveClan(clan);
    assert.strictEqual(deposited.purchased, true);
    assert.strictEqual(deposits.length, 1);
    assert.strictEqual(deposits[0].characterId, 501);
    assert.strictEqual(deposits[0].expectedSimulationRevision, 3);
    console.log('Clan market purchase by trip checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    LifeState.cachedState = originals.cachedState;
    ColdMarketService.acquire = originals.acquire;
    ClanOrderService.marketMembers = originals.marketMembers;
    ClanOrderService.memberOffer = originals.memberOffer;
    Database.fetchItems = originals.fetchItems;
    Database.transferInventoryToClanWarehouse = originals.transfer;
    Database.upsertClanMarketDemand = originals.upsertDemand;
    Database.syncClanMarketDemandSignal = originals.syncSignal;
    Database.recordClanGoalEvent = originals.recordEvent;
    Database.advanceAutonomousClanLevel = originals.advance;
    ClanCrestService.ensureAutonomousCrest = originals.crest;
});
