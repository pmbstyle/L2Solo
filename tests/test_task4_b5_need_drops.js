'use strict';
// Material that reaches the bag by loot or spoil (no purchase event) shrinks the same need.
// Cold: the stale card and a fresh rebuild both order 14 instead of 24, under the same root, one advert row.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-need-drops-'));
const config = path.join(dir, 'config.ini');
fs.writeFileSync(config, fs.readFileSync(path.join(__dirname, '../config/default.ini'), 'utf8')
    + `\n[Database]\npath=${path.join(dir, 'world.sqlite')}\nhistoryPath=${path.join(dir, 'history.sqlite')}\n`);
process.env.L2NODE_CONFIG_FILE = config;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
invoke('GameServer/DataCache').init();
const { WishNetwork } = invoke('GameServer/Bot/Economy/WishNetwork');
const Intent = invoke('GameServer/Bot/Economy/TradeIntent');
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const { capture } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');

const itemId = 1864; // Stem: a craft material, no equipment slot
const buy = { kind: 'buy', activity: 'shopping', price: 2, itemId, executable: true, quoted: true, availableUnits: 100 };
const material = { key: `item:${itemId}`, price: 2, paths: [buy] };
const product = { key: 'item:101', price: 500, paths: [{ kind: 'craft', activity: 'crafting', costHours: .1,
    itemId: 101, productCount: 2, recipeId: 7, grossRequirements: [{ key: material.key, amount: 10 }],
    requirements: [{ key: material.key, amount: 6 }] }] };
const root = { key: 'power:101:7', need: 'power', valueHours: 100, object: { itemId: 101 },
    paths: [{ requirements: [{ key: product.key, amount: 5 }] }] };
const build = (owned, nodes = [root, product, material]) => new WishNetwork().build({ actorKey: 'need-drops',
    inputKey: `owned:${owned}`, nodes, roots: [root.key], wallet: 10000, hourAdena: 100,
    stockFor: id => id === itemId ? { owned, incoming: 2 } : {}, persona: { traits: { commitment: 0 } }, remembered: false });
const stateWith = owned => ({ characterId: 9102, phase: 'cold', level: 30, adena: 50000, updatedAt: 1000,
    currentRegion: 'Dion', vitals: { hp: 900, maxHp: 1000, mp: 400, maxMp: 500 }, acceptedIncoming: { [itemId]: 2 },
    inventory: { 57: { selfId: 57, amount: 50000 }, [itemId]: { selfId: itemId, amount: owned } } });
const goalOf = (state, economy) => Needs.evaluate(state, { now: 1000, errand: null, economy })
    .find(goal => goal.target?.itemId === itemId);

// Cold: owned 4 + incoming 2 of three whole batches (30) -> 24.
const before = build(4), decided = stateWith(4);
assert.equal(before.activity.amount, 24);
assert.equal(before.activity.rootKey, root.key);
const card = capture({ network: before, inputKey: 'owned:4' }, decided).activity;
assert.equal(card.heldAtDecision, 6, 'bag 4 + accepted incoming 2');
assert.equal(goalOf(decided, { network: { activity: card }, inputHash: 1, state: decided }).target.amount, 24);
// Ten units looted (no purchase event): the stale card orders only the rest.
const looted = stateWith(14);
const stale = goalOf(looted, { network: { activity: card }, inputHash: 1, state: decided });
assert.equal(stale.target.amount, 14, 'units gained since the decision fill the same order');
assert.equal(stale.plan.wishKey, root.key);
// The next resolve re-derives the same root with the smaller need.
const after = build(14);
assert.equal(after.activity.amount, 14);
assert.equal(after.activity.rootKey, root.key, 'same root, no new one for the looted units');
assert.deepEqual([...after.plans.keys()].filter(key => String(key).startsWith('power:')), [root.key]);
const rows = Intent.project({}, after, {}, () => 2).filter(row => row.itemId === itemId);
assert.equal(rows.length, 1, 'one advert row for the root');
assert.equal(rows[0].amount, 14);
const fresh = capture({ network: after, inputKey: 'owned:14' }, looted).activity;
assert.equal(goalOf(looted, { network: { activity: fresh }, inputHash: 2, state: looted }).target.amount, 14,
    'fresh card and stale card agree');

// A near bot's card is taken in the worker on its post by the same capture and read through
// its held view (DecisionEvents.receive), so the cold result above is its result too
// (test_worker_economy_publication.js, test_near_decision_order.js).
assert.equal(invoke('Database').isReady(), false);
console.log('Task 4 B5 need drops: cold 24 -> 14 on loot under one root');
fs.rmSync(dir, { recursive: true, force: true });
