const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();

const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Data = invoke('GameServer/DataCache');

// The cleanup trip is decided by a build (a build bag_full wakes:
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
        projectResolve: async (state, stepResult) => ({ state: await project(state, stepResult) }),
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

    // The bag fact is what the bag holds, no price or board: its floor (2),
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

    // At its need the bag first clears the slots that bring too little to carry (EconomyContext.bagDecisions):
    // a row whose worth per slot is below theta = hourValue x tripHours / slots is destroyed when the
    // clearing frees at least the slots the spot fills in the trip's hours and the cleared bag then
    // needs no trip; else the bag goes to town and nothing is destroyed.
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    const tripHours = invoke('GameServer/Bot/Economy/WalkBack').hours(spots[0].id, {}, spots);
    assert(tripHours > 0, 'the spot has a walk back from town');
    const loot = Object.fromEntries(Array.from({ length: 45 }, (_, index) => {
        const selfId = 1864 + index;
        return [selfId, { selfId, name: `Material ${selfId}`, kind: 'Other.Material', stackable: true, amount: 1 }];
    }));
    const looter = bot(510, { inventory: loot });
    const worth = Disposition.clearingRows(looter).map(row => row.value).sort((a, b) => a - b);
    assert.strictEqual(worth.length, 45, 'every loot row may be cleared');
    // The hour's value that puts theta between the 30th and the 31st cheapest row.
    const hourFor = cheap => (worth[cheap - 1] + worth[cheap]) / 2 * 45 / tripHours;
    const hunt = (cheap, bagStacks = 1) => ({ hourAdena: hourFor(cheap), bestSpotId: spots[0].id, bagStacks });
    const answer = (state, base) => Economy.bagDecisions(state, base, { spots }, 3000);
    const cleared = answer(looter, hunt(30));
    assert.strictEqual(cleared.cleanupDue, null, 'a bag cleared below its count takes no trip');
    assert.strictEqual(cleared.bagClear.freed, 30);
    const cheapIds = Disposition.clearingRows(looter).filter(row => row.value < worth[30]).map(row => row.selfId).sort();
    assert.deepStrictEqual(cleared.bagClear.items.map(item => item.selfId).sort(), cheapIds, 'only the cheap rows are cleared');
    // The step that decided them destroys them at once, through its resolve on either thread: the far
    // step's commit carries the bag without them, and no trip.
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    // The stacks a bag holds (an emptied stack stays at amount 0 for the physical sync).
    const stacks = bag => Object.keys(bag).filter(key => bag[key].amount > 0).map(Number).sort();
    const trained = { classId: 0, classProgressionLevel: 40, classProgressionClassId: 0 };
    // The worker's round projection (no write, the class projected) with the step's decision packet.
    const decided = { persist: false, projectClassProgression: true, statsPacket: { bagClear: cleared.bagClear }, statsPacketBeforeResolve: true };
    const destroyed = (await step([bot(511, { inventory: loot, stats: trained })], { project: (state, stepResult) =>
        LifeState.prepareResolve(state, stepResult, decided) })).get(511);
    assert.deepStrictEqual(stacks(destroyed.nextState.inventory),
        Object.keys(loot).map(Number).filter(id => !cheapIds.includes(id)).sort(), 'the cleared slots leave the bag');
    assert.deepStrictEqual(destroyed.removedItemIds.sort(), cheapIds, 'the commit names the destroyed stacks');
    assert.strictEqual(destroyed.nextState.stats.bagClear, null, 'the clearing is spent');
    assert.strictEqual(destroyed.cleanupNeed, undefined, 'no trip starts');
    assert.strictEqual(destroyed.nextState.activity, 'hunting', 'the bot hunts on');
    // Main's resolve of a far step the worker decided (PopulationService: applyResolve, the same resolve
    // with the step's packet; its write and training left out here) destroys them in that step too.
    const mainResolved = await LifeState.prepareResolve(bot(513, { inventory: loot, stats: trained }), result({ timestamp: 3000 }), decided);
    assert.deepStrictEqual(stacks(mainResolved.inventory),
        Object.keys(loot).map(Number).filter(id => !cheapIds.includes(id)).sort(), 'main\'s resolve destroys the cleared slots');
    assert.strictEqual(mainResolved.stats.bagClear, null, 'and spends the clearing');
    // A bag of valuable loot (no row below theta) goes to town, nothing destroyed.
    const valuable = answer(looter, { ...hunt(30), hourAdena: worth[0] / 2 * 45 / tripHours });
    assert.strictEqual(valuable.cleanupDue?.reason, 'inventory_half_full');
    assert.strictEqual(valuable.bagClear, null, 'nothing is destroyed');
    // Too few cheap slots for the trip's hours of loot: the trip.
    const few = answer(looter, hunt(30, Math.ceil(31 / tripHours)));
    assert.strictEqual(few.cleanupDue?.reason, 'inventory_half_full', 'a clearing that buys less than the trip is no answer');
    assert.strictEqual(few.bagClear, null);
    // A clearing after which the bag still needs its trip is dropped: the trip sells those rows.
    const still = answer(looter, hunt(3));
    assert.strictEqual(still.cleanupDue?.reason, 'inventory_half_full', 'three cleared slots leave the bag at its count');
    assert.strictEqual(still.bagClear, null);
    // A party member's bag goes by its stay: no clearing.
    assert.deepStrictEqual(answer(bot(512, { inventory: loot, partyId: 'p' }), hunt(30)), { cleanupDue: null, bagClear: null });
    // Protected slots are never cleared, whatever they are worth: a worn piece, a quest item, the kit's
    // potions and Scrolls of Escape, beginner shots, a material a wished craft holds.
    const Template = id => Data.items.find(item => item.selfId === id);
    const quest = Data.items.find(item => item.template.kind === 'Other.Quest');
    const sword = Data.items.find(item => item.template.kind === 'Weapon.Sword' && item.etc?.rank === 'none');
    assert(quest && sword, 'the catalogue supplies a quest item and a no-grade sword');
    // The bot's own kit potion (a potion it does not use is loot like any other).
    const potion = Number(invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(bot(513)).selfId);
    const kept = { ...loot,
        [sword.selfId]: { selfId: sword.selfId, name: sword.template.name, kind: sword.template.kind, stackable: false, amount: 1,
            equipped: true, instances: [{ id: 9900001, amount: 1, enchant: 0, equipped: true, slot: 7 }] },
        [quest.selfId]: { selfId: quest.selfId, name: quest.template.name, kind: quest.template.kind, stackable: true, amount: 1 },
        [potion]: { selfId: potion, name: Template(potion).template.name, kind: Template(potion).template.kind, stackable: true, amount: 5 },
        736: { selfId: 736, name: Template(736).template.name, kind: Template(736).template.kind, stackable: true, amount: 1 },
        5789: { selfId: 5789, name: Template(5789).template.name, kind: Template(5789).template.kind, stackable: true, amount: 100 } };
    // A row counts the slots the destroy frees, the copies it takes (unworn, named): a piece whose only
    // listed copy is worn, its second copy not yet listed, frees none.
    const wornOnly = { [sword.selfId]: { ...kept[sword.selfId], amount: 2 } };
    assert.deepStrictEqual(Disposition.clearingRows(bot(515, { inventory: wornOnly })), [], 'a worn copy frees no slot');
    const reservedMaterial = 1864;
    const keeper = bot(513, { inventory: kept, stats: { classId: 0, craftHold: [['craft:test', [[reservedMaterial, 1]]]] } });
    const all = answer(keeper, { ...hunt(30), hourAdena: worth[44] * 1000 * 51 / tripHours });
    const protectedIds = [sword.selfId, quest.selfId, potion, 736, 5789, reservedMaterial];
    assert(all.bagClear, 'the loot is cleared');
    assert.deepStrictEqual(all.bagClear.items.filter(item => protectedIds.includes(item.selfId)), [], 'no protected slot is cleared');
    assert.strictEqual(Economy.bagDecisions({ ...keeper, inventory: Object.fromEntries(protectedIds.map(id => [id, kept[id]])) },
        { ...hunt(30), hourAdena: 1e12 }, { spots }, 3000).bagClear, null, 'a bag of protected slots clears nothing');

    // The deciding build's baseline is the bag its clearing leaves: the cleared slots are destroyed with
    // its answer, so loot that brings the bag back to its count raises bag_full again (the next decision).
    invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(() => null, () => true);
    invoke('GameServer/Bot/Population/RecomputeGeneration').configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
    const board = new (invoke('GameServer/AfkTrade/BoardIndex').BoardIndex)();
    Economy.configure({ board: () => board, spots: () => spots });
    invoke('GameServer/Bot/Population/PopulationConfig').knowledgeErrorsEnabled = false;
    // Tattoos at a worth of 1 each are the cheap slots; the materials are worth far more than a slot's share.
    const tattoos = Data.items.filter(item => item.template.kind === 'Other.Tattoo').slice(0, 60)
        .map(item => [item.selfId, { selfId: item.selfId, name: item.template.name, kind: item.template.kind, stackable: false, amount: 1 }]);
    const cheapBag = { ...Object.fromEntries(Object.entries(loot).slice(0, 15)), ...Object.fromEntries(tattoos.slice(0, 30)) };
    const now = Date.now();
    // Hunting on the spot of its level farthest from town (a trip worth saving).
    const WalkBack = invoke('GameServer/Bot/Economy/WalkBack');
    const far = spots.filter(spot => spot.minLevel <= 40 && spot.maxLevel >= 40)
        .reduce((best, spot) => WalkBack.hours(spot.id, {}, spots) > WalkBack.hours(best.id, {}, spots) ? spot : best);
    const hunter = bot(514, { adena: 50000, inventory: cheapBag, updatedAt: now, spotId: far.id,
        stats: { classId: 0, exp: Data.experience[39], earning: { spotId: far.id } }, timing: {} });
    const built = Economy.forState(hunter, { timestamp: now, memoryIdentity: 'fixture-memory', sourceReady: true, caller: 'step' }).statsPacket;
    assert(built.bagClear && !built.cleanupDue, 'the build clears the cheap slots instead of a trip');
    const huntsOn = Break.applyClear({ ...hunter, stats: { ...hunter.stats, ...built } });
    assert.strictEqual(Break.bagFact(huntsOn), 0, 'the cleared bag is below its count');
    const refilled = { ...huntsOn, inventory: { ...huntsOn.inventory, ...Object.fromEntries(tattoos) }, updatedAt: now + 1 };
    assert.strictEqual(Break.bagFact(refilled), 1, 'fixture: the loot brings the bag back to its count');
    assert(Situations.detect(huntsOn, refilled).includes('bag_full'), 'the refill to the count after a clear raises bag_full');

    console.log('Cold worker cleanup need checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
