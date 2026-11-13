'use strict';
// An errand leaves the goal alone (decision 10-26): a bot focused on a gear goal
// keeps the focus while its survival stock takes the step, for any roll seed.
// Once the goal is done the next focus is a fresh choice; a rival that beats it
// by more than the bot's loyalty takes the focus, errand or not.
const assert = require('node:assert/strict');
require('../src/Global');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');

const GOAL = 'power:101:6', RIVAL = 'power:102:6', OTHER = 'power:103:7', STOCK = 'stock:1835';
const item = (id, price) => ({ key: `item:${id}`, paths: [{ kind: 'buy', activity: 'shopping', itemId: id, price }] });
const root = (key, valueHours, progressionPriority, requirements) => ({ key, need: 'power', valueHours, progressionPriority,
    paths: [{ requirements: requirements.map(([id, amount]) => ({ key: `item:${id}`, amount })) }] });
// The goal needs 2 x item 10 (held) and 2 x item 11; the rival needs the
// same 2 x item 10 and 1 x item 12, so alone it is the cheaper root.
const nodes = ({ rivalValue = 100, stockPriority = 0, goal = true, other = false } = {}) => [
    ...(goal ? [root(GOAL, 100, 3, [[10, 2], [11, 2]])] : []),
    root(RIVAL, rivalValue, 3, [[10, 2], [12, 1]]),
    ...(other ? [root(OTHER, 100, 3, [[13, 3]])] : []),
    root(STOCK, 5, stockPriority, [[20, 1]]),
    item(10, 100), item(11, 100), item(12, 100), item(13, 100), item(20, 10)];
const stockFor = id => ({ owned: id === 10 ? 2 : 0, incoming: 0 });
const build = (characterId, previous, options = {}) => new WishNetwork().build({ actorKey: `character:${characterId}`,
    inputKey: `loyalty:${characterId}:${JSON.stringify(options)}`, remembered: false, characterId, decisionSeq: 7,
    nodes: nodes(options), roots: nodes(options).filter(node => node.need).map(node => node.key), stockFor,
    wallet: 100000, hourAdena: 100, playedHours: 10, persona: { traits: { commitment: 0.5 } }, previous, reconsider: true });
const packet = result => ({ focus: result.focus, dormant: result.dormant });

const fresh = new Set();
let rivalWins = 0;
for (let characterId = 1; characterId <= 64; characterId++) {
    const start = { focus: [GOAL, 2, 400], dormant: [] };
    // Survival stock runs out: it takes the step and the money, not the focus.
    const errand = build(characterId, start, { stockPriority: 4, rivalValue: 10 });
    assert.equal(errand.focus[0], GOAL, `seed ${characterId}: the goal stays through the errand`);
    assert.equal(errand.focus[1], 2, 'with its age');
    assert.equal(errand.activity?.rootKey, STOCK, 'the errand is the next step');
    assert.equal(errand.queue[0]?.key, STOCK, 'and takes the money');
    assert.equal(build(characterId, packet(errand), { rivalValue: 10 }).focus[0], GOAL, 'restocked, the bot is on its goal');
    // A rival that beats the goal by more than the loyalty ends the hold, errand or not.
    if (build(characterId, start, { rivalValue: 1000, stockPriority: 4 }).focus[0] === RIVAL) rivalWins++;
    // The goal done: the next focus is a fresh choice among the rest.
    const done = build(characterId, packet(errand), { goal: false, other: true });
    assert.notEqual(done.focus[0], STOCK, 'the stock is no goal to resume');
    fresh.add(done.focus[0]);
}
assert(rivalWins >= 48, `a rival beyond the loyalty margin wins the focus (${rivalWins} of 64 seeds)`);
assert.deepEqual([...fresh].sort(), [RIVAL, OTHER].sort(), 'after the goal is done the focus is rolled afresh');
const alone = new WishNetwork().build({ actorKey: 'character:99', inputKey: 'alone', remembered: false, characterId: 99, decisionSeq: 7,
    nodes: [root(STOCK, 5, 4, [[20, 1]]), item(20, 10)], roots: [STOCK], stockFor, wallet: 100000, hourAdena: 100, playedHours: 10,
    persona: { traits: { commitment: 0.5 } }, previous: {}, reconsider: true });
assert.equal(alone.focus[0], STOCK, 'with no goal the stock is the focus');
console.log('wish goal loyalty ok');

// A board offer alone (offer_posted, MarketBuyerWaiters' wake) weighs the held step only
// against buying the offered item: a hunter who hears a WTS shout for an item he would not
// buy keeps hunting on the same seed, however a re-priced rival root reads; one whose buy
// of that item beats the hunt takes the shop step. Another situation of the build in the
// same wake (a full bag, one released at a stop) is the full reconsideration.
{
    const Situations = require('../src/GameServer/Bot/Situations');
    const HUNT = 'power:201:6', DEAR = 'power:202:7', CHEAP = 'power:203:8';
    const offerNetwork = new WishNetwork();
    const offerBuild = (decisionSeq, activityLeaf, dearValue, offered = 0) => offerNetwork.build({ actorKey: 'character:120',
        characterId: 120, inputKey: `offer:${dearValue}`, remembered: false, decisionSeq, activityLeaf, wallet: 10000, hourAdena: 100,
        persona: { traits: { commitment: 0.5 } }, previous: { focus: [HUNT, 0, 0] }, roots: [HUNT, DEAR, CHEAP], reconsider: true, offered,
        nodes: [{ key: HUNT, need: 'power', valueHours: 1, paths: [{ activity: 'hunting', costHours: 1 }] },
            ...[[DEAR, 202, dearValue], [CHEAP, 203, 0.2]].map(([key, itemId, valueHours]) => ({ key, need: 'power', valueHours,
                paths: [{ kind: 'buy', activity: 'shopping', itemId, costHours: 1, town: 'Giran', tripHours: 0, tripFees: 0 }] }))] });
    // The mind a build reads: its held build, the offer raised on it where it hunts.
    const mind = (...raises) => raises.reduce((stats, [name, payload = null, where = Situations.OPEN]) =>
        Situations.raise(stats, name, payload, where, 120), { woken: 0, waiting: 0, situationSeq: 4, wishSections: {}, earning: {} });
    const offered = (...raises) => Situations.offerWoke(mind(...raises));
    assert.equal(offered(['offer_posted', { itemId: 203, price: 10 }]), 203, 'an offer alone names its item to the build');
    assert.equal(offered(['offer_posted', { itemId: 203, price: 10 }], ['bag_full']), 0, 'a full bag after it: the full review');
    assert.equal(offered(['goal_done:goal'], ['offer_posted', { itemId: 203, price: 10 }]), 0, 'so does a step done before it');
    assert.equal(offered(['offer_posted', { itemId: 203, price: 10 }], ['offer_posted', { itemId: 203, price: 9 }]), 203,
        'the same item offered cheaper is the same offer');
    // A far bot on its hunt: a clan call waits for its next stop.
    const hunting = Situations.place({ phase: 'cold', activity: 'hunting' });
    const waited = mind(['clan_call', null, hunting], ['offer_posted', { itemId: 203, price: 10 }, hunting]);
    assert.equal(Situations.offerWoke(waited), 203, 'a call that waits for the next stop does not wake the build yet');
    assert.equal(Situations.offerWoke(Situations.stop(waited, Situations.REST, 120)), 0, 'its stop releases it: the full review');
    let huntLeaf = 0, huntSeq = 0;
    for (let seq = 1; !huntLeaf && seq <= 50; seq++) {
        const pick = offerBuild(seq, 0, 1);
        if (pick.activity?.activity === 'hunting') { huntLeaf = pick.activityLeaf; huntSeq = seq; }
    }
    assert(huntLeaf > 0, 'fixture: a held hunting step');
    let rolled = 0;
    for (let seq = huntSeq; seq < huntSeq + 30; seq++) {
        // The dear root re-priced past the loyalty margin: the full review rolls the step again.
        if (offerBuild(seq, huntLeaf, 6).decisionSeq !== seq) rolled++;
        const kept = offerBuild(seq, huntLeaf, 6, offered(['offer_posted', { itemId: 203, price: 10 }]));
        assert.equal(kept.activityLeaf, huntLeaf, 'an offer whose buy does not beat the hunt keeps the hunting step');
        assert.equal(kept.decisionSeq, seq, 'on the same seed');
        assert.equal(kept.focus[0], HUNT, 'and the focus');
        const bought = offerBuild(seq, huntLeaf, 6, offered(['offer_posted', { itemId: 202, price: 10 }]));
        assert.deepEqual([bought.activity.kind, bought.activity.itemId], ['buy', 202], 'an offer whose buy beats it takes the shop step');
        assert.equal(bought.decisionSeq, seq + 1, 'under a new seed');
        const full = offerBuild(seq, huntLeaf, 6, offered(['offer_posted', { itemId: 203, price: 10 }], ['bag_full']));
        assert.equal(full.decisionSeq, seq + 1, 'another situation in the wake rolls the step again');
    }
    assert.equal(rolled, 30, 'fixture: the full review rolls the held step');
    console.log('offer alone keeps the held step unless its buy beats it: PASS');
}
