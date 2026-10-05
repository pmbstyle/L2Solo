// "Can I win?" at the four places that ask it: the spot dispute (hot and cold),
// the cold PvP start, the hot defense decision and the hot PK sighting.
// Each block pins what the caller decides for a small set of opponents.
const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const World = invoke('GameServer/World/World');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Policy = require('../src/GameServer/Social/ResourceCompetitionPolicy');
const ColdPolicy = require('../src/GameServer/Bot/Population/ColdCompetitionPolicy');
const Refresh = require('../src/GameServer/Bot/Population/ColdConflictDecision');
const Pvp = require('../src/GameServer/Bot/Population/ColdPvpResolver');
const Risk = invoke('GameServer/Bot/AI/BotPvpRisk');
const savedAggression = Config.pvpAggression;
Config.pvpAggression = 0.5;
const neutral = { ready: true, revision: 0, personal: null };
const calm = { traits: { caution: 0.5, assertiveness: 0.5, empathy: 0.5, ambition: 0.5, sociability: 0.5, commitment: 0.5, resilience: 0.5 } };

// ---- 1. Spot dispute: one function for hot and cold (cold re-exports it).
assert.strictEqual(ColdPolicy.decide, Policy.decide, 'cold dispute is the same function as hot');
// Rolls: 0.99 refuses the party offer, 0.1 is the retreat roll. Caution 0.5 retreats
// with 0.075 when not outmatched and 0.325 when outmatched.
function dispute(actor, peer, persona = calm, toward = neutral) {
    const rolls = [0.99, 0.1, 0.99, 0.99];
    return Policy.decide({ pressure: 3, actor, peer, actorPersona: persona, peerPersona: calm,
        towardPeer: toward, towardActor: neutral, rng: () => rolls.shift() });
}
const solo = (level, extra = {}) => ({ level, size: 1, partyId: null, ...extra });
const V = require('../src/GameServer/Social/VisibleStrength');
const C = V.look('c', 0, 'c'), D = V.look('d', 0, 'd');
assert.strictEqual(dispute(solo(40), solo(40)).action, 'yield', 'equal: no retreat on a 0.1 roll');
// U26: a level is not visible; a higher grade is.
assert.strictEqual(dispute(solo(40, { look: D }), solo(44, { look: D })).action, 'yield', 'four hidden levels above look even');
assert.deepStrictEqual([dispute(solo(40, { look: D }), solo(40, { look: C })).action, dispute(solo(40, { look: D }), solo(40, { look: C })).reason],
    ['avoid', 'outmatched'], 'a visibly higher grade outmatches');
assert.strictEqual(dispute(solo(40, { look: C }), solo(44, { look: D })).action, 'yield', 'a visibly lower grade does not');
assert.strictEqual(dispute(solo(40), { level: 40, size: 2, partyId: 'p' }).reason, 'outmatched', 'a pair outmatches a solo of the same look');
// U26: an even look falls to the author's defense threshold by traits.
const wary = { traits: { ...calm.traits, caution: 0.8, assertiveness: 0.3 } };
assert.strictEqual(dispute(solo(40), solo(40), wary).reason, 'outmatched', 'the cautious feel outmatched by an even look');
assert.strictEqual(dispute(solo(40), solo(40), calm, { ready: true, personal: { fear: 6, affinity: 0, trust: 0, hostility: 0 } }).reason,
    'outmatched', 'fear of him: outmatched by an even look');

// The cold refresh re-asks the same question with the saved rolls.
{
    const gear = rank => ({ 1: { selfId: 1, amount: 1, rank, equipped: true, equippedSlots: [7], instances: [{ enchant: 0, equipped: true, slot: 7 }] } });
    const cold = (id, level, rank = 'd') => ({ characterId: id, level, party: null, simulation: { revision: 1 }, inventory: gear(rank) });
    const states = { 1: cold(1, 40), 2: cold(2, 40, 'c') };
    const ctx = { life: { cachedState: id => states[id] }, parties: { find: () => null },
        memory: { assess: () => neutral }, personaFor: () => calm };
    const event = { contextVersion: 1, action: 'contest', pressure: 3, decisionRolls: [0.99, 0.1, 0.99, 0.99],
        actor: { id: 1 }, peer: { id: 2 } };
    assert.deepStrictEqual(Refresh.refresh(event, ctx, Date.now()), { reason: 'decision_changed', decision: 'avoid' },
        'cold refresh: a visibly higher weapon grade outmatches');
    states[2] = cold(2, 44);
    assert.deepStrictEqual(Refresh.refresh(event, ctx, Date.now()), { reason: 'decision_changed', decision: 'yield' },
        'cold refresh: four hidden levels above look even');
}

// ---- 2. Cold PvP start (the opening side may refuse).
const at = Date.now();
function coldState(id, { pAtk = 300, hp = 1000, inventory = {} } = {}) {
    return { characterId: id, name: `Cold${id}`, phase: 'cold', level: 40, activity: 'hunting',
        loc: { locX: 50000, locY: 15000, locZ: -5000 }, vitals: { hp, maxHp: 1000, mp: 500, maxMp: 500 }, inventory,
        stats: { classId: 0, coldCombat: { version: 1, classId: 0, cp: 500, cpAt: at,
            base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
            equipment: { weaponKind: 'Weapon.Sword', pAtk, pAtkRnd: 0, mAtk: 100, atkSpd: 379, critical: 0, accur: 0, pDef: 200, mDef: 100, evasion: 0 },
            effects: [], skills: [{ selfId: 1, level: 1, passive: true }] } } };
}
function coldStart(opener, other, persona = calm) {
    const sides = [{ principal: other, members: [other] }, { principal: opener, members: [opener] }];
    let seed = 7;
    const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    return Pvp.resolve({ sides, roles: new Map(), timestamp: at, rng, personaFor: () => persona, openingSide: 1 });
}
// U26: the opener sees its own side exactly and the other side by its look.
const bold = { traits: { ...calm.traits, caution: 0, assertiveness: 1 } };
const timid = { traits: { ...calm.traits, caution: 1, assertiveness: 0 } };
const weapon = rank => ({ 1: { selfId: 1, amount: 1, rank, equipped: true, equippedSlots: [7], instances: [{ enchant: 0, equipped: true, slot: 7 }] } });
assert(coldStart(coldState(11), coldState(12), bold).started, 'cold: an even look starts for the assertive');
assert.strictEqual(coldStart(coldState(11), coldState(12)).reason, 'pvp_outmatched',
    'cold: a calm opener short of full CP refuses an even look (the other is assumed fresh)');
assert(coldStart(coldState(11), coldState(12, { pAtk: 5000 }), bold).started, 'cold: hidden attack power is not seen');
assert(coldStart(coldState(11, { pAtk: 5000 }), coldState(12), bold).started, 'cold: the stronger opener starts');
assert.strictEqual(coldStart(coldState(11, { hp: 100 }), coldState(12), bold).reason, 'pvp_outmatched', 'cold: an injured opener refuses');
assert.strictEqual(coldStart(coldState(11, { inventory: weapon('d') }), coldState(12, { inventory: weapon('c') }), bold).reason,
    'pvp_outmatched', 'cold: a visibly higher grade refuses even the assertive');
assert(coldStart(coldState(11, { inventory: weapon('c') }), coldState(12, { inventory: weapon('d') }), timid).started,
    'cold: a visibly lower grade is attacked even by the cautious');

// ---- 3. Hot defense decision.
let nextId = 3100000;
function hotActor(options = {}) {
    const value = { id: nextId++, hp: 100, mp: 100, cp: 0, level: 40, gear: 100000, items: null, classId: 0, ...options };
    return Object.assign(value, {
        fetchId() { return this.id; }, fetchName() { return `hot_${this.id}`; },
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchHp() { return this.hp; }, fetchMaxHp: () => 100, fetchMp() { return this.mp; }, fetchMaxMp: () => 100,
        fetchCp() { return this.cp; }, fetchMaxCp: () => 100, fetchLevel() { return this.level; },
        fetchClassId() { return this.classId; }, fetchClanId: () => 0, fetchKarma: () => 0, fetchDestId: () => 0,
        fetchIsOnline: () => true, isDead: () => false, state: { fetchDead: () => false },
        backpack: { fetchItems: () => value.items || [{ fetchSelfId: () => 999999, fetchPrice: () => value.gear, fetchEquipped: () => true }] }
    });
}
function hotSession(actor, traits = calm.traits) {
    const session = { actor, accountId: `bot_${actor.id}`, persona: { traits: { ...traits } } };
    actor.session = session;
    return session;
}
function defense(ownOptions, enemyOptions, traits) {
    const own = hotSession(hotActor(ownOptions), traits);
    const enemy = hotActor(enemyOptions);
    hotSession(enemy);
    World.user = { sessions: [own, enemy.session] };
    invoke('GameServer/Bot/AI/BotPvpIndex').invalidate();
    return Risk.defenseDecision(own, [enemy]);
}
// U26: own side exact, the other side by its look; levels and prices are hidden.
const fresh = { cp: 100 };
const armed = rank => ({ items: [{ fetchSelfId: () => 1, fetchPrice: () => 0, fetchEquipped: () => true, fetchSlot: () => 7,
    fetchRank: () => rank, fetchEnchantLevel: () => 0 }] });
assert.strictEqual(defense(fresh, {}).action, 'fight', 'defense: an even look fights (calm)');
assert.strictEqual(defense({}, {}).action, 'flee', 'defense: own CP gone, the attacker assumed fresh: calm flees');
assert.strictEqual(defense(fresh, { level: 60 }).action, 'fight', 'defense: a hidden higher level is not seen');
assert.strictEqual(defense(fresh, { gear: 100000000 }).action, 'fight', 'defense: a hidden expensive kit is not seen');
assert.strictEqual(defense({ ...fresh, hp: 20 }, {}).action, 'flee', 'defense: own low HP flees');
assert.strictEqual(defense(fresh, {}, { caution: 0.8, assertiveness: 0.3, empathy: 0.3 }).action, 'flee', 'defense: cautious flees from an even look');
assert.strictEqual(defense(fresh, {}, { caution: 0.9, assertiveness: 0.1, empathy: 0.9 }).reasons[0], 'avoids_pvp', 'defense: the never-fight trio');
assert.strictEqual(defense({ ...fresh, ...armed('c') }, {}, { caution: 0.9, assertiveness: 0.1, empathy: 0.9 }).action, 'flee',
    'defense: the trio never fights, even visibly stronger');
assert.strictEqual(defense(fresh, armed('c'), { caution: 0, assertiveness: 1, empathy: 0 }).action, 'flee', 'defense: a visibly higher grade flees');
assert.strictEqual(defense({ ...fresh, ...armed('c') }, armed('d'), { caution: 0.8, assertiveness: 0.3, empathy: 0.3 }).action, 'fight',
    'defense: a visibly lower grade is fought even by the cautious');
{
    const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    const MemoryPolicy = require('../src/GameServer/Social/InteractionMemoryPolicy');
    const own = hotSession(hotActor(fresh)), enemy = hotActor();
    hotSession(enemy);
    World.user = { sessions: [own, enemy.session] };
    invoke('GameServer/Bot/AI/BotPvpIndex').invalidate();
    assert.strictEqual(Risk.defenseDecision(own, [enemy]).action, 'fight');
    const now = Date.now();
    const memory = MemoryPolicy.apply(MemoryPolicy.empty(own.actor.id), { key: 'u26-killed', at: now, type: 'killed',
        sourceId: own.actor.id, targetId: enemy.id }, now).snapshot;
    Memory.accept(memory);
    assert.strictEqual(Risk.defenseDecision(own, [enemy]).action, 'flee', 'defense: fear of the one who killed me');
}

// ---- 4. Hot PK sighting.
const sighting = (botLevel, threatLevel, extra = {}) => Risk.evaluate({ botLevel, threatLevel, hpRatio: 1, mpRatio: 1, role: 'dps', ...extra });
assert.strictEqual(sighting(40, 40).action, 'fight', 'sighting: equal level fights');
assert.strictEqual(sighting(40, 41).action, 'flee', 'sighting: one level above flees');
assert.strictEqual(sighting(40, 43, { allies: 3 }).action, 'fight', 'sighting: three allies beat three levels');
assert.strictEqual(sighting(40, 30, { hpRatio: 0.2 }).action, 'fight', 'sighting: much lower PK is fought even at critical HP');

Config.pvpAggression = savedAggression;
console.log('can-I-win caller checks passed');
setImmediate(() => process.exit(0));
