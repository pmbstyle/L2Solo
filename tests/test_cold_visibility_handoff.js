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
    // The index answers by the asked radius, as World's does.
    const player = playerAt(1000, 2000, -4976);
    // The rows the near-player scan takes (left for its budget): its answer.
    let taking = new Set();
    coordinator.population = {
        nearActivationTakes: id => taking.has(Number(id)),
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
    // A row near a player that the scan does not take (it refused it, it is on another
    // floor or past what the scan reads) steps on.
    const free = { characterId: visible.characterId, nextState: { ...visible, activity: 'hunting' }, revision: 1 };
    assert.notStrictEqual(await coordinator.prepareProposal(free), null, 'a visible row the scan does not take steps on');
    assert.strictEqual(free.prepareRefusal, undefined, 'a visible row the scan does not take is not held');
    // A row the scan takes waits for its activation: the refusal holds it (near_player).
    await LifeState.upsertState(visible, 'visibility_fixture');
    taking = new Set([visible.characterId]);
    const held = { characterId: visible.characterId, nextState: { ...visible, activity: 'hunting' }, revision: 1 };
    assert.strictEqual(await coordinator.prepareProposal(held), null, 'a row the scan takes must wait for hot activation');
    assert.strictEqual(held.prepareRefusal, 'near_player', 'the refusal names the hold for the worker');
    // Held while the scan takes it: once it no longer does, the scan's pass sends the row back to the worker, once.
    const marked = [];
    coordinator.markDirty = (state, options) => marked.push([state.characterId, options.reason]);
    coordinator.releaseNearHolds();
    assert.deepStrictEqual(marked, [], 'a held bot the scan still takes stays held');
    taking = new Set();
    coordinator.releaseNearHolds();
    coordinator.releaseNearHolds();
    assert.deepStrictEqual(marked, [[visible.characterId, 'near_player_left']], 'the scan no longer takes it: the row goes back to the worker once');
    delete coordinator.markDirty;

    assert.strictEqual(coordinator.visibleToRealPlayer({
        ...visible,
        loc: { locX: 20000, locY: 2200, locZ: -4976 }
    }), false, 'distant cold actors must remain eligible for background simulation');
    assert.strictEqual(coordinator.visibleToRealPlayer({ ...visible, activity: 'traveling' }), false,
        'persisted travel remains event-scheduled until hot route materialization exists');

    coordinator.population = { realPlayerSessionsNear: () => [] };
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
