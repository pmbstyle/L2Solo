const assert = require('assert');

const { createWorld } = require('./helpers/c4QuestHarness');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const HotPartyLifecycle = invoke('GameServer/Bot/Population/HotPartyLifecycle');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

function playerAt(locX, locY, locZ) {
    return {
        actor: {
            fetchLocX: () => locX,
            fetchLocY: () => locY,
            fetchLocZ: () => locZ
        }
    };
}

(async () => {
    // Main judges the state it holds: the bot is in its cache.
    const world = await createWorld([{ id: 7001 }], 'cold-visibility-handoff');
    await LifeState.init();
    const coordinator = new ColdSimulationCoordinator();
    const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
    const activationCandidate = state => PopulationService.activationCandidate(state);
    // The index answers by the asked radius, as World's does.
    let player = playerAt(1000, 2000, -4976);
    coordinator.population = {
        activationCandidate,
        realPlayerSessionsNear: (loc, radius) => player && Math.hypot(loc.locX - 1000, loc.locY - 2000) <= radius ? [player] : []
    };
    const visible = {
        characterId: 7001,
        activity: 'grouped',
        phase: 'cold',
        loc: { locX: 1200, locY: 2200, locZ: -4976 },
        stats: {},
        simulation: { revision: 1 }
    };
    await LifeState.upsertState(visible, 'visibility_fixture');
    assert.strictEqual(coordinator.visibleToRealPlayer(visible), true,
        'a cold actor on the player-visible floor must be protected from background resolution');
    assert.strictEqual(await coordinator.prepareProposal({
        characterId: visible.characterId,
        token: visible.simulation,
        nextState: { ...visible, activity: 'hunting' },
        result: { events: [] }
    }), null, 'a visible actor proposal must be rejected until hot activation owns it');

    // The refusal holds the bot for its activation (near_player) and the
    // activation's own rule picks which rows: a merchant or a shopless crafter,
    // which the scan never activates, steps on; so does a bot a player is near
    // but does not see (past the client's view).
    const held = { characterId: visible.characterId, nextState: { ...visible, activity: 'hunting' }, revision: 1 };
    await coordinator.prepareProposal(held);
    assert.strictEqual(held.prepareRefusal, 'near_player', 'the refusal names the hold for the worker');
    for (const [label, row] of [
        ['a merchant', { ...visible, activity: 'merchant' }],
        ['a crafter without a shop', { ...visible, activity: 'crafting' }],
        ['a member of a party the scan skips', { ...visible, party: { partyId: 'not-active-party', leaderId: 1 } }],
        ['a bot past the client view', { ...visible, loc: { locX: 8000, locY: 2000, locZ: -4976 } }]
    ]) {
        await LifeState.upsertState({ ...row, simulation: { revision: 1 } }, 'visibility_fixture');
        const proposal = { characterId: visible.characterId, nextState: { ...row, simulation: { revision: 1 } }, revision: 1 };
        assert.notStrictEqual(await coordinator.prepareProposal(proposal), null, `${label} near a player steps on`);
        assert.strictEqual(proposal.prepareRefusal, undefined, `${label} is not held`);
    }
    // A row the scan refused by its own state (it cannot be placed) will not turn hot
    // as it stands: it steps on, and a held one goes back to the worker.
    await LifeState.upsertState(visible, 'visibility_fixture');
    coordinator.population.nearActivationRefused = id => Number(id) === visible.characterId;
    const refusedProposal = { characterId: visible.characterId, nextState: { ...visible, activity: 'hunting' }, revision: 1 };
    assert.notStrictEqual(await coordinator.prepareProposal(refusedProposal), null, 'a row the scan cannot place steps on');
    assert.strictEqual(refusedProposal.prepareRefusal, undefined, 'a row the scan cannot place is not held');
    delete coordinator.population.nearActivationRefused;
    // Held until the player leaves: the scan's pass sends the row back to the worker, once.
    await LifeState.upsertState(visible, 'visibility_fixture');
    const marked = [];
    coordinator.markDirty = (state, options) => marked.push([state.characterId, options.reason]);
    coordinator.releaseNearHolds();
    assert.deepStrictEqual(marked, [], 'a held bot the player still sees stays held');
    player = null;
    coordinator.releaseNearHolds();
    coordinator.releaseNearHolds();
    assert.deepStrictEqual(marked, [[visible.characterId, 'near_player_left']], 'the player left: the row goes back to the worker once');
    player = playerAt(1000, 2000, -4976);
    delete coordinator.markDirty;

    assert.strictEqual(coordinator.visibleToRealPlayer({
        ...visible,
        loc: { locX: 20000, locY: 2200, locZ: -4976 }
    }), false, 'distant cold actors must remain eligible for background simulation');
    assert.strictEqual(coordinator.visibleToRealPlayer({ ...visible, activity: 'traveling' }), false,
        'persisted travel remains event-scheduled until hot route materialization exists');

    coordinator.population = { activationCandidate, realPlayerSessionsNear: () => [] };
    const transitioning = {
        ...visible,
        party: { partyId: 'visible-party', leaderId: visible.characterId }
    };
    await LifeState.upsertState(transitioning, 'visibility_fixture');
    HotPartyLifecycle.pending.add('visible-party');
    try {
        assert.strictEqual(await coordinator.prepareProposal({
            characterId: transitioning.characterId,
            token: transitioning.simulation,
            nextState: transitioning,
            result: { events: [] }
        }), null, 'a party being handed to hot lifecycle must reject new cold proposals');
    } finally {
        HotPartyLifecycle.pending.delete('visible-party');
    }

    await world.close();
    console.log('Cold visibility handoff checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
