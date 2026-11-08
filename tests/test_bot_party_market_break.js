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
// BackgroundPartyState. A duty party's member trips its stay answered (the
// worker's party_stay, applyPartyStayTrips): only the goal snapshot, the trip
// and the bag rule are stubbed.
async function departureChecks() {
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const Population = invoke('GameServer/Bot/Population/PopulationService');
    const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    assert.strictEqual(await LifeState.init(), true);
    assert.strictEqual(await PartyState.init(), true);

    const loc = { locX: -84191, locY: 244577, locZ: -3729 };
    async function formParty(partyId, size, stats = {}, memberStats = {}) {
        const past = Date.now() - 600000;
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
            status: 'active', stats: { formedAt: past, ...stats } });
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

    const originals = [[GoalExecutor, 'beginMarketTravel'], [Disposition, 'inventoryCleanupNeed'], [Disposition, 'cleanupCounted']]
        .map(([owner, name]) => [owner, name, owner[name]]);
    let leaving = 0;
    GoalExecutor.beginMarketTravel = (member, goal) => goal?.type === 'sell_inventory' ? { ...member, activity: 'traveling',
        stats: { ...member.stats, travel: { reason: 'market_sale_inventory', arrivalActivity: 'shopping',
            arrivalAt: Date.now() + 60000, to: { ...loc } } } } : null;
    Disposition.inventoryCleanupNeed = member => member.characterId === leaving ? { reason: 'inventory_capacity', slots: 81, limit: 80 } : null;
    // The bag fact at a count wherever the mocked count names a need.
    Disposition.cleanupCounted = member => member.characterId === leaving;
    const objective = { status: 'open', priority: 'required', clanGoalKey: 'clan:1:gear', clanId: 1, clanOperation: 'equipment',
        minPartySize: 2, maxPartySize: 9 };
    const bagTrip = id => [{ characterId: id, reason: 'bag_full' }];
    try {
        const breakParty = await formParty('mbleader', 3, { objective }, { clanId: 1 });
        leaving = breakParty.ids[0];
        const left = await Population.applyPartyStayTrips(breakParty.party, bagTrip(leaving));
        assert.strictEqual(left.departed[0]?.characterId, leaving, 'the leader leaves on its bag trip');
        assert.strictEqual(left.departed[0].stats.partyMarketReturn.partyId, 'mbleader', 'with its return ticket');
        await assertLeaderHandedOver('mbleader', leaving);

        const driftParty = await formParty('mbdrift', 4, { objective }, { clanId: 1 });
        const drifted = driftParty.ids[3];
        await LifeState.leaveParty(LifeState.cachedState(drifted), 'market_break_fixture');
        leaving = driftParty.ids[0];
        await Population.applyPartyStayTrips(driftParty.party, bagTrip(leaving));
        assert.deepStrictEqual(PartyState.find('mbdrift').memberIds, driftParty.ids.slice(1, 3), 'the row keeps only attached members');
        assert.strictEqual(LifeState.cachedState(drifted).party.partyId, null, 'the leader sync writes no one who left back in');
        await assertLeaderHandedOver('mbdrift', leaving);

        // A trip the duty does not let go now (a member already away) holds: the member
        // stays on duty, and hears its bag again when the absent member is back.
        const busyParty = await formParty('mbbusy', 4, { objective }, { clanId: 1 });
        const [away, heldId] = busyParty.ids;
        leaving = away;
        assert.strictEqual((await Population.applyPartyStayTrips(busyParty.party, bagTrip(away))).departed.length, 1);
        const fullBag = Object.fromEntries(Array.from({ length: 81 }, (_, index) => [9700 + index,
            { selfId: 9700 + index, amount: 1, stackable: false, kind: 'Other.Book', name: 'Book' }]));
        await LifeState.upsertState({ ...LifeState.cachedState(heldId), inventory: fullBag }, 'market_break_fixture');
        assert.strictEqual(require('../src/GameServer/Bot/Population/PartyMarketBreak').bagFact(LifeState.cachedState(heldId)), 2,
            'the held member\'s bag is at its floor');
        leaving = heldId;
        const held = await Population.applyPartyStayTrips(PartyState.find('mbbusy'), bagTrip(heldId));
        assert.strictEqual(held.departed.length, 0, 'one absence at a time');
        assert.strictEqual(LifeState.cachedState(heldId).party.partyId, 'mbbusy');
        const Situations = invoke('GameServer/Bot/Situations');
        const staysWoken = () => Situations.woken(LifeState.cachedState(heldId).stats, 'party_stay');
        assert(!staysWoken(), 'the held member\'s stay was decided');
        const back = LifeState.cachedState(away);
        const backed = await Population.resolveColdState(await LifeState.upsertState({ ...back, activity: 'party_wait',
            stats: { ...back.stats, travel: null, marketReturn: null } }, 'market_break_fixture'));
        assert.strictEqual(backed.reason, 'returned_to_clan_party');
        for (let turn = 0; turn < 20 && !staysWoken(); turn++) await new Promise(resolve => setImmediate(resolve));
        assert(staysWoken(), 'the absence ended: the held member\'s full bag wakes its stay again');
        // An absence that ends with no return (its ticket expired) wakes the held member too.
        const expiryParty = await formParty('mbexpiry', 4, { objective }, { clanId: 1 });
        const [gone, onDuty] = expiryParty.ids;
        leaving = gone;
        await Population.applyPartyStayTrips(expiryParty.party, bagTrip(gone));
        await LifeState.upsertState({ ...LifeState.cachedState(onDuty), inventory: fullBag }, 'market_break_fixture');
        leaving = onDuty;
        assert.strictEqual((await Population.applyPartyStayTrips(PartyState.find('mbexpiry'), bagTrip(onDuty))).departed.length, 0);
        const onDutyWoken = () => Situations.woken(LifeState.cachedState(onDuty).stats, 'party_stay');
        assert(!onDutyWoken());
        const away2 = LifeState.cachedState(gone);
        await LifeState.upsertState({ ...away2, stats: { ...away2.stats,
            partyMarketReturn: { ...away2.stats.partyMarketReturn, until: Date.now() - 1 } } }, 'market_break_fixture');
        for (let turn = 0; turn < 20 && !onDutyWoken(); turn++) await new Promise(resolve => setImmediate(resolve));
        assert(onDutyWoken(), 'an expired ticket ends the absence: the held member hears its bag again');

        const clanParty = await formParty('mbtoken', 2, { objective }, { clanId: 1 });
        const [leader, retained] = clanParty.ids;
        leaving = leader;
        const tokenBreak = await Population.applyPartyStayTrips(clanParty.party, bagTrip(leader));
        assert.strictEqual(tokenBreak.departed[0]?.stats.partyMarketReturn.partyId, 'mbtoken', 'a clan break carries a return token');
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
        stats: { formedAt: now - 5000 } };
    const members = [1, 2, 3].map((characterId) => ({ characterId, name: `Bot${characterId}`, level: 20, party: { partyId: party.partyId, role: characterId === 1 ? 'tank' : 'dps' }, stats: {}, vitals: {} }));
    Object.assign(members[2], { level: 31, adena: 2000000,
        inventory: { 2370: { selfId: 2370, amount: 1, equipped: true, slot: 7 } },
        stats: { classId: 56, clanId: 1, money: [473405, 2.12e-6, 0, 0, 1.6e-5, 1226467, 166] } });
    const Break = require('../src/GameServer/Bot/Population/PartyMarketBreak');
    const clanParty = { ...party, stats: { ...party.stats,
        objective: { priority: 'required', clanGoalKey: 'clan-duty', clanId: 1, clanOperation: 'equipment' } } };
    const floor = { reason: 'inventory_capacity', slots: 81, limit: 80 };
    assert(Break.allowed(clanParty, members[2], now, floor), 'a bag at its floor may leave clan duty');
    assert(!Break.allowed(clanParty, members[2], now, null), 'a refill waits for the clan\'s call');
    assert.strictEqual(Break.goal(clanParty, members[2], now, null), null);
    assert(!Break.allowed({ ...clanParty, stats: { ...clanParty.stats, marketAbsences: {
        2: { until: now + 60000 } } } }, members[2], now, floor), 'only one member may be away at a time');
    const warParty = { ...clanParty, status: 'active', stats: { ...clanParty.stats,
        warOperation: { id: 'live-war', status: 'holding', expiresAt: now - 1 } } };
    assert(!Break.allowed(warParty, members[2], now, floor), 'no trip leaves an unfinished war');
    assert(!Break.allowed(party, members[2], now, floor), 'an ordinary party starts no duty trip: its member leaves');
    await departureChecks();
    console.log('Bot party market break checks passed');
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(async () => {
    await Database.close().catch(() => null);
    removeDatabase();
});
