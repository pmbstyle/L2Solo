const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');

const originalActive = BackgroundPartyState.active;
const originalSetStatus = BackgroundPartyState.setStatus;
const originalCachedState = LifeState.cachedState;

(async () => {
    const orphan = { partyId: 'bgp_orphan', leaderId: 9001, memberIds: [9001, 9002], status: 'active' };
    const attached = { partyId: 'bgp_attached', leaderId: 9010, memberIds: [9010, 9011], status: 'active' };
    const statuses = [];
    BackgroundPartyState.active = () => [orphan, attached];
    LifeState.cachedState = (characterId) => [9010, 9011].includes(Number(characterId))
        ? { characterId: Number(characterId) }
        : null;
    BackgroundPartyState.setStatus = async (partyId, status) => {
        statuses.push({ partyId, status });
        return { partyId, status };
    };

    const orphaned = await ColdSimulationCoordinator.reconcileOrphanedBackgroundParties();
    assert.deepStrictEqual(orphaned.map((party) => party.partyId), ['bgp_orphan']);
    assert.deepStrictEqual(statuses, [{ partyId: 'bgp_orphan', status: 'dissolved' }]);

    console.log('Cold orphaned party reconciliation checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    BackgroundPartyState.active = originalActive;
    BackgroundPartyState.setStatus = originalSetStatus;
    LifeState.cachedState = originalCachedState;
});
