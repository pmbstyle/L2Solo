const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const { ColdSimulationCoordinator: ColdSimulationCoordinatorClass } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

const originalActive = BackgroundPartyState.active;
const originalSetStatus = BackgroundPartyState.setStatus;
const originalCachedState = LifeState.cachedState;
const originalReleaseDissolvedPartyMembers = LifeState.releaseDissolvedPartyMembers;
const originalLifeInit = LifeState.init;
const originalPartyInit = BackgroundPartyState.init;
const originalPurgeHistory = BackgroundPartyState.purgeHistory;

(async () => {
    const orphan = { partyId: 'bgp_orphan', leaderId: 9001, memberIds: [9001, 9002], status: 'active' };
    const attached = { partyId: 'bgp_attached', leaderId: 9010, memberIds: [9010, 9011], status: 'active' };
    const statuses = [];
    const releases = [];
    BackgroundPartyState.active = () => [orphan, attached];
    LifeState.cachedState = (characterId) => [9010, 9011].includes(Number(characterId))
        ? { characterId: Number(characterId) }
        : null;
    BackgroundPartyState.setStatus = async (partyId, status) => {
        statuses.push({ partyId, status });
        return { partyId, status };
    };
    LifeState.releaseDissolvedPartyMembers = async (partyId, reason) => {
        releases.push({ partyId, reason });
        return 2;
    };

    const orphaned = await ColdSimulationCoordinator.reconcileOrphanedBackgroundParties();
    assert.deepStrictEqual(orphaned.map((party) => party.partyId), ['bgp_orphan']);
    assert.deepStrictEqual(statuses, [{ partyId: 'bgp_orphan', status: 'dissolved' }]);
    assert.deepStrictEqual(releases, [{ partyId: 'bgp_orphan', reason: 'orphaned_dissolved_party' }]);

    let purges = 0;
    let workersStarted = 0;
    LifeState.init = () => Promise.resolve(false);
    BackgroundPartyState.init = () => Promise.resolve(true);
    BackgroundPartyState.purgeHistory = () => {
        purges += 1;
        return Promise.resolve(1);
    };
    const startup = new ColdSimulationCoordinatorClass();
    startup.startWorker = () => {
        workersStarted += 1;
    };
    const started = await startup.start();
    assert.strictEqual(started, false, 'cold worker must stay stopped when lifecycle hydration fails');
    assert.strictEqual(startup.started, false, 'failed startup must be retryable instead of leaving a poisoned started flag');
    assert.strictEqual(workersStarted, 0, 'failed lifecycle hydration must not start the worker');
    assert.strictEqual(purges, 0, 'failed lifecycle hydration must not purge recovery history');

    console.log('Cold orphaned party reconciliation and startup gating checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    BackgroundPartyState.active = originalActive;
    BackgroundPartyState.setStatus = originalSetStatus;
    LifeState.cachedState = originalCachedState;
    LifeState.releaseDissolvedPartyMembers = originalReleaseDissolvedPartyMembers;
    LifeState.init = originalLifeInit;
    BackgroundPartyState.init = originalPartyInit;
    BackgroundPartyState.purgeHistory = originalPurgeHistory;
});
