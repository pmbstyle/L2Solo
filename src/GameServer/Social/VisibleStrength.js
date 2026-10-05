// "Can I win?" for every PvP decision, hot and cold (U26). A bot knows its own
// side exactly. Of the other side it knows only what a player sees: the grade
// of the weapon and its enchant glow, the grade of the body armour and how many
// people stand with him; plus its own memory of him (fear). Levels, stats,
// prices and bags of other characters are never read here.
const Config = require('../Bot/Population/PopulationConfig');
const { retreatMultiplier } = require('./PvpAggression');

const GRADE = Object.freeze({ none: 0, d: 1, c: 2, b: 3, a: 4, s: 5 });
const WEAPON_SLOTS = Object.freeze([7, 14]); // one-handed, two-handed
const BODY_SLOTS = Object.freeze([10, 15]); // chest, full body armour
const NOTHING = Object.freeze({ weapon: 0, glow: 0, body: 0 });
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, Number(value) || 0));
const grade = rank => GRADE[String(rank || 'none').toLowerCase()] || 0;

// The C4 client's weapon glow (env.int [EnchantEffect]): faint from +4, the
// particle effect from +7 (brighter up to +15), red from +16. Armour enchant
// does not show.
function glow(enchant) {
    const level = Number(enchant) || 0;
    return level >= 16 ? 3 : level >= 7 ? 2 : level >= 4 ? 1 : 0;
}

function look(weaponRank, weaponEnchant, bodyRank) {
    return Object.freeze({ weapon: grade(weaponRank), glow: weaponRank ? glow(weaponEnchant) : 0, body: grade(bodyRank) });
}

// +1: a looks stronger than b, -1: weaker, 0: the same, or better in one
// piece and worse in the other. A glow counts only between equal weapon grades.
function compare(a = NOTHING, b = NOTHING) {
    const weapon = Math.sign(a.weapon - b.weapon) || Math.sign(a.glow - b.glow);
    const body = Math.sign(a.body - b.body);
    return weapon * body < 0 ? 0 : Math.sign(weapon + body);
}

// The best-looking member stands for his side.
function best(looks) {
    const rank = x => (x.weapon * 4 + x.glow) * 6 + x.body;
    let top = NOTHING;
    for (const x of looks) if (rank(x) > rank(top)) top = x;
    return top;
}

// A live character. Cached on the backpack; the backpack drops it when the
// paperdoll changes (Model/Backpack) and when an item is enchanted (Enchant).
function actorLook(actor) {
    const backpack = actor?.backpack;
    if (!backpack) return NOTHING;
    if (backpack.visibleLook) return backpack.visibleLook;
    let weapon = null, body = null;
    for (const item of backpack.fetchItems?.() || []) {
        if (!item?.fetchEquipped?.()) continue;
        const slot = Number(item.fetchSlot?.());
        if (WEAPON_SLOTS.includes(slot)) weapon = item;
        else if (BODY_SLOTS.includes(slot) && (!body || grade(item.fetchRank?.()) > grade(body.fetchRank?.()))) body = item;
    }
    backpack.visibleLook = look(weapon?.fetchRank?.() || (weapon ? 'none' : null), weapon?.fetchEnchantLevel?.(), body?.fetchRank?.());
    return backpack.visibleLook;
}

// A cold state, from its inventory summary. Cold updates replace the inventory
// object, so one look per inventory object is one look per gear change.
const stateLooks = new WeakMap();
function stateLook(state) {
    const inventory = state?.inventory;
    if (!inventory || typeof inventory !== 'object') return NOTHING;
    const cached = stateLooks.get(inventory);
    if (cached) return cached;
    let weapon = null, enchant = 0, body = null;
    for (const item of Object.values(inventory)) {
        const slots = (Array.isArray(item?.equippedSlots) ? item.equippedSlots : item?.equipped ? [item.slot] : []).map(Number);
        if (slots.some(slot => WEAPON_SLOTS.includes(slot))) {
            weapon = item.rank || 'none';
            const worn = (item.instances || []).find(i => i.equipped && WEAPON_SLOTS.includes(Number(i.slot)));
            enchant = worn ? worn.enchant : item.enchant;
        }
        if (slots.some(slot => BODY_SLOTS.includes(slot)) && grade(item.rank) > grade(body)) body = item.rank;
    }
    const result = look(weapon, enchant, body);
    stateLooks.set(inventory, result);
    return result;
}

// A summon or pet is seen next to its owner: one more person on that side.
function actorPeople(actor) {
    const pets = new Set([actor?.summon, actor?.pet].filter(pet => pet && !pet.isDead?.() && !pet.state?.fetchDead?.()));
    return 1 + pets.size;
}

// A cold state: its servitor while the summon lasts (BackgroundResolver.persistedSummon).
function statePeople(state, timestamp) {
    const summon = state?.stats?.coldCombat?.summon;
    return 1 + (summon?.active && Number(summon.expiresAt || 0) > timestamp ? 1 : 0);
}

// What a player sees of another's condition: nothing (fresh, 1) unless a cue
// shows he has been fighting or is recovering; then his HP rounded up to
// quarters (76-100% = 1, 51-75% = 0.75, 26-50% = 0.5, else 0.25): a slightly
// hurt fighter looks healthy, only clear damage shows.
function seen(hpRatio, cue) {
    return cue ? Math.max(0.25, Math.ceil(clamp(hpRatio) * 4) / 4) : 1;
}

// Live cues: sitting, the combat stance (autoAttackStart is broadcast) or a
// purple name (a fight with a player just now).
function actorSeen(actor) {
    const cue = actor?.state?.fetchSeated?.() === true || actor?.state?.fetchCombats?.() === true
        || Number(actor?.fetchPvpFlag?.() || 0) > 0;
    return seen(Number(actor?.fetchHp?.()) / Math.max(1, Number(actor?.fetchMaxHp?.()) || 1), cue);
}

// Cold cues: resting, or a skirmish that ended within its flag time
// (ColdPvpResolver writes coldPvp.until = end + 15 s). Hunting is abstract in
// cold: no momentary mob-fight cue.
function stateCue(state, timestamp) {
    return state?.activity === 'resting' || Number(state?.stats?.coldPvp?.until || 0) > timestamp;
}

function stateSeen(state, timestamp, vitals = state?.vitals) {
    return seen(Number(vitals?.hp) / Math.max(1, Number(vitals?.maxHp) || 1), stateCue(state, timestamp));
}

// A side as another bot sees it: best look, people (summons included) and the
// seen strength (people weighted by their seen condition; a summon counts 1).
function actorSide(actors) {
    return { look: best(actors.map(actorLook)), people: actors.reduce((sum, a) => sum + actorPeople(a), 0),
        strength: actors.reduce((sum, a) => sum + actorSeen(a) + actorPeople(a) - 1, 0) };
}

function stateSide(states, timestamp) {
    return { look: best(states.map(stateLook)), people: states.reduce((sum, s) => sum + statePeople(s, timestamp), 0),
        strength: states.reduce((sum, s) => sum + stateSeen(s, timestamp) + statePeople(s, timestamp) - 1, 0) };
}

// The author's resource factor (BotPvpRisk.combatStrength): HP with a quarter
// of CP, and MP for casters.
function resources(hpRatio, cpRatio, mpRatio, manaDependent) {
    return Math.max(0.03, hpRatio + 0.25 * cpRatio) * (manaDependent ? 0.2 + 0.8 * mpRatio : 0.9 + 0.1 * mpRatio);
}

// One's own condition, exact: own resources against the same bot at full HP,
// CP and MP. 1 = fresh. The other side is always assumed fresh (unseen).
function condition(hpRatio, cpRatio, mpRatio, manaDependent, hasCp) {
    return resources(hpRatio, cpRatio, mpRatio, manaDependent) / resources(1, hasCp ? 1 : 0, 1, manaDependent);
}

// Interaction memory: how much the bot fears him (0..1).
function fear(relation) {
    const feeling = relation?.ready ? (relation.effective || relation.personal) : null;
    return feeling ? clamp(feeling.fear / 30) : 0;
}

function trait(traits, key) {
    return clamp(traits?.[key] ?? 0.5);
}

// The author's never-fight trio: cautious, meek and empathic.
function avoidsPvp(traits) {
    return trait(traits, 'caution') >= 0.7 && trait(traits, 'assertiveness') <= 0.4 && trait(traits, 'empathy') >= 0.6;
}

// The author's hot-defense threshold: a cautious bot wants an advantage, an
// assertive one accepts even odds. Fear asks for more; aggression scales it.
function required(traits, fearOf = 0) {
    return (0.9 + 0.55 * trait(traits, 'caution') - 0.35 * trait(traits, 'assertiveness'))
        * (1 + clamp(fearOf)) * retreatMultiplier(Config.pvpAggression);
}

// own: { look, people, strength } where strength is own people weighted by
// their exact condition; other: { look, people, strength } where strength is
// what is seen of them (both default to people).
// Visibly better gear and at least as many people = stronger; visibly worse
// and no more people = weaker; anything else looks even and the bot's
// character and memory decide by the head count.
function canWin({ own, other, traits, fear: fearOf = 0 }) {
    const people = own.people / Math.max(1, other.people);
    const gear = compare(own.look, other.look);
    const verdict = gear > 0 && people >= 1 ? 'stronger' : gear < 0 && people <= 1 ? 'weaker' : 'even';
    const ratio = (own.strength ?? own.people) / Math.max(0.25, other.strength ?? other.people);
    const need = required(traits, fearOf);
    return { verdict, fight: verdict === 'stronger' || verdict === 'even' && ratio >= need,
        ratio: Math.round(ratio * 100) / 100, required: need };
}

module.exports = { GRADE, NOTHING, glow, look, compare, best, actorLook, stateLook, actorPeople, statePeople, seen, actorSeen, stateCue, stateSeen, actorSide, stateSide,
    resources, condition,
    fear, avoidsPvp, required, canWin };
