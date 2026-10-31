const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const databasePath = path.join(process.cwd(), 'tmp', 'test-bot-party-market-break.sqlite');
const removeDatabase = () => ['', '-wal', '-shm'].forEach(suffix => fs.rmSync(`${databasePath}${suffix}`, { force: true }));
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
removeDatabase();
options.default.Database.path = path.relative(process.cwd(), databasePath);

const Database = invoke('Database');
invoke('GameServer/DataCache').init();
Database.init();

// A real party through the real owners: the database, BotLifeState and
// BackgroundPartyState. Only the goal review, the trip and the worker's income
// answer are stubbed (the edge of reconcileWorkerPartyGoals).
async function departureChecks() {
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const Population = invoke('GameServer/Bot/Population/PopulationService');
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const GoalService = invoke('GameServer/Bot/Goals/GoalService');
    const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const AfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
    const Calculation = require('../src/GameServer/Bot/Population/PartyGoalCalculation');
    const Policy = require('../src/GameServer/Bot/Population/PartyGoalPolicy');
    assert.strictEqual(await LifeState.init(), true);
    assert.strictEqual(await PartyState.init(), true);

    const loc = { locX: -84191, locY: 244577, locZ: -3729 };
    async function formParty(partyId, size, stats = {}, memberStats = {}) {
        const past = Date.now() - Config.partyMarketBreakMinSessionMs - 1000;
        const ids = [];
        for (let index = 1; index <= size; index += 1) {
            const accountName = `${partyId}${index}`;
            await Database.createAccount(accountName, 'secret');
            await Database.createCharacter(accountName, { name: `${partyId}${index}`, race: 0, classId: 0, maxHp: 300, maxMp: 120,
                sex: 0, face: 0, hair: 0, hairColor: 0, ...loc });
            const [character] = await Database.fetchCharacters(accountName);
            ids.push(Number(character.id));
            await LifeState.upsertState({ characterId: Number(character.id), accountName, name: character.name, level: 20,
                phase: 'cold', activity: 'grouped', timing: { activityStartedAt: past, nextResolveAt: past, lastResolvedAt: past },
                party: { partyId, role: 'dps', leaderId: ids[0] }, stats: { classId: 0, role: 'dps', leaderId: ids[0], backgroundPartyId: partyId, ...memberStats },
                loc, vitals: { hp: 300, maxHp: 300, mp: 120, maxMp: 120 }, inventory: {} }, 'market_break_fixture');
        }
        const party = await PartyState.createOrUpdate({ partyId, leaderId: ids[0], memberIds: ids, spotId: 'market-break-spot', startedAt: past,
            status: 'active', stats: { formedAt: past, fightsResolved: Config.partyMarketBreakMinFights, lastMarketBreakAt: 0, ...stats } });
        assert(party, `${partyId} must persist`);
        return { party, ids };
    }
    const durable = async (id) => {
        const [row] = await Database.execute(['SELECT partyId, statsJson FROM bot_life_state WHERE characterId = ?', [id]]);
        return { partyId: row.partyId, stats: JSON.parse(row.statsJson) };
    };
    async function assertLeaderHandedOver(partyId, leaver) {
        const party = PartyState.find(partyId);
        assert(party.memberIds.length >= Config.partyMinSize && !party.memberIds.includes(leaver), 'the row drops the leaver');
        assert.notStrictEqual(party.leaderId, leaver, 'the row elects a new leader');
        for (const id of party.memberIds) {
            const member = LifeState.cachedState(id), saved = await durable(id);
            assert.strictEqual(member.party.partyId, partyId);
            assert.strictEqual(member.party.leaderId, party.leaderId, 'every retained copy names the new leader');
            assert.strictEqual(member.stats.leaderId, party.leaderId);
            assert.strictEqual(saved.partyId, partyId);
            assert.strictEqual(saved.stats.leaderId, party.leaderId, 'the saved copy names the new leader');
        }
        assert.strictEqual(LifeState.cachedState(leaver).party.partyId, null, 'the leaver has no party');
        assert.strictEqual((await durable(leaver)).partyId, null);
    }

    const sellGoal = { type: 'sell_inventory', status: 'active', target: { cleanupReason: 'inventory_capacity' },
        plan: { expectedBenefit: 'market_sale_inventory', cleanupReason: 'inventory_capacity' } };
    const originals = [[GoalService, 'snapshot'], [GoalService, 'review'], [GoalExecutor, 'beginMarketTravel'],
        [Disposition, 'inventoryCleanupNeed'], [AfkMarket, 'reconcile'], [Coordinator, 'requestPartyGoals']]
        .map(([owner, name]) => [owner, name, owner[name]]);
    let leaving = 0;
    GoalService.snapshot = () => null;
    GoalService.review = async member => ({ current: member.characterId === leaving ? sellGoal : { type: 'recover', status: 'active' } });
    GoalExecutor.beginMarketTravel = (member, goal) => goal?.type === 'sell_inventory' ? { ...member, activity: 'traveling',
        stats: { ...member.stats, travel: { reason: 'market_sale_inventory', arrivalActivity: 'shopping',
            arrivalAt: Date.now() + 60000, to: { ...loc } } } } : null;
    Disposition.inventoryCleanupNeed = () => null;
    AfkMarket.reconcile = async () => null;
    try {
        const breakParty = await formParty('mbleader', 3);
        leaving = breakParty.ids[0];
        const left = await Population.reconcileWorkerPartyGoals(breakParty.party, Date.now());
        assert.strictEqual(left.departed?.characterId, leaving, 'the leader leaves on a market break');
        await assertLeaderHandedOver('mbleader', leaving);

        const incomeParty = await formParty('mbincome', 3);
        leaving = 0;
        const incomeLeaver = incomeParty.ids[0];
        Coordinator.requestPartyGoals = async (party, selected) => ({ ok: true, sources: Calculation.sources(selected),
            joint: { memberGoals: selected.map(Policy.declaration), lastIncomeReviewAt: Date.now(), incomeReviews: [{ characterId: incomeLeaver,
                accept: false, reason: 'solo_preferred', partySource: 'own_party', soloIncome: 1000, partyIncome: 200, fee: 0 }] } });
        const soloExit = await Population.reconcileWorkerPartyGoals(incomeParty.party, Date.now());
        assert.strictEqual(soloExit.departed?.characterId, incomeLeaver, 'the leader leaves for better solo income');
        await assertLeaderHandedOver('mbincome', incomeLeaver);
        Coordinator.requestPartyGoals = originals.find(([, name]) => name === 'requestPartyGoals')[2];

        const driftParty = await formParty('mbdrift', 4);
        const drifted = driftParty.ids[3];
        await LifeState.leaveParty(LifeState.cachedState(drifted), 'market_break_fixture');
        leaving = driftParty.ids[0];
        await Population.reconcileWorkerPartyGoals(driftParty.party, Date.now());
        assert.deepStrictEqual(PartyState.find('mbdrift').memberIds, driftParty.ids.slice(1, 3), 'the row keeps only attached members');
        assert.strictEqual(LifeState.cachedState(drifted).party.partyId, null, 'the leader sync writes no one who left back in');
        await assertLeaderHandedOver('mbdrift', leaving);

        const objective = { status: 'open', priority: 'required', clanGoalKey: 'clan:1:gear', clanId: 1, clanOperation: 'equipment',
            minPartySize: 2, maxPartySize: 9 };
        const clanParty = await formParty('mbtoken', 2, { objective }, { clanId: 1 });
        const [leader, retained] = clanParty.ids;
        leaving = leader;
        Disposition.inventoryCleanupNeed = member => member.characterId === leader ? { reason: 'inventory_capacity', slots: 81, limit: 80 } : null;
        const tokenBreak = await Population.reconcileWorkerPartyGoals(clanParty.party, Date.now());
        assert.strictEqual(tokenBreak.departed?.stats.partyMarketReturn.partyId, 'mbtoken', 'a clan break carries a return token');
        assert.strictEqual(tokenBreak.dissolved, true, 'a token keeps no party below the minimum');
        assert.strictEqual(PartyState.find('mbtoken'), null, 'no active row below partyMinSize');
        const [row] = await Database.execute(['SELECT status FROM bot_background_parties WHERE partyId = ?', ['mbtoken']]);
        assert.strictEqual(row.status, 'dissolved');
        const released = LifeState.cachedState(retained);
        assert.strictEqual(released.party.partyId, null, 'the member left behind goes solo');
        assert.strictEqual(released.activity, 'hunting');
        assert.strictEqual((await durable(retained)).partyId, null);

        const traveller = LifeState.cachedState(leader);
        assert.strictEqual(traveller.party.partyId, null);
        const arrived = await LifeState.upsertState({ ...traveller, activity: 'party_wait',
            stats: { ...traveller.stats, travel: null, marketReturn: null } }, 'market_break_fixture');
        const returned = await Population.resolveColdState(arrived);
        assert.strictEqual(returned.ok, true);
        assert.strictEqual(returned.reason, 'clan_party_return_wait', 'a return to a dissolved party waits for a new one');
        const waiting = LifeState.cachedState(leader);
        assert.strictEqual(waiting.activity, 'party_wait');
        assert.strictEqual(waiting.party.partyId, null, 'no orphan party id');
        assert.strictEqual(waiting.stats.partyMarketReturn, null);
        assert.strictEqual(waiting.stats.partyRequest.clanGoalKey, objective.clanGoalKey);
    } finally {
        originals.forEach(([owner, name, value]) => { owner[name] = value; });
    }
}

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
    await departureChecks();
    console.log('Bot party market break checks passed');
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(async () => {
    await Database.close().catch(() => null);
    removeDatabase();
});
