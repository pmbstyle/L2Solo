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
    const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    // The coordinator asks the population service for the players near a row.
    coordinator.population = Object.assign(Object.create(PopulationService), {
        realPlayerSessionsNear: (loc, radius) => player && Math.hypot(loc.locX - 1000, loc.locY - 2000) <= radius ? [player] : []
    });
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
    // The near-player scan shows one row (its budget) and leaves the next one cold. The row it
    // left steps on until a later scan shows it: a cold row is invisible to the player, and the
    // activation fences the row before it reads it.
    const saved = { budget: Config.maxActivationsPerScan, sessions: PopulationService.realPlayerSessions,
        request: PopulationService.requestActivation, walkers: PopulationService.showWalkersNear, coldNear: LifeState.coldNear };
    const shown = [];
    Config.maxActivationsPerScan = 1;
    PopulationService.realPlayerSessions = () => [player];
    PopulationService.requestActivation = async state => { shown.push(state.characterId); return { ok: true, state }; };
    PopulationService.showWalkersNear = async (loc, activated) => activated;
    LifeState.coldNear = async () => [{ ...visible, characterId: 7002 }, visible];
    try {
        await PopulationService.activateNearPlayers();
    } finally {
        Config.maxActivationsPerScan = saved.budget;
        PopulationService.realPlayerSessions = saved.sessions;
        PopulationService.requestActivation = saved.request;
        PopulationService.showWalkersNear = saved.walkers;
        LifeState.coldNear = saved.coldNear;
    }
    assert.deepStrictEqual(shown, [7002], 'the scan shows the nearest row within its budget');
    const left = { characterId: visible.characterId, nextState: { ...visible, activity: 'hunting' }, revision: 1 };
    assert.notStrictEqual(await coordinator.prepareProposal(left), null, 'a visible row the scan left for its budget steps on');

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
