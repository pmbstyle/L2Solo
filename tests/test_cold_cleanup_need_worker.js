const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();

const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Data = invoke('GameServer/DataCache');

// The cleanup trip is decided by a build (situations step 4 C4, the build bag_full wakes:
// PartyMarketBreak.cleanupDecision) and held in stats.cleanupDue until it starts: the
// first step that finds the bot free after its fight carries the need to main, which
// starts the trip. A bot with no decided trip carries none (no per-step bag check).
const book = Data.items.find(item => item.template.kind === 'Other.Spellbook');
assert(book, 'the native catalogue supplies a nonstackable book');
// 81 single books: over the native 80-slot floor.
const fullBag = { [book.selfId]: { selfId: book.selfId, name: book.template.name, kind: book.template.kind,
    amount: 81, stackable: false,
    instances: Array.from({ length: 81 }, (_, i) => ({ id: 9700000 + i, amount: 1, equipped: false })) } };

function bot(characterId, overrides = {}) {
    return { characterId, name: `Bag${characterId}`, phase: 'cold', activity: 'hunting', level: 40,
        vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 }, inventory: fullBag,
        timing: { lastResolvedAt: 1000, nextResolveAt: 2000 }, stats: { classId: 0 },
        simulation: { revision: 3 }, updatedAt: 1000, ...overrides };
}

const result = ({ timestamp }) => ({ patch: {}, materialize: { exp: 0, sp: 0, adena: 0, items: [] },
    events: [], nextResolveAt: timestamp + 30000, debug: {} });

// One step of each bot; the proposals the worker sends main, by bot.
async function step(states, { project = state => state } = {}) {
    const sent = new Map();
    const spots = new Map();
    const kernel = new ColdSimulationKernel({
        now: () => 3000,
        spotOf: value => spots.get(Number(value?.characterId)) || null,
        resolveSolo: result,
        planLifecycle: async () => ({}),
        projectResolve: state => ({ state: project(state) }),
        emit: (type, payload) => {
            if (type === 'proposal_batch') for (const proposal of payload.proposals) sent.set(proposal.characterId, proposal);
        }
    });
    for (const state of states) {
        spots.set(Number(state.characterId), { id: 'bag-spot', rewards: {} });
        kernel.upsert({ state });
    }
    kernel.tick();
    await kernel.resolveChain;
    kernel.flush(null, true);
    return sent;
}

(async () => {
    const Break = invoke('GameServer/Bot/Population/PartyMarketBreak');
    const due = Break.cleanupDecision(bot(500), 3000);
    assert.strictEqual(due?.reason, 'inventory_capacity', 'a full bag sends the bot to sell');
    assert.strictEqual(due.slots, 81);
    const held = (overrides = {}) => bot(overrides.characterId, { ...overrides, stats: { classId: 0, cleanupDue: due, ...overrides.stats } });
    // A solo hunter whose build decided the trip: the proposal carries the held need.
    const solo = (await step([held({ characterId: 501 })])).get(501);
    assert(solo, 'the step reaches main');
    assert.strictEqual(solo.cleanupNeed?.reason, 'inventory_capacity');
    // The same bag with no trip decided: nothing (the step does not read the bag).
    const undecided = (await step([bot(507)])).get(507);
    assert(undecided, 'the step reaches main');
    assert.strictEqual(undecided.cleanupNeed, undefined, 'only a decided trip starts');

    // A route trip this step started does not hide the need: the cleanup outranks it.
    const routed = (await step([held({ characterId: 502 })], { project: state => ({ ...state, activity: 'traveling',
        stats: { ...state.stats, travel: { spotId: 'elsewhere', reason: 'level_replan', arrivalAt: 90000 } } }) })).get(502);
    assert.strictEqual(routed.cleanupNeed?.reason, 'inventory_capacity');

    // A bot that died in the fight waits: no trip yet, the hold stays for a later step.
    const died = (await step([held({ characterId: 503 })], { project: state => ({ ...state, activity: 'dead',
        vitals: { ...state.vitals, hp: 0 } }) })).get(503);
    assert(died, 'the step reaches main');
    assert.strictEqual(died.cleanupNeed, undefined, 'a dead bot does not start a cleanup trip');
    assert.strictEqual(died.nextState.stats.cleanupDue, due, 'its decided trip is held');

    // A bot already on a trip when the step started: no trip yet.
    const traveling = (await step([held({ characterId: 504, activity: 'traveling',
        stats: { travel: { spotId: 'elsewhere', reason: 'level_replan', arrivalAt: 2500 } } })])).get(504);
    assert(traveling, 'the step reaches main');
    assert.strictEqual(traveling.cleanupNeed, undefined, 'a traveling bot keeps its trip');

    // A half-full bag sends the bot to sell, unless its last visit could not
    // place these goods and nothing new came (stats.marketSellSeen): then it hunts on.
    // The build reads that sale retry when it decides.
    const halfFull = Object.fromEntries(Array.from({ length: 40 }, (_, index) => {
        const selfId = 1864 + index;
        return [selfId, { selfId, name: `Material ${selfId}`, kind: 'Other.Material', stackable: true, amount: 1 }];
    }));
    assert.strictEqual(Break.cleanupDecision(bot(505, { inventory: halfFull }), 3000)?.reason, 'inventory_half_full');
    assert.strictEqual(Break.cleanupDecision(bot(506, { inventory: halfFull,
        stats: { classId: 0, marketSellSeen: { items: Object.keys(halfFull).map(Number), buyers: null } } }), 3000), null,
    'a sell pause holds the half-full trip');
    assert.strictEqual(Break.cleanupDecision(bot(506, { partyId: 'p' }), 3000), null, 'a party member sells from the field');
    // At its floor (overweight) the bag leaves even while the sale retry holds: nothing
    // would wake the build again (the bag fact stays at its floor).
    const stone = Data.items.find(item => item.selfId === 1704);
    const heavy = { 1704: { selfId: 1704, name: stone.template.name, kind: stone.template.kind, stackable: true,
        amount: Math.ceil(invoke('GameServer/Bot/Population/ColdCombatProfile').profileFor(bot(509), 0).maxLoad * 0.55 / stone.template.mass) } };
    const retried = bot(509, { inventory: heavy, stats: { classId: 0, marketSellSeen: { items: [1704], buyers: null } } });
    assert.strictEqual(Break.bagFact(retried), 2, 'a bag past half its load is at its floor');
    assert.strictEqual(Break.cleanupDecision(retried, 3000)?.reason, 'inventory_overweight', 'the floor sends the bot to town past the retry');

    // The bag fact (situations.md F2) is what the bag holds, no price or board: its floor (2),
    // a cleanup count (1: a solo bot's half bag) or none. Its rise raises bag_full once (it
    // wakes the build), a bag that stays raises nothing more, its floor after a count again.
    assert.deepStrictEqual([bot(508, { inventory: {} }), bot(508, { inventory: halfFull }), bot(508)].map(state => Break.bagFact(state)), [0, 1, 2]);
    assert.strictEqual(Break.bagFact(bot(508, { inventory: halfFull, partyId: 'p' })), 0, 'a member\'s half bag is no count');
    const Situations = invoke('GameServer/Bot/Situations');
    const empty = bot(508, { inventory: {} }), half = bot(508, { inventory: halfFull }), full = bot(508);
    assert(Situations.detect(empty, full).includes('bag_full'), 'the bag coming to need town raises bag_full');
    assert(Situations.detect(empty, half).includes('bag_full'), 'a cleanup count does');
    assert(Situations.detect(half, full).includes('bag_full'), 'and its floor after it');
    assert(!Situations.detect(full, { ...full, updatedAt: 2000 }).includes('bag_full'), 'a bag that stays full raises nothing');
    assert(!Situations.detect(empty, { ...empty, updatedAt: 2000 }).includes('bag_full'));

    console.log('Cold worker cleanup need checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
