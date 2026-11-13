const assert = require('assert');

const { createWorld, Database } = require('./helpers/c4QuestHarness');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ColdSimulationOwner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const InventorySummary = invoke('GameServer/Bot/Population/InventorySummary');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

const originals = {
    applyResolve: LifeState.applyResolve,
    upsertState: LifeState.upsertState,
    recordMany: LifeEvents.recordMany
};

function hunter(characterId) {
    return {
        characterId,
        name: `Overloaded${characterId}`,
        phase: 'cold',
        activity: 'hunting',
        level: 40,
        exp: 1000000,
        adena: 5000,
        currentRegion: 'Cruma Tower',
        spotId: '14_114',
        loc: { locX: 14500, locY: 114000, locZ: -2400 },
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        inventory: {},
        stats: {},
        timing: {}
    };
}

const fightResult = () => ({
    patch: {},
    events: [{ type: 'fight_won', npcId: 20001 }],
    materialize: { exp: 500, sp: 0, adena: 600, items: [] },
    debug: { fights: 2, wins: 2 }
});

(async () => {
    // Main commits over the state it holds: the bots are in its cache.
    const world = await createWorld([{ id: 7301, level: 40 }, { id: 7303, level: 40 }], 'cold-cleanup-keeps-resolve');
    try {
        await LifeState.init();
        // Resolver path: the worker's projected state already holds the fight.
        const coordinator = new ColdSimulationCoordinator();
        coordinator.population = {
            realPlayerSessions: () => [],
            prepareInventoryCleanupProposal: (...args) => PopulationService.prepareInventoryCleanupProposal(...args)
        };
        const base = await LifeState.upsertState(hunter(7301), 'cleanup_resolve_fixture');
        const simulation = base.simulation;
        const proposal = {
            characterId: 7301,
            revision: simulation.revision,
            enqueuedAt: Date.now(),
            ...InventorySummary.bagChange(base.inventory, base.inventory),
            nextState: { ...base, exp: base.exp + 500, adena: base.adena + 600 },
            // The worker found the bag over the author's cleanup threshold.
            cleanupNeed: { reason: 'market_surplus_inventory', slots: 40, npcOnlySlots: 0 },
            result: fightResult()
        };
        const prepared = await coordinator.prepareProposal(proposal);
        assert(prepared?.stats?.forcedMarketCleanup, 'the bot still starts its forced cleanup trip');
        assert.strictEqual(prepared.activity, 'traveling');
        assert.strictEqual(prepared.exp, base.exp + 500, 'the fight\'s exp is kept');
        // The trip goes to the town its shop-town roll chose (group C) and may
        // pay a gatekeeper on the way: the fee is the trip's, not the fight's.
        const tripFee = (state) => Number(state.stats?.travel?.paid?.fee || 0);
        assert.strictEqual(prepared.adena, base.adena + 600 - tripFee(prepared), 'the fight\'s adena is kept');
        assert.strictEqual(proposal.result.events.length, 1, 'the fight\'s events are still recorded');
        assert.strictEqual(prepared.simulation?.revision, simulation.revision, 'the commit keeps the step base revision');

        // The cleanup still outranks a route trip the worker started this resolve.
        const routed = await coordinator.prepareProposal({
            ...proposal,
            result: fightResult(),
            nextState: { ...base, activity: 'traveling', exp: base.exp + 500,
                stats: { travel: { spotId: 'no_such_spot', reason: 'level_replan', arrivalActivity: 'hunting' } } }
        });
        assert(routed?.stats?.forcedMarketCleanup, 'the forced cleanup replaces the worker\'s route trip');
        assert.strictEqual(routed.stats.travel?.reason, 'market_sale_inventory');
        assert.strictEqual(routed.exp, base.exp + 500, 'and the fight before it is kept');

        // A bot that died in the fight stays dead; the cleanup waits (the
        // worker sends no need for it).
        const died = await coordinator.prepareProposal({
            ...proposal,
            cleanupNeed: undefined,
            result: fightResult(),
            nextState: { ...base, activity: 'dead' }
        });
        assert.strictEqual(died.activity, 'dead');
        assert(!died.stats?.forcedMarketCleanup);

        // The trip pays on main (the bot's last Scroll of Escape, a gatekeeper
        // fee) over a step that left the bag as it was: the commit still writes
        // what the trip took from the bag.
        const payerId = 7303;
        await Database.setItem(payerId, { selfId: 736, amount: 1, slot: 0 });
        await Database.setItem(payerId, { selfId: 57, amount: 5000, slot: 0 });
        const payerBag = LifeState.inventorySummaryFromItems(await Database.fetchItems(payerId));
        const payer = await LifeState.upsertState({ ...hunter(payerId), adena: Number(payerBag[57].amount),
            inventory: payerBag }, 'cleanup_resolve_fixture');
        const walletBefore = await world.amount(payerId, 57);
        const paying = {
            characterId: payerId,
            revision: payer.simulation.revision,
            enqueuedAt: Date.now(),
            ...InventorySummary.bagChange(payer.inventory, payer.inventory),
            nextState: { ...payer, exp: payer.exp + 500 },
            cleanupNeed: { reason: 'market_surplus_inventory', slots: 40, npcOnlySlots: 0 },
            result: fightResult(),
            options: { allowLifecycle: true }
        };
        const trip = await coordinator.prepareProposal(paying);
        assert.strictEqual(trip?.stats?.travel?.paid?.scroll, 736, 'fixture: the cleanup trip reads the bot\'s last scroll');
        // The commit queue's prepared entry (ColdCommitQueue) to the owner.
        const [paid] = await ColdSimulationOwner.commitBatch([{ proposal: paying, revision: paying.revision,
            nextState: trip, options: paying.options }], { timestamp: Date.now() });
        assert(paid.ok, 'the paid trip commits');
        assert.strictEqual(await world.amount(payerId, 736), 0, 'the read scroll leaves the physical bag');
        assert.strictEqual(await world.amount(payerId, 57), walletBefore - tripFee(trip), 'the fee leaves the physical wallet');

        // Command path: the worker's precomputed fight is applied before the
        // trip the build decided (its held stats.cleanupDue); main starts it there.
        const applied = [];
        const recorded = [];
        LifeState.applyResolve = async (state, result) => {
            applied.push(result);
            return { ...state, exp: state.exp + result.materialize.exp, adena: state.adena + result.materialize.adena };
        };
        LifeState.upsertState = async (state) => state;
        LifeEvents.recordMany = async (characterId, events) => { recorded.push(...events); };
        const commandState = { ...hunter(7302), stats: { cleanupDue: { reason: 'market_surplus_inventory', slots: 40, npcOnlySlots: 0 } } };
        const command = await PopulationService.resolveColdState(commandState, { precomputedResult: fightResult() });
        assert.strictEqual(command.ok, true);
        assert.strictEqual(applied.length, 1, 'the worker result is applied');
        assert(command.state.stats?.forcedMarketCleanup, 'the cleanup trip starts after it');
        assert.strictEqual(command.state.activity, 'traveling');
        assert.strictEqual(command.state.exp, commandState.exp + 500);
        assert.strictEqual(command.state.adena, commandState.adena + 600 - tripFee(command.state));
        assert.strictEqual(recorded.length, 1);

        console.log('Cold cleanup keeps the resolve checks passed');
    } finally {
        Object.assign(LifeState, { applyResolve: originals.applyResolve, upsertState: originals.upsertState });
        LifeEvents.recordMany = originals.recordMany;
        await world.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
