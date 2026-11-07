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
