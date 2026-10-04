const assert = require('assert');

require('../src/Global');

// L13: the two feeds to the cold worker, the full snapshot and the orphan
// party check, see every cached state, not only the newest 2,000 that a
// bounded allStates() view returns.

const ClanService = invoke('GameServer/Clan/ClanService');
ClanService.syncColdMember = () => {};
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const ClanSocial = invoke('GameServer/Clan/ClanSocialRuntime');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
Memory.repository = { loadMany: async ids => ids.map(Policy.empty) };
ClanSocial.refresh = async () => {};

const COUNT = 2500;
// Ids 1..3 are the oldest states, outside the newest 2,000. Bots 1 and 2 are
// the declared party; bot 3 also claims it, which makes the party invalid.
for (let id = 1; id <= COUNT; id++) {
    LifeState.acceptClanCraftState({ characterId: id, characterName: `b${id}`, phase: 'cold', activity: 'hunting',
        level: 20, updatedAt: 1_000_000 + id, statsJson: '{}', locX: 0, locY: 0, locZ: 0,
        partyId: id <= 3 ? 'bgp_old' : null });
}

(async () => {
    assert.strictEqual(LifeState.allStates(5000).length, 2000, 'the bounded view stays bounded');
    assert.strictEqual(LifeState.everyState().length, COUNT);
    assert.strictEqual(LifeState.everyState()[0].characterId, COUNT, 'newest first, as allStates');

    const statuses = [];
    BackgroundPartyState.active = () => [{ partyId: 'bgp_old', leaderId: 1, memberIds: [1, 2], status: 'active' }];
    BackgroundPartyState.setStatus = async (partyId, status) => { statuses.push({ partyId, status }); return null; };
    const coordinator = new ColdSimulationCoordinator();
    const invalid = await coordinator.reconcileOrphanedBackgroundParties();
    assert.deepStrictEqual(invalid.map(party => party.partyId), ['bgp_old'],
        'a bot outside the newest 2,000 that claims a party is seen');
    assert.deepStrictEqual(statuses, [{ partyId: 'bgp_old', status: 'dissolved' }]);

    BackgroundPartyState.active = () => [];
    const messages = [];
    coordinator.worker = { postMessage: message => messages.push(message) };
    coordinator.workerEpoch = 'every-state-test';
    coordinator.ready = true;
    coordinator.started = true;
    coordinator.contextIndex = () => ({ spots: new Map(), parties: new Map() });
    coordinator.snapshotEntry = (state) => ({ state: { characterId: state.characterId }, context: {} });
    const result = await coordinator.sendFullSnapshot();
    assert.strictEqual(result.ok, true);
    const sent = messages.filter(message => message.type === 'snapshot_page')
        .flatMap(message => message.payload.rows.map(row => row.state.characterId));
    assert.strictEqual(sent.length, COUNT, 'the full snapshot carries every state');
    assert.strictEqual(new Set(sent).size, COUNT);

    console.log('cold worker feeds see every state ok');
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
