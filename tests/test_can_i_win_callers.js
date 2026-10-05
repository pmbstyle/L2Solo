// "Can I win?" at the four places that ask it: the spot dispute (hot and cold),
// the cold PvP start, the hot defense decision and the hot PK sighting.
// Each block pins what the caller decides for a small set of opponents.
const assert = require('assert');
require('../src/Global');
// U26 (user, 2026-10-05): can-I-win is a chance with one roll per decision. A fixed
// middle roll (0.49) makes each such decision the author's threshold (willing iff
// chance >= 0.5, i.e. ratio >= threshold); the chance itself is tested in test_visible_strength.
require('../src/GameServer/Bot/AI/TendencyRoll').roll = () => 0.49;
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
assert.strictEqual(dispute(solo(40), solo(40, { people: 2 })).reason, 'outmatched', 'a solo with a summon outmatches a solo of the same look');
assert.strictEqual(dispute(solo(40, { people: 2 }), solo(40, { people: 2 })).action, 'yield', 'summons on both sides even out');
// U26: an even look falls to the author's defense threshold by traits.
const wary = { traits: { ...calm.traits, caution: 0.8, assertiveness: 0.3 } };
assert.strictEqual(dispute(solo(40), solo(40), wary).reason, 'outmatched', 'the cautious feel outmatched by an even look');
assert.strictEqual(dispute(solo(40), solo(40), calm, { ready: true, personal: { fear: 6, affinity: 0, trust: 0, hostility: 0 } }).reason,
    'outmatched', 'fear of him: outmatched by an even look');

// The cold refresh re-asks the same question with the saved rolls and the willingness
// rolled once at the dispute (one decision per encounter, user 2026-10-05).
{
    const cold = (id, level) => ({ characterId: id, level, party: null, simulation: { revision: 1 } });
    const states = { 1: cold(1, 40), 2: cold(2, 44) };
    const ctx = { life: { cachedState: id => states[id] }, parties: { find: () => null },
        memory: { assess: () => neutral }, personaFor: () => calm };
    const event = willing => ({ contextVersion: 1, action: 'contest', pressure: 3, decisionRolls: [0.99, 0.1, 0.99, 0.99],
        actor: { id: 1 }, peer: { id: 2 }, key: 'refresh-pin', willing });
    assert.deepStrictEqual(Refresh.refresh(event([false, true]), ctx, Date.now()), { reason: 'decision_changed', decision: 'avoid' },
        'cold refresh: the carried unwillingness is outmatched');
    assert.deepStrictEqual(Refresh.refresh(event([true, true]), ctx, Date.now()), { reason: 'decision_changed', decision: 'yield' },
        'cold refresh: carried willingness, four hidden levels above do not matter');
    const Tendency = require('../src/GameServer/Bot/AI/TendencyRoll');
    let rolls = 0;
    Tendency.roll = () => { rolls++; return 0.49; };
    Refresh.refresh(event([true, true]), ctx, Date.now());
    Tendency.roll = () => 0.49;
    assert.strictEqual(rolls, 0, 'the refresh reuses the rolls, it does not roll again');
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
    // One decision per encounter: the opener's willingness is rolled at the dispute
    // (own side exact, the other side as seen) and carried to the start.
    const V = require('../src/GameServer/Social/VisibleStrength');
    const openerWilling = V.willing(V.canWin({ own: Pvp.ownSide([opener], at), other: V.stateSide([other], at), traits: persona.traits }), 'pin');
    return Pvp.resolve({ sides, roles: new Map(), timestamp: at, rng, personaFor: () => persona, openingSide: 1, openerWilling });
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
{
    const withServitor = id => { const s = coldState(id); s.stats.coldCombat.summon = { active: true, expiresAt: at + 60000 }; return s; };
    assert.strictEqual(coldStart(coldState(11), withServitor(12), bold).reason, 'pvp_outmatched', 'cold: his servitor is one more person');
    assert(coldStart(withServitor(11), coldState(12), timid).started, 'cold: my servitor is one more person');
}

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
// No never-fight trio any more (user, 2026-10-05): it follows the threshold like everyone.
assert.strictEqual(defense(fresh, {}, { caution: 0.9, assertiveness: 0.1, empathy: 0.9 }).reasons[0], 'outmatched', 'defense: the former trio, even look');
assert.strictEqual(defense({ ...fresh, ...armed('c') }, {}, { caution: 0.9, assertiveness: 0.1, empathy: 0.9 }).action, 'fight',
    'defense: the former trio fights when visibly stronger');
assert.strictEqual(defense(fresh, armed('c'), { caution: 0, assertiveness: 1, empathy: 0 }).action, 'flee', 'defense: a visibly higher grade flees');
assert.strictEqual(defense({ ...fresh, ...armed('c') }, armed('d'), { caution: 0.8, assertiveness: 0.3, empathy: 0.3 }).action, 'fight',
    'defense: a visibly lower grade is fought even by the cautious');
{
    // A visibly worn attacker (combat stance, half HP) looks weaker in an even fight.
    const own = hotSession(hotActor(fresh), { caution: 0.8, assertiveness: 0.3, empathy: 0.3 });
    const enemy = hotActor({ hp: 50 });
    hotSession(enemy);
    World.user = { sessions: [own, enemy.session] };
    invoke('GameServer/Bot/AI/BotPvpIndex').invalidate();
    assert.strictEqual(Risk.defenseDecision(own, [enemy]).action, 'flee', 'defense: his wounds do not show');
    enemy.state.fetchCombats = () => true;
    assert.strictEqual(Risk.defenseDecision(own, [enemy]).action, 'fight', 'defense: a worn attacker in combat stance');
    enemy.hp = 80;
    assert.strictEqual(Risk.defenseDecision(own, [enemy]).action, 'flee', 'defense: a slightly hurt attacker looks healthy');
}
const pet = () => ({ summon: { isDead: () => false } });
assert.strictEqual(defense(fresh, pet(), { caution: 0, assertiveness: 1, empathy: 0 }).action, 'flee', 'defense: his summon is one more person');
assert.strictEqual(defense({ ...fresh, ...pet() }, {}, { caution: 0.8, assertiveness: 0.3, empathy: 0.3 }).action, 'fight',
    'defense: my summon is one more person');
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
// U26: the PK by his look, the people with him and the bot's fear; levels are hidden.
// The bot's own HP, MP, role and allies keep the author's score terms.
const sighting = (extra = {}) => Risk.evaluate({ hpRatio: 1, mpRatio: 1, role: 'dps', ...extra });
assert.strictEqual(sighting().action, 'fight', 'sighting: an even look fights (calm)');
assert.strictEqual(sighting({ botLevel: 40, threatLevel: 41 }).action, 'fight', 'sighting: a hidden higher level is not seen');
assert.strictEqual(sighting({ threatLook: C, ownLook: D }).action, 'flee', 'sighting: a visibly higher grade flees');
assert.strictEqual(sighting({ threatLook: C, ownLook: D, allies: 3 }).action, 'fight', 'sighting: three allies beat a visible gap');
assert.strictEqual(sighting({ threatLook: D, ownLook: C, hpRatio: 0.2 }).action, 'fight', 'sighting: a visibly weaker PK is fought even at critical HP');
assert.strictEqual(sighting({ hpRatio: 0.2 }).action, 'flee', 'sighting: critical HP flees an even look');
assert.strictEqual(sighting({ threatPeople: 2 }).action, 'flee', 'sighting: a PK with a friend');
assert.strictEqual(sighting({ traits: { caution: 0.8, assertiveness: 0.3 } }).action, 'flee', 'sighting: the cautious flee an even look');
assert.strictEqual(sighting({ fear: 0.2 }).action, 'flee', 'sighting: fear of him');
assert.deepStrictEqual(sighting().reasons, ['visible:even']);
assert.strictEqual(sighting({ ownPeople: 2, threatPeople: 2 }).action, 'fight', 'sighting: summons on both sides even out');
{
    // What HuntingState passes: the hunter's look, the PK's look and people, traits, fear.
    const own = hotSession(hotActor(armed('d')), { caution: 0.8, assertiveness: 0.3 });
    const pk = hotActor(armed('c'));
    hotSession(pk);
    World.user = { sessions: [own, pk.session] };
    invoke('GameServer/Bot/AI/BotPvpIndex').invalidate();
    const seen = Risk.sighting(own, pk);
    assert.deepStrictEqual([seen.ownLook.weapon, seen.threatLook.weapon, seen.threatPeople, seen.traits.caution, seen.fear], [1, 2, 1, 0.8, 0]);
    assert.strictEqual(sighting(seen).action, 'flee');
    pk.summon = { isDead: () => false };
    own.actor.summon = { isDead: () => false };
    const both = Risk.sighting(own, pk);
    assert.deepStrictEqual([both.ownPeople, both.threatPeople], [2, 2], 'sighting: each side\'s summon is seen');
}

// One pair, one verdict: a visibly equal pair is decided by traits in all four places.
{
    const pairs = [[{ caution: 0.5, assertiveness: 0.5, empathy: 0.5 }, true], [{ caution: 0.8, assertiveness: 0.3, empathy: 0.3 }, false]];
    for (const [traits, fights] of pairs) {
        const persona = { traits: { ...calm.traits, ...traits } };
        const solo40 = solo(40, { look: D });
        assert.strictEqual(dispute(solo40, solo(40, { look: D }), persona).reason === 'outmatched', !fights, 'dispute');
        const coldA = coldState(21, { hp: 1e6 }), coldB = coldState(22);
        coldA.stats.coldCombat.cp = 1e6; coldA.vitals.mp = 1e6; // fresh: clamped to the profile maxima
        assert.strictEqual(coldStart(coldA, coldB, persona).started === true, fights, 'cold start');
        assert.strictEqual(defense(fresh, {}, traits).action === 'fight', fights, 'defense');
        assert.strictEqual(sighting({ traits }).action === 'fight', fights, 'sighting');
    }
}

// U26 (user, 2026-10-05): nothing absolute. A visibly stronger defender is willing with
// chance 0.98, so a rare roll above it flees; a visibly weaker one fights on a roll under 0.02.
{
    const Tendency = require('../src/GameServer/Bot/AI/TendencyRoll');
    const strong = defense({ ...fresh, ...armed('c') }, armed('d'));
    assert.strictEqual(strong.chance, 0.98);
    Tendency.roll = () => 0.985;
    assert.strictEqual(defense({ ...fresh, ...armed('c') }, armed('d')).action, 'flee', 'defense: even a stronger bot rarely backs off');
    Tendency.roll = () => 0.01;
    assert.strictEqual(defense({ ...fresh, ...armed('d') }, armed('c')).action, 'fight', 'defense: even a weaker bot rarely stands');
    Tendency.roll = () => 0.49;
}

Config.pvpAggression = savedAggression;
console.log('can-I-win caller checks passed');
setImmediate(() => process.exit(0));
