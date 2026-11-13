'use strict';
const assert = require('node:assert/strict');
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const id = 730062, restores = [];
function stub(object, key, value) { const original = object[key]; restores.push(() => object[key] = original); object[key] = value; }
(async () => {
    const world = await createWorld([{ id, classId: 0, level: 40 }], 'cleanup-economy-authority');
    try {
        await Life.init();
        await Database.createAccount('bot_cleanup_economy', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_cleanup_economy', id]]);
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 20000, slot: 0 });
        await Database.setItem(id, { selfId: 736, name: 'Scroll of Escape', amount: 2, slot: 0 });
        const timestamp = Date.now();
        const state = await Life.upsertState({ characterId: id, accountName: 'bot_cleanup_economy', name: 'CleanupBuyer',
            phase: 'cold', activity: 'hunting', level: 40, exp: Number(DataCache.experience[39]), adena: 20000,
            loc: { locX: 68982, locY: 119547, locZ: -3520 }, currentRegion: 'Giran',
            vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 }, timing: { lastResolvedAt: timestamp - 60000 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            stats: { classId: 0, money: [10000, .0001, 0, 0, .001, 15000, 76] } }, 'cleanup_economy_fixture');
        const intent = { key: 'power:76:7', itemId: 1458, amount: 2, price: 1500, recipeId: 0, valueHours: 1, valueRate: .001 };
        await Afk.openBotRecords(id, 'buy_ad', [{ storeType: Afk.BUY, town: 'Dion',
            lines: [{ selfId: 1458, name: 'Crystal: D-Grade', count: 2, price: 1500, enchant: 0, stackable: true, intent }] }]);
        const standing = Afk.ownerRecords(id).find(row => row.kind === 'buy_ad');
        const coordinator = new ColdSimulationCoordinator();
        coordinator.population = { realPlayerSessions: () => [],
            prepareInventoryCleanupProposal: (...args) => Population.prepareInventoryCleanupProposal(...args) };
        const acks = [];
        coordinator.worker = { postMessage: message => message.type === 'commit_ack' && acks.push(...message.payload.results) };
        coordinator.workerEpoch = 'cleanup:fixture';
        coordinator.reviewCommittedEconomy = async value => value;
        const refreshes = [];
        stub(invoke('GameServer/Bot/AI/DecisionEvents'), 'raiseOn', async (actorId, name) => { refreshes.push([actorId, name]); return null; });
        stub(Town, 'saleTown', () => ({ town: 'Oren' }));
        stub(Life, 'enqueueEquipmentGoalAdvanceForState', () => {});
        stub(Life, 'reviewTrainingAfterCommit', async value => value);
        stub(Market, 'reviewPurchaseLimits', async value => ({ state: value, changed: false }));
        stub(invoke('GameServer/Bot/Population/BotGlobalChat'), 'maybeAnnounce', () => {});
        const warnings = [];
        stub(utils, 'infoWarn', (...args) => warnings.push(require('node:util').format(...args.slice(1))));
        const proposal = { characterId: id, token: { characterId: id, ...state.simulation }, enqueuedAt: timestamp,
            nextState: state, result: { events: [] },
            cleanupNeed: { reason: 'market_surplus_inventory', slots: 40, npcOnlySlots: 0 },
            economyPlan: { sell: [], withdraw: [], travel: null,
                buyAds: [[1458, 10, 1500, 1, 76, 7, 0, 1, .001]] } };
        const prepared = await coordinator.prepareProposal(proposal);
        assert.equal(proposal.inventoryCleanupForced, true);
        assert.equal(prepared.stats.travel.paid.fee, 11000, 'the real Giran-to-Oren route charges its fare');
        assert.equal(prepared.adena, 9000, 'cleanup replaces the planner wallet after its bid was sized');
        const committed = await Life.upsertState(prepared, 'cleanup_trip_commit_fixture');
        const result = { ok: true, characterId: id, nextState: committed, proposal: { ...proposal, proposalId: `${id}:1`, revision: 1 } };
        await coordinator.afterCommit(result);
        await coordinator.handleCommitResults([result]);
        assert.equal(acks[0]?.ok, true);
        assert.equal((acks[0].review || []).includes('plan'), false,
            'a superseded worker bid is not reviewed after the paid cleanup commit: it waits for new preparation');
        assert.equal(warnings.some(line => line.includes('economy_plan_bid_unfunded')), false);
        assert.deepEqual(refreshes, [], 'the trip is the build\'s own decision: main raises nothing over it');
        const after = Afk.ownerRecords(id).find(row => row.kind === 'buy_ad');
        assert.equal(after.id, standing.id); assert.equal(after.lines[0].count, 2,
            'deferring the stale batch preserves the original unaccepted ad');
        const unfunded = await Market.executePlan(Life.cachedState(id), proposal.economyPlan, { reviewGoal: false });
        assert.equal(unfunded.stale, true, 'ordinary publication still enforces the actual native funding limit');
        assert.equal(Afk.ownerRecords(id).find(row => row.kind === 'buy_ad').lines[0].count, 2, 'the refused bid publishes nothing');
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [], travel: null,
            buyAds: [[1458, 6, 1500, 1, 76, 7, 0, 1, .001]] }, { reviewGoal: false });
        const refreshed = Afk.ownerRecords(id).find(row => row.kind === 'buy_ad');
        assert.equal(refreshed.id, standing.id); assert.equal(refreshed.lines[0].count, 6,
            'fresh preparation can resize the same native ad using the post-fare wallet');
        const items = await Database.fetchItems(id);
        assert.equal(items.filter(row => row.selfId === 57).reduce((sum, row) => sum + row.amount, 0), 9000,
            'only the native trip fare is debited');
        assert.equal(items.filter(row => row.selfId === 736).reduce((sum, row) => sum + row.amount, 0), 1,
            'the real recall scroll is consumed exactly once');
        console.log('Paid forced cleanup defers obsolete economy authority and refreshes the worker');
    } finally { for (const restore of restores.reverse()) restore(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
