const assert = require('node:assert/strict');
const { MessageChannel } = require('node:worker_threads');
require('../src/Global');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').ColdSimulationCoordinator;
const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Database = invoke('Database');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const MemoryPolicy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Director = invoke('GameServer/Bot/Population/PopulationDirector');
const ClanSocial = invoke('GameServer/Clan/ClanSocialRuntime');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
invoke('GameServer/Bot/Population/PopulationConfig').knowledgeErrorsEnabled = false;

const row = { characterId: 900001, accountName: 'bot_projection_fixture', characterName: 'ProjectionFixture',
    phase: 'cold', activity: 'resting', level: 20, locX: 1, locY: 1, locZ: 0, spotId: '0_0',
    hp: 100, maxHp: 100, mp: 100, maxMp: 100, statsJson: '{}', inventorySummary: '{}',
    simulationOwner: 'legacy_main', simulationRevision: 4, simulationLeaseId: null,
    simulationLeaseUntil: 0, activityStartedAt: 100, nextResolveAt: 9999999999999,
    lastResolvedAt: 100, lastHotAt: null, updatedAt: 1234 };
const profile = { id: '0_0', name: 'Fixture Ground', raidBoss: false };
Profiles.cache = [profile];
Spots.spots = Profiles.cache;
const channel = new MessageChannel();
const coordinator = new Coordinator();
coordinator.worker = { postMessage: message => channel.port1.postMessage(message) };
coordinator.workerEpoch = 'cold-projection-native-port';
coordinator.ready = true;
coordinator.snapshotsLoaded = true;
let state = Life.acceptLifecycleRow(row);
Memory.accept(MemoryPolicy.empty(row.characterId));
const index = { spots: new Map([['0_0', profile]]), profiles: Profiles.cache,
    parties: new Map(), occupancy: {}, compactPartyMembers: false };
const originalExecute = Database.execute;
Database.execute = () => { throw new Error('projection fixture must not query SQLite'); };

function receive() { return new Promise(resolve => channel.port2.once('message', resolve)); }
async function publish() {
    index.partyGeneration = Parties.generation?.();
    const entry = coordinator.snapshotEntry(state, index);
    const delivered = receive();
    assert.equal(await coordinator.sendSnapshotPage([entry]), true);
    const message = await delivered;
    assert.equal(message.type, 'snapshot_page');
    assert.deepEqual(message.payload.rows[0], entry, 'actual native MessageChannel preserves producer row facts');
    return entry;
}

(async () => {
    try {
        assert.equal(Database.isReady(), false);
        assert.equal(Life.cachedState(row.characterId), state, 'actual accepted lifecycle cache positive control');
        const entry = await publish();
        assert.equal(entry.state, state);
        assert.equal(entry.context.spot, profile);
        assert.equal(entry.context.route, null, 'actual existing route early exit positive control');
        assert.equal(entry.context.party, null);
        console.log('PASS actual cached owner / native producer post / reference / nonplanning context controls');
        assert.equal(typeof coordinator.projectedEntryFor, 'function', 'missing targeted producer projection replay API');

        const originals = { contextIndex: coordinator.contextIndex, routeFor: coordinator.routeFor,
            allStates: Life.allStates, everyState: Life.everyState, active: Parties.active,
            occupancy: Profiles.currentOccupancy };
        const fail = () => { throw new Error('targeted replay used a global view/planner'); };
        coordinator.contextIndex = coordinator.routeFor = Life.allStates = Life.everyState
            = Parties.active = Profiles.currentOccupancy = fail;
        try {
            const replay = coordinator.projectedEntryFor(row.characterId);
            assert.equal(replay.ok, true);
            assert.equal(replay.entry, entry, 'retains the actual producer entry wrapper');
            assert.equal(replay.entry.state, state);
            assert.equal(replay.entry.context, entry.context);
            coordinator.snapshotQueue.mark(state, { reason: 'same_object_fixture' });
            coordinator.markDirty(state, { reason: 'same_object_fixture' });
            assert.equal(coordinator.projectedEntryFor(row.characterId).ok, false, 'same-object dirty invalidates old projection');
        } finally {
            coordinator.contextIndex = originals.contextIndex;
            coordinator.routeFor = originals.routeFor;
            Life.allStates = originals.allStates;
            Life.everyState = originals.everyState;
            Parties.active = originals.active;
            Profiles.currentOccupancy = originals.occupancy;
        }
        await publish();
        assert.equal(coordinator.projectedEntryFor(row.characterId).ok, true);
        const projectedScalars = [[state, 'adena'], [state, 'exp'], [state, 'sp'],
            [state.vitals, 'hp'], [state.vitals, 'maxHp'], [state.vitals, 'mp'], [state.vitals, 'maxMp'],
            [state.stats, 'karma']];
        for (const [object, field] of projectedScalars) {
            const previous = object[field];
            object[field] = Number(previous || 0) + 1;
            assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'projection_state_changed', `same-object ${field} scalar mutation`);
            object[field] = previous;
            assert.equal(coordinator.projectedEntryFor(row.characterId).ok, true, `restored ${field} scalar`);
        }
        const runtimeCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
        const runtimeMarkDirty = runtimeCoordinator.markDirty;
        const runtimeInitial = runtimeCoordinator.snapshotInFlightInitial;
        const initial = coordinator.snapshotInFlightInitial;
        try {
            coordinator.snapshotInFlightInitial = runtimeCoordinator.snapshotInFlightInitial = true;
            runtimeCoordinator.markDirty = (...args) => coordinator.markDirty(...args);
            state.stats.retainedNestedFixture = { mutation: 'memory callback' };
            Memory.events.onCommit(row.characterId);
            assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'projection_dirty', 'actual same-object memory producer dirty hook');
            await publish();
            state.stats.retainedNestedFixture.mutation = 'competition callback';
            coordinator.competitionActions.onState(row.characterId);
            assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'projection_dirty', 'actual same-object competition producer dirty hook');
        } finally {
            runtimeCoordinator.markDirty = runtimeMarkDirty;
            runtimeCoordinator.snapshotInFlightInitial = runtimeInitial;
            coordinator.snapshotInFlightInitial = initial;
            delete state.stats.retainedNestedFixture;
        }
        await publish();
        state = Life.acceptLifecycleRow({ ...row, simulationRevision: 5, updatedAt: 1235 });
        assert.equal(coordinator.projectedEntryFor(row.characterId).ok, false, 'replacement cached owner cannot reuse old context');
        await publish();
        coordinator.workerEpoch = 'next-cold-projection-epoch';
        assert.equal(coordinator.projectedEntryFor(row.characterId).ok, false, 'worker epoch fence');
        await publish();
        const unchangedContext = coordinator.projectedEntryFor(row.characterId).entry.context;
        unchangedContext.pressure.expMultiplier += 1;
        assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'projection_context_changed');
        await publish();
        const beforePressure = Director.lastSnapshot;
        Director.lastSnapshot = { targetLevel: 50, reason: 'fixture_current_pressure' };
        assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'pressure_changed');
        Director.lastSnapshot = beforePressure;
        assert.equal(coordinator.projectedEntryFor(row.characterId).ok, true);
        Memory.accept({ ...MemoryPolicy.empty(row.characterId), revision: 1 });
        assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'memory_changed');
        await publish();
        const retainedBeforeEscrow = coordinator.projectedEntryFor(row.characterId);
        assert.equal(retainedBeforeEscrow.ok, true);
        AfkTrade.refreshRecord({ id: 900991, ownerId: row.characterId, botOwned: true, status: 'active',
            kind: 'buy_ad', storeType: AfkTrade.BUY, town: 'Giran', revision: 1,
            escrowAdena: 1234, lines: [{ id: 900992, selfId: 1864, count: 1, price: 100, enchant: 0 }] });
        assert.equal(invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(row.characterId), 1234);
        assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'escrow_changed', 'actual indexed owned BUY escrow');
        await publish();
        ClanSocial.view.memberships.set(row.characterId, 3);
        assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'dynamic_clan_hall_context');
        ClanSocial.view.memberships.delete(row.characterId);
        const retainedContext = coordinator.snapshotEntry(state, index).context;
        retainedContext.route = { needed: true };
        coordinator.projectionRetention.prepare(state, retainedContext, Parties.generation());
        let guarded = receive();
        coordinator.post('snapshot_page', { rows: [{ state, context: retainedContext }], initial: false, done: false });
        await guarded;
        assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'dynamic_route_context');
        retainedContext.route = null;
        retainedContext.spot = { ...profile, raidBoss: true };
        coordinator.projectionRetention.prepare(state, retainedContext, Parties.generation());
        guarded = receive();
        coordinator.post('snapshot_page', { rows: [{ state, context: retainedContext }], initial: false, done: false });
        await guarded;
        assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'dynamic_raid_context');
        await publish();

        // Actual producer bodies, with persistence collaborators returning
        // controlled outcomes. No context/look/planner result is substituted.
        let delivered = receive();
        await coordinator.sendFullSnapshot();
        let message = await delivered;
        assert.equal(message.payload.initial, true);
        assert.equal(coordinator.projectedEntryFor(row.characterId).ok, true);
        coordinator.snapshotQueue.mark(state, { critical: true });
        delivered = receive();
        await coordinator.flushCriticalSnapshots();
        message = await delivered;
        assert.equal(message.payload.priority, 'P0');
        assert.equal(coordinator.projectedEntryFor(row.characterId).ok, true);

        const acceptance = coordinator.acceptColdState(state);
        message = await receive();
        assert.equal(message.payload.ack, true);
        await coordinator.onMessage(Protocol.envelope('ready', coordinator.workerEpoch,
            { phase: 'state_loaded', characterId: row.characterId }, message.msgId));
        assert.equal((await acceptance).ok, true);
        assert.equal(coordinator.projectedEntryFor(row.characterId).ok, true);

        delivered = receive();
        await coordinator.handleCommitResults([{ ok: true, characterId: row.characterId, revision: 5 }]);
        message = await delivered;
        assert.equal(message.type, 'commit_ack');
        assert.equal(coordinator.projectedEntryFor(row.characterId).entry.context.targetNpcId,
            message.payload.results[0].context.targetNpcId);
        const release = Owner.releaseBatch, claim = Owner.claimBatch;
        try {
            Owner.releaseBatch = async () => [{ ok: true, characterId: row.characterId }];
            delivered = receive();
            await coordinator.handleReleaseRequest({ payload: { releases: [] }, msgId: 'fixture_release' });
            message = await delivered;
            assert.equal(message.type, 'release_ack');
            assert.equal(coordinator.projectedEntryFor(row.characterId).ok, true);
            Owner.claimBatch = async () => ({ grants: [], rejected: [{ characterId: row.characterId, reason: 'fixture_rejection' }] });
            delivered = receive();
            await coordinator.handleClaimRequest({ payload: { candidates: [{ characterId: row.characterId,
                expectedRevision: 5, purpose: { kind: 'resolver' } }] }, msgId: 'fixture_claim' });
            message = await delivered;
            assert.equal(message.type, 'claim_ack');
            assert.equal(coordinator.projectedEntryFor(row.characterId).ok, true);
        } finally { Owner.releaseBatch = release; Owner.claimBatch = claim; }
        coordinator.population = { executeWorkerLifecycleCommand: async () => ({ ok: true, state }) };
        delivered = receive();
        coordinator.handleCommandRequest({ payload: { requests: [{ characterId: row.characterId, kind: 'fixture_command' }] },
            msgId: 'fixture_command' });
        await coordinator.commandTail;
        message = await delivered;
        assert.equal(message.type, 'command_ack');
        const currentEntry = coordinator.projectedEntryFor(row.characterId).entry;
        delivered = receive();
        coordinator.postCollections('command_ack', { results: [{ state, context: {}, marketCommandId: 'borrowed_worker_context' }] });
        await delivered;
        assert.equal(coordinator.projectedEntryFor(row.characterId).entry, currentEntry, 'market ACK cannot bless borrowed Worker context');

        const partyRow = { partyId: 'projection-party', leaderId: row.characterId,
            memberIdsJson: JSON.stringify([row.characterId, row.characterId + 1]), status: 'active',
            statsJson: '{}', startedAt: 0, updatedAt: 1 };
        let generation = Parties.generation();
        const party = Parties.acceptRow(partyRow);
        assert(Parties.generation() > generation);
        generation = Parties.generation();
        assert.equal(Parties.acceptRow(partyRow), party, 'same native party values preserve cached identity');
        assert.equal(Parties.generation(), generation, 'idempotent accepted row no generation bump');
        assert.equal(Parties.acceptCommit({ snapshot: party }), party);
        assert.equal(Parties.generation(), generation);
        assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'party_generation_changed');
        await publish();
        party.stats.acceptedMutation = true;
        assert.equal(Parties.acceptCommit({ snapshot: party }), party, 'same-object acceptance after mutation');
        assert(Parties.generation() > generation, 'acceptance compares against prior accepted stamp, not already-mutated current object');
        assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'party_generation_changed', 'solo projection sees accepted party mutation too');
        generation = Parties.generation();
        Parties.acceptCommit({ snapshot: party });
        assert.equal(Parties.generation(), generation, 'repeated same-object accept is a no-op');
        const initialParty = Parties.acceptRow(partyRow);
        const member = Life.acceptLifecycleRow({ ...row, characterId: row.characterId + 1,
            characterName: 'ProjectionMember', partyId: party.partyId });
        state = Life.acceptLifecycleRow({ ...row, simulationRevision: 5, partyId: party.partyId });
        index.parties.set(row.characterId, initialParty);
        await publish();
        assert.equal(coordinator.projectedEntryFor(row.characterId).ok, true, 'current own roster projection');
        coordinator.markDirty(member, { reason: 'same_object_member' });
        assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'party_member_changed');
        await publish();
        initialParty.stats.nestedFixture = { changed: true };
        assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'party_context_changed', 'mutable party values are not hidden by same identity');
        const restoredParty = Parties.acceptRow(partyRow);
        index.parties.set(row.characterId, restoredParty);
        await publish();
        const preparation = coordinator.snapshotEntry(state, index);
        Parties.acceptRow({ ...partyRow, updatedAt: 2 });
        delivered = receive();
        await coordinator.sendSnapshotPage([preparation]);
        await delivered;
        assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'party_generation_changed', 'post cannot bless a context prepared before a party change');
        index.parties.set(row.characterId, Parties.acceptRow(partyRow));
        await publish();
        Life.acceptLifecycleRow({ ...row, characterId: member.characterId, characterName: 'ProjectionMember',
            partyId: party.partyId, simulationRevision: 5 });
        assert.equal(coordinator.projectedEntryFor(row.characterId).reason, 'party_member_changed');

        // Cover loadActive clearing/removal and due/createOrUpdate accepted
        // cache writers against scripted SQL outcomes, never a live DB.
        let loaded = [partyRow];
        Database.execute = async ([sql]) => /SELECT \*/.test(sql) ? loaded : /SELECT 1/.test(sql) ? [{ 1: 1 }] : { affectedRows: 1 };
        await Parties.init();
        generation = Parties.generation();
        await Parties.loadActive();
        assert.equal(Parties.generation(), generation, 'identical full active refresh no bump');
        await Parties.due();
        assert.equal(Parties.generation(), generation, 'identical due row no bump');
        loaded = [{ ...partyRow, updatedAt: 2 }];
        await Parties.due();
        assert(Parties.generation() > generation, 'due accepted native record mutation bumps');
        generation = Parties.generation();
        loaded = [];
        await Parties.loadActive();
        assert(Parties.generation() > generation, 'full refresh removal bumps');
        generation = Parties.generation();
        await Parties.loadActive();
        assert.equal(Parties.generation(), generation, 'empty no-op refresh');
        const created = await Parties.createOrUpdate({ partyId: 'projection-created', memberIds: [row.characterId, member.characterId],
            leaderId: row.characterId, status: 'active' });
        assert(created && Parties.generation() > generation, 'successful authored save accepted cache writer');
        generation = Parties.generation();
        Database.execute = async () => ({ affectedRows: 0 });
        assert.equal(await Parties.createOrUpdate({ ...created, status: 'hot' }), null);
        assert.equal(Parties.generation(), generation, 'rejected save is no cache mutation');
        Database.execute = () => { throw new Error('targeted replay queried SQLite'); };
        state = Life.acceptLifecycleRow({ ...row, simulationRevision: 6 });
        index.parties.clear();
        await publish();
        coordinator.stopping = true;
        coordinator.onWorkerExit(0);
        assert.equal(coordinator.projectedEntryFor(row.characterId).ok, false);
        console.log('Cold projection retention source/native-port tests passed');
    } finally {
        Database.execute = originalExecute;
        channel.port1.close();
        channel.port2.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
