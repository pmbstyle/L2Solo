const assert = require('assert');

require('../src/Global');

const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

DataCache.init();

const originals = {
    inventoryCleanupNeed: ItemDisposition.inventoryCleanupNeed,
    applyResolve: LifeState.applyResolve,
    upsertState: LifeState.upsertState,
    recordMany: LifeEvents.recordMany
};

function hunter(characterId, token) {
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
        timing: {},
        ...(token ? { simulation: token } : {})
    };
}

const fightResult = () => ({
    patch: {},
    events: [{ type: 'fight_won', npcId: 20001 }],
    materialize: { exp: 500, sp: 0, adena: 600, items: [] },
    debug: { fights: 2, wins: 2 }
});

(async () => {
    try {
        // Every bot is over the author's cleanup threshold.
        ItemDisposition.inventoryCleanupNeed = () => ({ reason: 'market_surplus_inventory', slots: 40, npcOnlySlots: 0 });

        // Resolver path: the worker's projected state already holds the fight.
        const coordinator = new ColdSimulationCoordinator();
        coordinator.population = {
            realPlayerSessions: () => [],
            prepareInventoryCleanupProposal: (...args) => PopulationService.prepareInventoryCleanupProposal(...args)
        };
        const token = { characterId: 7301, ownerId: 'cold_worker', revision: 3, leaseId: 'cleanup-lease', leaseUntil: Date.now() + 60000 };
        const base = hunter(7301, token);
        const proposal = {
            characterId: 7301,
            token,
            enqueuedAt: Date.now(),
            baseState: base,
            nextState: { ...base, exp: base.exp + 500, adena: base.adena + 600 },
            result: fightResult()
        };
        const prepared = await coordinator.prepareProposal(proposal);
        assert(prepared?.stats?.forcedMarketCleanup, 'the bot still starts its forced cleanup trip');
        assert.strictEqual(prepared.activity, 'traveling');
        assert.strictEqual(prepared.exp, base.exp + 500, 'the fight\'s exp is kept');
        assert.strictEqual(prepared.adena, base.adena + 600, 'the fight\'s adena is kept');
        assert.strictEqual(proposal.result.events.length, 1, 'the fight\'s events are still recorded');
        assert.strictEqual(prepared.simulation?.leaseId, token.leaseId, 'the commit keeps the worker lease');

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

        // A bot that died in the fight stays dead; the cleanup waits.
        const died = await coordinator.prepareProposal({
            ...proposal,
            result: fightResult(),
            nextState: { ...base, activity: 'dead' }
        });
        assert.strictEqual(died.activity, 'dead');
        assert(!died.stats?.forcedMarketCleanup);

        // An atomic group commits all members or none: a member its party
        // releases in this commit is judged as claimed (still in the party).
        const member = { ...hunter(7303, { ...token, characterId: 7303 }), activity: 'grouped',
            party: { partyId: 'dissolving', leaderId: 7303 } };
        const released = await coordinator.prepareProposal({
            characterId: 7303,
            token: { ...token, characterId: 7303 },
            enqueuedAt: Date.now(),
            baseState: member,
            atomicGroup: { id: 'party:dissolving', memberIds: [7303] },
            nextState: { ...member, activity: 'hunting', party: { partyId: null }, exp: member.exp + 500 },
            result: fightResult()
        });
        assert(released, 'a released party member does not fail its atomic group');
        assert.strictEqual(released.exp, member.exp + 500);
        assert(!released.stats?.forcedMarketCleanup);

        // Command path: the worker's precomputed fight is applied before the trip.
        const applied = [];
        const recorded = [];
        LifeState.applyResolve = async (state, result) => {
            applied.push(result);
            return { ...state, exp: state.exp + result.materialize.exp, adena: state.adena + result.materialize.adena };
        };
        LifeState.upsertState = async (state) => state;
        LifeEvents.recordMany = async (characterId, events) => { recorded.push(...events); };
        const commandState = hunter(7302);
        const command = await PopulationService.resolveColdState(commandState, { precomputedResult: fightResult() });
        assert.strictEqual(command.ok, true);
        assert.strictEqual(applied.length, 1, 'the worker result is applied');
        assert(command.state.stats?.forcedMarketCleanup, 'the cleanup trip starts after it');
        assert.strictEqual(command.state.activity, 'traveling');
        assert.strictEqual(command.state.exp, commandState.exp + 500);
        assert.strictEqual(command.state.adena, commandState.adena + 600);
        assert.strictEqual(recorded.length, 1);

        console.log('Cold cleanup keeps the resolve checks passed');
    } finally {
        Object.assign(ItemDisposition, { inventoryCleanupNeed: originals.inventoryCleanupNeed });
        Object.assign(LifeState, { applyResolve: originals.applyResolve, upsertState: originals.upsertState });
        LifeEvents.recordMany = originals.recordMany;
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
