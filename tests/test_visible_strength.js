// U26: one "can I win?" verdict from what a player can see.
const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const BackpackModel = invoke('GameServer/Model/Backpack');
const V = require('../src/GameServer/Social/VisibleStrength');
const saved = Config.pvpAggression;
Config.pvpAggression = 0.5;

// Weapon glow by the C4 client steps; armour enchant is not visible.
assert.deepStrictEqual([0, 3, 4, 6, 7, 15, 16, 25].map(V.glow), [0, 0, 1, 1, 2, 2, 3, 3]);
const L = (w, e, b) => V.look(w, e, b);
assert.strictEqual(V.compare(L('c', 0, 'd'), L('d', 0, 'd')), 1, 'higher weapon grade looks stronger');
assert.strictEqual(V.compare(L('d', 0, 'd'), L('d', 0, 'c')), -1, 'lower body armour grade looks weaker');
assert.strictEqual(V.compare(L('d', 3, 'd'), L('d', 0, 'd')), 0, '+3 does not glow: equal');
assert.strictEqual(V.compare(L('d', 4, 'd'), L('d', 0, 'd')), 1, 'a faint glow from +4');
assert.strictEqual(V.compare(L('d', 7, 'd'), L('d', 6, 'd')), 1, 'the effect from +7');
assert.strictEqual(V.compare(L('d', 15, 'd'), L('d', 7, 'd')), 0, '+7..+15 are one step');
assert.strictEqual(V.compare(L('d', 16, 'd'), L('d', 15, 'd')), 1, 'red from +16');
assert.strictEqual(V.compare(L('d', 16, 'none'), L('c', 0, 'none')), -1, 'a glow never beats a higher grade');
assert.strictEqual(V.compare(L('c', 0, 'none'), L('d', 0, 'd')), 0, 'better weapon, worse armour: cannot tell');
assert.strictEqual(V.compare(V.NOTHING, L(null, 0, null)), 0);
assert.deepStrictEqual(V.best([L('d', 0, 'd'), L('c', 0, 'none'), L('d', 16, 'c')]), L('c', 0, 'none'));

// Cold: from the inventory summary; a body armour enchant is ignored.
const item = (selfId, slot, enchant = 0, rank) => ({ fetchSelfId: () => selfId, fetchAmount: () => 1, fetchEquipped: () => slot > 0,
    fetchSlot: () => slot, fetchEnchantLevel: () => enchant, fetchId: () => selfId * 10, fetchRank: () => rank, fetchName: () => `i${selfId}`,
    fetchKind: () => slot === 7 ? 'Weapon.Sword' : 'Armor', fetchStackable: () => false });
const summary = Life.inventorySummaryFromItems([item(70, 7, 5, 'c'), item(352, 10, 9, 'd'), item(1, 0, 0, 'b')]);
assert.deepStrictEqual(V.stateLook({ inventory: summary }), { weapon: 2, glow: 1, body: 1 });
assert.strictEqual(V.stateLook({ inventory: summary }), V.stateLook({ inventory: summary }), 'one look per inventory object');
assert.deepStrictEqual(V.stateLook({ inventory: Life.inventorySummaryFromItems([item(2, 15, 0, 'b')]) }), { weapon: 0, glow: 0, body: 3 },
    'full body armour counts as body armour');
assert.deepStrictEqual(V.stateLook({}), V.NOTHING);

// Hot: from the equipped items, cached until the paperdoll changes.
const backpack = new BackpackModel(Array.from({ length: 16 }, () => ({})));
backpack.items = [item(70, 7, 16, 'b'), item(352, 10, 0, 'c'), item(9, 0, 0, 's')];
const actor = { backpack };
assert.deepStrictEqual(V.actorLook(actor), { weapon: 3, glow: 3, body: 2 });
backpack.items = [item(352, 10, 0, 'c')];
assert.strictEqual(V.actorLook(actor).weapon, 3, 'no rescan without a gear change');
backpack.unequipPaperdoll(7);
assert.deepStrictEqual(V.actorLook(actor), { weapon: 0, glow: 0, body: 2 }, 'a gear change drops the cached look');

// A summon or pet is one more visible person on its owner's side.
assert.strictEqual(V.actorPeople({}), 1);
assert.strictEqual(V.actorPeople({ summon: { isDead: () => false } }), 2);
assert.strictEqual(V.actorPeople({ summon: { isDead: () => true } }), 1, 'a dead summon is not company');
assert.strictEqual(V.actorPeople({ pet: { state: { fetchDead: () => false } } }), 2);
const servitor = expiresAt => ({ stats: { coldCombat: { summon: { active: true, expiresAt } } } });
assert.strictEqual(V.statePeople(servitor(2000), 1000), 2);
assert.strictEqual(V.statePeople(servitor(500), 1000), 1, 'an expired servitor is gone');
assert.strictEqual(V.statePeople({ stats: {} }, 1000), 1);

// The other's condition: fresh unless a visible cue; then HP rounded up to quarters.
assert.deepStrictEqual([1, 0.99, 0.76, 0.75, 0.6, 0.3, 0.1, 0].map(hp => V.seen(hp, true)), [1, 1, 1, 0.75, 0.75, 0.5, 0.25, 0.25]);
assert.strictEqual(V.seen(0.1, false), 1, 'no cue: assumed fresh');
const live = (hp, state = {}, flag = 0) => ({ fetchHp: () => hp, fetchMaxHp: () => 100, fetchPvpFlag: () => flag, state });
assert.strictEqual(V.actorSeen(live(40)), 1, 'hurt but nothing shows it');
assert.strictEqual(V.actorSeen(live(40, { fetchSeated: () => true })), 0.5, 'sitting');
assert.strictEqual(V.actorSeen(live(60, { fetchCombats: () => true })), 0.75, 'in combat stance');
assert.strictEqual(V.actorSeen(live(70, {}, 1)), 0.75, 'a purple name');
assert.strictEqual(V.actorSeen(live(90, {}, 1)), 1, 'slightly hurt looks healthy');
const coldOf = (hp, extra = {}) => ({ vitals: { hp, maxHp: 100 }, activity: 'hunting', stats: {}, ...extra });
assert.strictEqual(V.stateSeen(coldOf(40), 1000), 1, 'cold hunting is no cue');
assert.strictEqual(V.stateSeen(coldOf(40, { activity: 'resting' }), 1000), 0.5, 'cold resting');
assert.strictEqual(V.stateSeen(coldOf(60, { stats: { coldPvp: { until: 2000 } } }), 1000), 0.75, 'a cold skirmish just ended');
assert.strictEqual(V.stateSeen(coldOf(60, { stats: { coldPvp: { until: 500 } } }), 1000), 1, 'long ago');
assert.deepStrictEqual(V.actorSide([live(50, { fetchSeated: () => true }), { ...live(100), summon: { isDead: () => false } }]),
    { look: V.NOTHING, people: 3, strength: 0.5 + 1 + 1 });
assert.deepStrictEqual(V.stateSide([coldOf(50, { activity: 'resting' })], 1000), { look: V.NOTHING, people: 1, strength: 0.5 });

// Own condition is exact; the other side is assumed fresh.
assert.strictEqual(V.condition(1, 1, 1, false, true), 1);
assert.strictEqual(V.condition(1, 0, 1, false, false), 1, 'no CP pool is not a weakness');
assert(Math.abs(V.condition(1, 0, 1, false, true) - 0.8) < 1e-12, 'lost CP counts');
assert(V.condition(1, 1, 0.05, true, true) < 0.25, 'a caster without MP is weak');
assert(Math.abs(V.resources(1, 1, 1, false) - 1.25) < 1e-12, 'the author\'s resource factor');

// The verdict.
const side = (look, people = 1, strength) => ({ look, people, strength });
const calm = { caution: 0.5, assertiveness: 0.5, empathy: 0.5 };
const C = L('c', 0, 'c'), D = L('d', 0, 'd');
const win = (own, other, traits = calm, fear = 0) => V.canWin({ own, other, traits, fear });
assert.deepStrictEqual([win(side(C), side(D)).verdict, win(side(C), side(D)).fight], ['stronger', true]);
assert.deepStrictEqual([win(side(D), side(C)).verdict, win(side(D), side(C)).fight], ['weaker', false]);
assert.strictEqual(win(side(D), side(C), { caution: 0, assertiveness: 1 }).fight, false, 'visibly weaker: traits do not help');
assert.strictEqual(win(side(C), side(D), { caution: 1, assertiveness: 0 }).fight, true, 'visibly stronger: even the cautious fight');
// Visibly equal: the author's threshold 0.9 + 0.55 caution - 0.35 assertiveness.
assert.strictEqual(win(side(D), side(D)).required, 1);
assert.deepStrictEqual([win(side(D), side(D)).verdict, win(side(D), side(D)).fight], ['even', true], 'calm accepts even odds');
assert.strictEqual(win(side(D), side(D), { caution: 0.8, assertiveness: 0.3 }).fight, false, 'the cautious want an advantage');
assert.strictEqual(win(side(D, 2), side(D), { caution: 0.8, assertiveness: 0.3 }).fight, true, 'two against one is an advantage');
assert.strictEqual(win(side(D, 1, 0.6), side(D), { caution: 0, assertiveness: 1 }).fight, true, 'the assertive fight hurt (0.6 >= 0.55)');
assert.strictEqual(win(side(D, 1, 0.5), side(D), { caution: 0, assertiveness: 1 }).fight, false);
// People with him.
assert.strictEqual(win(side(D), side(D, 2)).fight, false, 'one against two at equal gear');
assert.strictEqual(win(side(C), side(D, 2)).verdict, 'even', 'better gear against more people cannot be told');
assert.strictEqual(win(side(D, 2), side(C)).verdict, 'even', 'worse gear with more people cannot be told');
assert.strictEqual(win(side(D, 2), side(C)).fight, true);
assert.strictEqual(win(side(C, 1, 0.3), side(D)).verdict, 'stronger', 'own wounds do not hide a visible gap');
// A visibly worn opponent: the even case weighs his seen condition, the gear verdict does not.
const cautious = { caution: 0.8, assertiveness: 0.3 };
assert.strictEqual(win(side(D), side(D), cautious).fight, false);
assert.strictEqual(win(side(D), side(D, 1, 0.75), cautious).fight, true, 'the cautious take on a visibly worn equal');
assert.strictEqual(win(side(D), side(C, 1, 0.25)).verdict, 'weaker', 'a worn but visibly stronger one still looks stronger');
// Memory: fear asks for more.
const feared = { ready: true, personal: { fear: 6 } };
assert(Math.abs(V.fear(feared) - 0.2) < 1e-12);
assert.strictEqual(V.fear({ ready: false, personal: { fear: 30 } }), 0);
assert.strictEqual(V.fear({ ready: true, personal: { fear: 9 }, effective: { fear: 30 } }), 1, 'the effective feeling wins');
assert.strictEqual(win(side(D), side(D), calm, V.fear(feared)).fight, false, 'one remembered death turns an even fight down');
assert.strictEqual(win(side(C), side(D), calm, 1).fight, true, 'fear does not hide a visible gap');
// Aggression scales the threshold as in the author's defense.
Config.pvpAggression = 0.25;
assert.strictEqual(win(side(D), side(D)).fight, false);
Config.pvpAggression = 1;
assert.strictEqual(win(side(D), side(D), { caution: 1, assertiveness: 0 }).fight, true);
Config.pvpAggression = 0.5;
// The never-fight trio is the author's, unchanged.
assert.strictEqual(V.avoidsPvp({ caution: 0.7, assertiveness: 0.4, empathy: 0.6 }), true);
assert.strictEqual(V.avoidsPvp({ caution: 0.69, assertiveness: 0.4, empathy: 0.6 }), false);
assert.strictEqual(V.avoidsPvp({}), false);

Config.pvpAggression = saved;
console.log('visible strength checks passed');
setImmediate(() => process.exit(0));
