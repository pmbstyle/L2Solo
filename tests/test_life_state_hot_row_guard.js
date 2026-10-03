const assert = require('assert');

require('../src/Global');

// H10: a cold job (purchase, buy-store sale, wealth craft, shot economy) that
// started while its bot was cold may finish after the bot was activated. Its
// cold state must not be written over the hot row: that rolls the actor's
// experience, location and wallet back and turns it cold while it stands in
// the world. The life-state save rejects it like its other stale writers; only
// markCold hands a hot row back to the cold population.
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');

DataCache.init();

const bot = (characterId, extra = {}) => ({
    characterId, accountName: `bot${characterId}`, name: `Guard${characterId}`, level: 30, exp: 1000, adena: 500,
    phase: 'cold', activity: 'hunting', currentRegion: 'Gludio',
    inventory: { 57: { selfId: 57, name: 'Adena', amount: 500 } },
    stats: {}, loc: { locX: 1, locY: 2, locZ: 3 }, vitals: {}, timing: {},
    ...extra
});

async function run() {
    Database.execute = () => Promise.resolve([]);
    Database.updateCharacterLocation = async () => {};
    Database.updateCharacterExperience = async () => {};
    Database.updateCharacterVitals = async () => {};
    Database.reconcileBotClanMembership = async () => ({ repairedMembers: 0, repairedParties: 0 });
    Database.reconcileBotClanGoals = async () => ({ repairedMembers: 0, repairedParties: 0 });
    Database.syncInventorySummary = async () => {};

    const coldJob = bot(81);
    await BotLifeState.upsertState(coldJob, 'seed');
    await BotLifeState.upsertState({ ...coldJob, phase: 'hot', exp: 5000, adena: 900 }, 'hot_activation');
    assert.strictEqual(BotLifeState.snapshot(81).phase, 'hot', 'fixture: the bot is hot');

    const stale = await BotLifeState.upsertState({ ...coldJob, adena: 100 }, 'cold_shot_purchase');
    assert.strictEqual(stale, null, 'a cold job finishing after the activation is not written');
    assert.strictEqual(BotLifeState.snapshot(81).phase, 'hot', 'the hot row stays hot');
    assert.strictEqual(BotLifeState.snapshot(81).exp, 5000, 'the actor keeps its experience');
    assert.strictEqual(BotLifeState.snapshot(81).adena, 900, 'the actor keeps its wallet');

    // A cold write queued behind the activation is judged when it runs.
    const queued = bot(82);
    await BotLifeState.upsertState(queued, 'seed');
    const activation = BotLifeState.upsertState({ ...queued, phase: 'hot' }, 'hot_activation');
    const late = BotLifeState.upsertState({ ...queued, adena: 1 }, 'cold_wealth_craft');
    await activation;
    assert.strictEqual(await late, null, 'a cold write queued behind the activation is rejected');
    assert.strictEqual(BotLifeState.snapshot(82).phase, 'hot');

    // markCold's write hands the row back.
    const released = await BotLifeState.upsertState({ ...coldJob, exp: 5000, adena: 900 }, 'cooldown', { releaseHot: true });
    assert.strictEqual(released?.phase, 'cold', 'markCold returns a hot bot to the cold population');
    const after = await BotLifeState.upsertState({ ...coldJob, exp: 5000, adena: 950 }, 'cold_market_listing');
    assert.strictEqual(after?.adena, 950, 'cold jobs write a cold bot as before');

    // A hot merchant writes its own sales from the session's market snapshot,
    // taken at activation. markHot marks the session's snapshots hot, so the
    // actor's sale is written and the row stays hot; a sold-out merchant hands
    // its row back cold (Cooldown.transitionToColdState, releaseHot).
    const merchant = bot(83, { activity: 'merchant', inventory: { 57: { selfId: 57, name: 'Adena', amount: 500 },
        2: { selfId: 2, name: 'Long Sword', amount: 1 } },
    stats: { marketStore: { storeType: 1, items: [{ selfId: 2, price: 1000, count: 1 }] } } });
    await BotLifeState.upsertState(merchant, 'seed');
    // markHot itself marks the session's snapshots: drive it with a minimal actor.
    const actor = new Proxy({ fetchId: () => 83, fetchName: () => 'Guard83', fetchLevel: () => 30,
        backpack: { fetchItems: () => [], fetchItemFromSelfId: () => null } },
    { get: (target, key) => (key in target ? target[key]
        : typeof key === 'string' && key.startsWith('fetch') ? () => 0 : undefined) });
    const session = { actor, coldMarketState: { ...merchant } };
    await BotLifeState.markHot(session, 'hot_activation');
    assert.strictEqual(BotLifeState.snapshot(83).phase, 'hot', 'fixture: markHot wrote the hot row');
    assert.strictEqual(session.coldMarketState.phase, 'hot', 'markHot marks the session snapshot hot');
    const sold = await BotLifeState.applyMarketSale(session.coldMarketState, { selfId: 2, price: 1000 }, 1);
    assert.strictEqual(sold?.adena, 1500, 'a hot merchant\'s sale is written');
    assert.strictEqual(BotLifeState.snapshot(83).phase, 'hot', 'and its row stays hot');
    const Cooldown = invoke('GameServer/Bot/Population/Cooldown');
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const accept = Coordinator.acceptColdState;
    Coordinator.acceptColdState = async () => ({ ok: true });
    const World = invoke('GameServer/World/World');
    const removeUser = World.removeUser;
    World.removeUser = () => {};
    World.user = World.user || { sessions: [] };
    try {
        const leaving = { ...session, actor: { ...actor, destructor() {} } };
        const departure = await Cooldown.transitionToColdState(leaving, { ...sold, activity: 'hunting' }, 'market_sold_out');
        assert.strictEqual(departure.ok, true, 'a sold-out merchant leaves');
        assert.strictEqual(BotLifeState.snapshot(83).phase, 'cold', 'and hands its row back cold');
        assert.strictEqual(leaving.coldMarketState.phase, 'cold', 'its session snapshot is cold again');
        // A sale that lands after the hand-back cannot turn the row hot again.
        await BotLifeState.applyMarketSale(leaving.coldMarketState, { selfId: 57, price: 1 }, 1).catch(() => null);
        assert.strictEqual(BotLifeState.snapshot(83).phase, 'cold', 'a late write keeps the row cold');
    } finally {
        Coordinator.acceptColdState = accept;
        World.removeUser = removeUser;
    }
    console.log('Life state hot row guard checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
