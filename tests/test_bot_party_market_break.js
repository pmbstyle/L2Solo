const assert = require('assert');

require('../src/Global');
invoke('GameServer/DataCache').init();

async function run() {
    const now = Date.now();
    const party = { partyId: 'market_break', leaderId: 1, memberIds: [1, 2, 3], spotId: 'cruma',
        stats: { formedAt: now - 5000, fightsResolved: 0, lastMarketBreakAt: now - 1000 } };
    const members = [1, 2, 3].map((characterId) => ({ characterId, name: `Bot${characterId}`, level: 20, party: { partyId: party.partyId, role: characterId === 1 ? 'tank' : 'dps' }, stats: {}, vitals: {} }));
    Object.assign(members[2], { level: 31, adena: 2000000,
        inventory: { 2370: { selfId: 2370, amount: 1, equipped: true, slot: 7 } },
        stats: { classId: 56, clanId: 1, money: [473405, 2.12e-6, 0, 0, 1.6e-5, 1226467, 166] } });
    const gearGoal = { type: 'upgrade_gear', target: { itemId: 166, itemSlot: 7, amount: 1 },
        plan: { expectedBenefit: 'market_search_for_gear', sourceType: 'npc', wishKey: 'power:166:7',
            estimatedCost: 1226467, valueRate: 1.6e-5 } };
    const Break = require('../src/GameServer/Bot/Population/PartyMarketBreak');
    const config = invoke('GameServer/Bot/Population/PopulationConfig');
    assert(Break.sessionReady(party, members[2], gearGoal, now, config), 'payable mandatory gear bypasses an ordinary party timer');
    assert(!Break.sessionReady(party, { ...members[2], adena: 1 }, gearGoal, now, config), 'an unfunded quote cannot bypass the timer');
    assert(!Break.sessionReady(party, members[2], { ...gearGoal, plan: { ...gearGoal.plan, sourceType: 'afk' } }, now, config),
        'a player quote retains the native party/trade admission rule');
    assert(!Break.sessionReady({ ...party, stats: { ...party.stats, objective: { priority: 'required', clanGoalKey: 'clan-duty' } } },
        members[2], gearGoal, now, config), 'clan duty keeps its own break policy');
    assert(!Break.sessionReady({ ...party, stats: { ...party.stats, objective: { sourceKind: 'raid' } } },
        members[2], gearGoal, now, config), 'a raid does not gain an early shopping break');
    assert(!Break.sessionReady(party, { ...members[2], inventory: { 166: { selfId: 166, amount: 1, equipped: true, slot: 7 } } },
        gearGoal, now, config), 'an already equipped D weapon is not a required kit gap');
    assert(!Break.sessionReady(party, members[2], null, now, config), 'ordinary errands retain the session limit');
    assert(Break.sessionReady({ ...party, stats: { formedAt: now - config.partyMarketBreakMinSessionMs - 1,
        fightsResolved: config.partyMarketBreakMinFights, lastMarketBreakAt: 0 } }, members[2], null, now, config),
    'ordinary shopping remains available after the existing session and fight thresholds');
    const shotGoal = { type: 'buy_craft_material', status: 'active',
        target: { itemId: 1463, amount: 390 }, plan: { wishKey: 'stock:shots',
            expectedBenefit: 'market_buy_craft_material', sourceType: 'configured_store', marketTown: 'Dion' } };
    const clanParty = { ...party, stats: { ...party.stats,
        objective: { priority: 'required', clanGoalKey: 'clan-duty', clanId: 1, clanOperation: 'equipment' } } };
    assert(Break.allowed(clanParty, members[2], now, null, shotGoal), 'a selected shot refill may temporarily leave clan duty');
    assert.strictEqual(Break.goal(clanParty, members[2], shotGoal, now, null), shotGoal);
    assert(!Break.allowed(clanParty, members[2], now, null, gearGoal), 'optional gear shopping still cannot leave clan duty');
    assert(!Break.allowed({ ...clanParty, stats: { ...clanParty.stats, marketAbsences: {
        2: { until: now + 60000 } } } }, members[2], now, null, shotGoal), 'only one member may be away at a time');
    assert(!Break.allowed({ ...clanParty, stats: { objective: { ...clanParty.stats.objective, sourceKind: 'raid' } } },
        members[2], now, null, shotGoal), 'a raid cannot be interrupted by a stock trip');
    assert(!Break.allowed(clanParty, members[2], now, null, { ...shotGoal, target: { itemId: 1864, amount: 390 } }),
        'a material order cannot impersonate a shot refill');
    const cleanup = { reason: 'inventory_capacity', slots: 81, limit: 80 };
    const sellGoal = { type: 'sell_inventory', target: { itemId: 1463, amount: 1 },
        plan: { expectedBenefit: 'market_sale_inventory' } };
    for (const status of ['assembling', 'traveling', 'holding', 'fighting', 'returning']) {
        const warParty = { ...party, status: 'active', stats: { ...clanParty.stats,
            warOperation: { id: 'live-war', status, expiresAt: now - 1 } } };
        for (const current of [gearGoal, sellGoal, { ...shotGoal, target: { itemId: 1864, amount: 50 } }]) {
            assert(!Break.allowed(warParty, members[2], now, cleanup, current), `${status}: shopping/cleanup cannot leave an unfinished war`);
            assert.strictEqual(Break.goal(warParty, members[2], current, now, cleanup), null);
            assert.strictEqual(Break.departure(warParty, members[2], { stats: {} }, now, cleanup, current), null);
        }
        for (const itemId of [1463, 2510, 3948, 17, 1342, 1061, 736, 737]) {
            const current = { ...shotGoal, target: { itemId, amount: 10 } };
            assert(Break.allowed(warParty, members[2], now, cleanup, current), `${status}: combat supply ${itemId} may be restocked`);
            assert.strictEqual(Break.goal(warParty, members[2], current, now, cleanup), current,
                'an overfull bag cannot replace the permitted refill with a sale');
            const departed = Break.departure(warParty, members[2], { stats: {} }, now, cleanup, current);
            assert.strictEqual(departed.stats.partyMarketReturn.warOperationId, 'live-war');
            assert.strictEqual(departed.stats.partyMarketReturn.supplyItemId, itemId);
            assert(!Break.allowed({ ...warParty, stats: { ...warParty.stats, ...Break.stats(warParty, departed) } },
                members[1], now, null, current), 'another member waits for the reserved supply absence');
        }
        const errand = { type: 'market_errand', target: { itemId: 1341, amount: 100 },
            plan: { expectedBenefit: 'market_errand', purpose: 'arrows', marketTown: 'Dion' } };
        assert(Break.allowed(warParty, members[2], now, null, errand));
        assert(!Break.allowed(warParty, members[2], now, null,
            { ...errand, target: { itemId: 729, amount: 1 } }), 'an enchant scroll is not a supply exception');
        assert(!Break.allowed(warParty, members[2], now, null,
            { ...shotGoal, target: { itemId: 1463, amount: 0 } }), 'an empty order cannot authorize a supply absence');
    }
    const completed = { ...party, stats: { ...party.stats, warOperation: null } };
    assert(Break.allowed(completed, members[2], now, cleanup, gearGoal), 'ordinary market rules resume once the order is cleared');
    console.log('Bot party market break checks passed');
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
