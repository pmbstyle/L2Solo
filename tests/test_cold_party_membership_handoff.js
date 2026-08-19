const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-party-membership-handoff.sqlite');
fs.rmSync(databasePath, { force: true });
fs.rmSync(`${databasePath}-wal`, { force: true });
fs.rmSync(`${databasePath}-shm`, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const { ColdSimulationKernel, lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');

DataCache.init();
Database.init();

const originalMarkDirty = Coordinator.markDirty;
const originalClaimBatch = Owner.claimBatch;

function settleSnapshot() {
    return new Promise((resolve) => setImmediate(resolve));
}

(async () => {
    await Database.createAccount('party_handoff_probe', 'secret');
    await Database.createCharacter('party_handoff_probe', {
        name: 'PartyHandoffProbe', race: 0, classId: 0,
        maxHp: 300, maxMp: 120, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: -84191, locY: 244577, locZ: -3729
    });
    const [character] = await Database.fetchCharacters('party_handoff_probe');
    assert(character?.id, 'handoff fixture character must exist');
    assert.strictEqual(await LifeState.init(), true);
    assert.strictEqual(await PartyState.init(), true);
    await PartyState.createOrUpdate({
        partyId: 'handoff-party',
        leaderId: Number(character.id),
        memberIds: [Number(character.id), Number(character.id) + 1],
        spotId: 'handoff-probe',
        status: 'active'
    });

    const notifications = [];
    Coordinator.markDirty = (state, snapshotOptions = {}) => {
        notifications.push({ state, options: snapshotOptions });
        return { ok: true };
    };

    const base = await LifeState.upsertState({
        characterId: Number(character.id),
        accountName: 'party_handoff_probe',
        name: 'PartyHandoffProbe',
        level: 20,
        phase: 'cold',
        activity: 'party_wait',
        timing: { activityStartedAt: Date.now() - 60000, nextResolveAt: null },
        loc: { locX: -84191, locY: 244577, locZ: -3729 },
        vitals: { hp: 300, maxHp: 300, mp: 120, maxMp: 120 },
        stats: {
            classId: 0,
            role: 'dps',
            lastReason: 'acquisition_party_wait',
            partyRequest: { status: 'open', priority: 'required' }
        },
        inventory: {}
    }, 'party_handoff_fixture');
    await settleSnapshot();
    notifications.length = 0;

    const assigned = await LifeState.assignParty(base, 'handoff-party', 'dps', Number(character.id));
    await settleSnapshot();
    assert.strictEqual(assigned.activity, 'grouped');
    assert.strictEqual(assigned.party.partyId, 'handoff-party');
    assert(Number(assigned.timing.nextResolveAt) > Number(assigned.updatedAt || 0),
        'a newly assigned party leader must receive a bounded worker schedule');
    assert(notifications.some((entry) => (
        entry.options.reason === 'party_assigned'
        && entry.options.critical === true
        && entry.state.party.partyId === 'handoff-party'
    )), 'committed party assignment must publish a critical worker snapshot');

    notifications.length = 0;
    const detached = await LifeState.leaveParty(assigned, 'party_capacity_reclaimed');
    await settleSnapshot();
    assert.strictEqual(detached.party.partyId, null);
    assert.strictEqual(detached.activity, 'hunting', 'capacity reclamation must not leave a grouped solo bot');
    assert(Number(detached.timing.nextResolveAt) > Date.now(), 'detached grouped bot must receive a bounded solo due time');
    assert(notifications.some((entry) => (
        entry.options.reason === 'party_left_party_capacity_reclaimed'
        && entry.options.critical === true
        && !entry.state.party.partyId
    )), 'party detachment must publish a critical worker snapshot');

    const kernel = new ColdSimulationKernel({ now: () => Date.now(), resolveSolo: () => ({}) });
    kernel.upsert({ state: assigned, context: {} });
    assert.strictEqual(lifecycleKind(assigned, {}), 'party_member');
    assert.strictEqual(kernel.snapshot().heap, 0, 'attached party member must not own a solo schedule');
    kernel.upsert({ state: detached, context: {} });
    assert.strictEqual(lifecycleKind(detached, {}), 'resolver');
    assert.strictEqual(kernel.snapshot().heap, 1, 'detachment snapshot must recreate the solo schedule without a restart');

    notifications.length = 0;
    const travelling = {
        ...detached,
        activity: 'traveling',
        party: { ...(detached.party || {}), partyId: 'handoff-party', leaderId: Number(character.id) },
        stats: {
            ...(detached.stats || {}),
            backgroundPartyId: 'handoff-party',
            travel: {
                reason: 'party_spot_replan',
                arrivalActivity: 'grouped',
                arrivalAt: Date.now() + 60000,
                to: { locX: -80000, locY: 240000, locZ: -3500 }
            }
        }
    };
    const travelDetached = await LifeState.leaveParty(travelling, 'party_capacity_reclaimed');
    await settleSnapshot();
    assert.strictEqual(travelDetached.activity, 'hunting');
    assert.strictEqual(travelDetached.stats.travel, null, 'detaching party travel must clear its grouped destination');

    let claimedCandidates = null;
    Owner.claimBatch = async (candidates) => {
        claimedCandidates = candidates;
        return { grants: [], rejected: [] };
    };
    const claimCoordinator = new ColdSimulationCoordinator();
    let response = null;
    claimCoordinator.postCollections = (type, payload) => { response = { type, payload }; };
    await claimCoordinator.handleClaimRequest({
        msgId: 'stale-party-claim',
        payload: {
            candidates: [{
                characterId: Number(character.id),
                expectedRevision: Number(travelDetached.simulation?.revision || 0),
                purpose: {
                    kind: 'party',
                    partyId: 'handoff-party',
                    leaderId: Number(character.id),
                    memberIds: [Number(character.id)]
                }
            }]
        }
    });
    assert.deepStrictEqual(claimedCandidates, [], 'stale party catalog entry must be rejected before acquiring a lease');
    assert.strictEqual(response?.type, 'claim_ack');
    assert.strictEqual(response?.payload?.rejected?.[0]?.reason, 'party_membership_changed');
    assert.strictEqual(response?.payload?.rejected?.[0]?.state?.party?.partyId, null,
        'stale rejection must return the current detached state to the worker');

    console.log('Cold party membership snapshot handoff and stale-claim fencing checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    Coordinator.markDirty = originalMarkDirty;
    Owner.claimBatch = originalClaimBatch;
    await Database.close().catch(() => null);
    fs.rmSync(databasePath, { force: true });
    fs.rmSync(`${databasePath}-wal`, { force: true });
    fs.rmSync(`${databasePath}-shm`, { force: true });
});
