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
assert.strictEqual(V.stateSeen(coldOf(40), 1000), 1, 'cold hunting off a spot is no cue');
assert.strictEqual(V.stateSeen(coldOf(40, { spotId: 's' }), 1000), 0.5, 'cold hunting on a spot: fighting mobs there, seen');
assert.strictEqual(V.stateSeen(coldOf(60, { activity: 'grouped', spotId: 's' }), 1000), 0.75, 'party hunting on a spot, seen');
assert.strictEqual(V.stateSeen(coldOf(90, { spotId: 's' }), 1000), 1, 'slightly hurt hunter looks healthy');
assert.strictEqual(V.stateSeen(coldOf(40, { activity: 'traveling', spotId: 's' }), 1000), 1, 'travelling is no cue');
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

// The verdict: a chance of being willing, never 0 or 1 (user, 2026-10-05).
// Stronger 0.98, weaker 0.02, even 0.5 + SLOPE x (ratio - threshold), SLOPE = 2.
const side = (look, people = 1, strength) => ({ look, people, strength });
const calm = { caution: 0.5, assertiveness: 0.5, empathy: 0.5 };
const C = L('c', 0, 'c'), D = L('d', 0, 'd');
const win = (own, other, traits = calm, fear = 0) => V.canWin({ own, other, traits, fear });
const near = (a, b) => Math.abs(a - b) < 1e-9;
assert.strictEqual(V.SLOPE, 2);
assert.deepStrictEqual([win(side(C), side(D)).verdict, win(side(C), side(D)).chance], ['stronger', 0.98]);
assert.deepStrictEqual([win(side(D), side(C)).verdict, win(side(D), side(C)).chance], ['weaker', 0.02]);
assert.strictEqual(win(side(D), side(C), { caution: 0, assertiveness: 1 }).chance, 0.02, 'visibly weaker: traits do not help, but it is never 0');
assert.strictEqual(win(side(C), side(D), { caution: 1, assertiveness: 0 }).chance, 0.98, 'visibly stronger: even the cautious, but never 1');
// Visibly equal: around the author's threshold 0.9 + 0.55 caution - 0.35 assertiveness.
assert.strictEqual(win(side(D), side(D)).required, 1);
assert.deepStrictEqual([win(side(D), side(D)).verdict, win(side(D), side(D)).chance], ['even', 0.5], 'calm at even odds: a coin');
assert(near(win(side(D), side(D), { caution: 0.8, assertiveness: 0.3 }).chance, 0.5 + 2 * (1 - 1.235)), 'the cautious want an advantage');
assert.strictEqual(win(side(D, 2), side(D), { caution: 0.8, assertiveness: 0.3 }).chance, 0.98, 'two against one: capped');
assert(near(win(side(D, 1, 0.6), side(D), { caution: 0, assertiveness: 1 }).chance, 0.6), 'the assertive hurt: 0.5 + 2 x (0.6 - 0.55)');
assert(near(win(side(D, 1, 0.5), side(D), { caution: 0, assertiveness: 1 }).chance, 0.4));
assert.strictEqual(win(side(D, 1, 0.1), side(D, 3)).chance, 0.02, 'hopeless odds: the floor, not zero');
// People with him.
assert.strictEqual(win(side(D), side(D, 2)).chance, 0.02, 'one against two at equal gear: 0.5 + 2 x (0.5 - 1), floored');
assert.strictEqual(win(side(C), side(D, 2)).verdict, 'even', 'better gear against more people cannot be told');
assert.strictEqual(win(side(D, 2), side(C)).verdict, 'even', 'worse gear with more people cannot be told');
assert.strictEqual(win(side(D, 2), side(C)).chance, 0.98);
assert.strictEqual(win(side(C, 1, 0.3), side(D)).verdict, 'stronger', 'own wounds do not hide a visible gap');
// A visibly worn opponent: the even case weighs his seen condition, the gear verdict does not.
const cautious = { caution: 0.8, assertiveness: 0.3 };
assert(win(side(D), side(D, 1, 0.75), cautious).chance > win(side(D), side(D), cautious).chance + 0.5, 'the cautious take on a visibly worn equal');
assert.strictEqual(win(side(D), side(C, 1, 0.25)).verdict, 'weaker', 'a worn but visibly stronger one still looks stronger');
// Memory: fear asks for more.
const feared = { ready: true, personal: { fear: 6 } };
assert(Math.abs(V.fear(feared) - 0.2) < 1e-12);
assert.strictEqual(V.fear({ ready: false, personal: { fear: 30 } }), 0);
assert.strictEqual(V.fear({ ready: true, personal: { fear: 9 }, effective: { fear: 30 } }), 1, 'the effective feeling wins');
assert(near(win(side(D), side(D), calm, V.fear(feared)).chance, 0.1), 'one remembered death: 0.5 + 2 x (1 - 1.2)');
assert.strictEqual(win(side(C), side(D), calm, 1).chance, 0.98, 'fear does not hide a visible gap');
// Aggression scales the threshold as in the author's defense.
Config.pvpAggression = 0.25;
assert(win(side(D), side(D)).chance < 0.5);
Config.pvpAggression = 1;
assert(win(side(D), side(D), { caution: 1, assertiveness: 0 }).chance > 0.5);
Config.pvpAggression = 0.5;
// No never-fight trio (user, 2026-10-05): a cautious, meek, empathic bot follows the threshold.
assert.strictEqual(V.avoidsPvp, undefined);
assert.strictEqual(win(side(C), side(D), { caution: 0.9, assertiveness: 0.1, empathy: 0.9 }).chance, 0.98);
// One roll per decision.
const coin = win(side(D), side(D));
assert.strictEqual(V.willing(coin, 'k', 1), V.willing(coin, 'k', 1), 'the same decision, the same answer');
let yes = 0;
for (let i = 0; i < 4000; i++) yes += V.willing(coin, 'coin', i);
assert(yes > 1800 && yes < 2200, 'an even chance is a coin');
let rare = 0;
for (let i = 0; i < 20000; i++) rare += V.willing(win(side(D), side(C)), 'weaker', i);
assert(rare > 200 && rare < 600, 'a visibly weaker bot still steps in, about 2% of the time');

Config.pvpAggression = saved;
console.log('visible strength checks passed');
setImmediate(() => process.exit(0));
