// Whether a cold clan hall bot needs its hall: the one rule for the main
// thread (ColdVisit) and the cold worker (the 'clan_halls' table). It reads
// only the hall row and the bot's state, never World or Runtime, so the
// worker loads it as is.
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const SkillRankIndex = require('../Skills/SkillRankIndex');
const Policy = require('./Policy');
const VisitPolicy = require('./VisitPolicy');
const support = require('../../../data/ClanHalls/support.json');
const DataCache = invoke('GameServer/DataCache');
const SkillModel = invoke('GameServer/Model/Skill');
const Effects = invoke('GameServer/Effects/EffectStore');
const Loadout = invoke('GameServer/Bot/AI/PartyBuffLoadout');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const Rebuff = invoke('GameServer/Bot/AI/Rebuff');
const LOCAL_RANGE = 7500;
const skills = new Map();

function skillFor(entry) {
    const key = `${entry.id}:${entry.level}`;
    if (skills.has(key)) return skills.get(key);
    const data = ItemTemplateIndex.findStrictRequired(DataCache.skills, entry.id);
    const level = data ? SkillRankIndex.findStrict(data.levels, entry.level) : undefined;
    if (!level) return null;
    const skill = new SkillModel({ ...utils.crushOb(data), ...level });
    skills.set(key, skill);
    return skill;
}
function available(hall, timestamp = Date.now()) {
    return hall && hall.ownerId > 0 && timestamp < hall.serviceDueAt;
}
function point(actor) {
    return { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() };
}
function effectFor(skill, timestamp = Date.now()) {
    const s = skill.fetchSemantic();
    return {
        key: s.effect,
        id: skill.fetchSelfId(),
        level: skill.fetchLevel(),
        name: skill.fetchName(),
        type: s.effectType || 'buff',
        negateType: 'BUFF',
        magicLevel: s.magicLevel,
        category: s.effectTrait || s.trait || s.effect,
        stackFamily: s.stackFamily,
        stackOrder: s.stackOrder,
        dispellable: s.dispellable,
        stats: s.stats || {},
        conditionalStats: s.conditionalStats || [],
        situationalStats: s.situationalStats || [],
        expiresAt: timestamp + Number(s.durationMs ?? skill.fetchBuffTime())
    };
}
// The hall support the actor lacks (none in force). `effects` = the actor's effects;
// the default reads the live store, a cold caller passes the state's own list.
function missing(actor, hall, timestamp = Date.now(), effects = Effects.list(actor)) {
    if (!available(hall, timestamp)) return [];
    const active = effects.filter((e) => !e.expiresAt || e.expiresAt > timestamp);
    const count = active.filter(Effects.includedInBuffCount).length;
    let slots = Math.max(
        0,
        Effects.BUFF_LIMIT -
            Math.max(0, active.filter((e) => e.type === 'debuff').length - Effects.DEBUFF_RESERVED_SLOTS) -
            count
    );
    return (support[hall.functions.support] || [])
        .map(skillFor)
        .filter(Boolean)
        .filter((skill) => {
            if (!Loadout.useful(actor, skill)) return false;
            const desired = effectFor(skill, timestamp);
            const matching = active.filter(
                (e) => e.key === desired.key || (desired.stackFamily && e.stackFamily === desired.stackFamily)
            );
            const strength = (e) => Number(e.stackFamily ? e.stackOrder || 0 : e.level || 0);
            if (
                matching.some(
                    (e) =>
                        strength(e) > strength(desired) ||
                        (strength(e) === strength(desired) && (!e.expiresAt || e.expiresAt > timestamp))
                )
            )
                return false;
            if (!matching.length && slots-- <= 0) return false;
            return true;
        });
}
function recovery(actor, hall, timestamp = Date.now()) {
    if (!available(hall, timestamp)) return false;
    return (
        (hall.functions.hp > 0 && actor.fetchHp() < actor.fetchMaxHp() * 0.95) ||
        (hall.functions.mp > 0 &&
            BotRoles.shouldRestForMana(actor) &&
            actor.fetchMp() < actor.fetchMaxMp() * 0.95)
    );
}
// Inside the hall, or in the hall's town near its spawn.
function local(actor, hall) {
    const p = point(actor);
    const town = TownRespawn.getClosestTown(p.locX, p.locY, p.locZ);
    return (
        Policy.inside(hall, actor) ||
        (town?.name === hall.town && Math.hypot(p.locX - hall.spawn.locX, p.locY - hall.spawn.locY) <= LOCAL_RANGE)
    );
}
function actorFor(state, hall) {
    const loc = state.loc || {};
    const items = Object.values(state.inventory || {})
        .filter((item) => item.equipped && Number(item.amount) > 0)
        .flatMap((item) => {
            const template = ItemTemplateIndex.find(DataCache.items, item.selfId);
            const slots = item.equippedSlots?.length ? item.equippedSlots : [item.slot || template?.etc?.slot];
            return slots.map((slot) => ({
                fetchEquipped: () => true,
                fetchSlot: () => Number(slot),
                fetchKind: () => template?.template?.kind || '',
                fetchName: () => template?.template?.name || '',
                fetchPAtk: () => template?.stats?.pAtk || 0,
                fetchMAtk: () => template?.stats?.mAtk || 0
            }));
        });
    const weapon = items.find((item) => item.fetchKind().startsWith('Weapon.')) || null;
    const actor = {
        classId: state.stats?.classId ?? state.classId,
        backpack: {
            fetchItems: () => items,
            fetchEquippedWeapon: () => weapon,
            fetchTotalWeaponKind: () => weapon?.fetchKind() || ''
        },
        stats: state.stats,
        fetchId: () => state.characterId,
        fetchClanId: () => hall?.ownerId || 0,
        fetchClassId: () => state.stats?.classId ?? state.classId,
        fetchLevel: () => state.level,
        fetchLocX: () => loc.locX,
        fetchLocY: () => loc.locY,
        fetchLocZ: () => loc.locZ,
        fetchHp: () => state.vitals?.hp || 0,
        fetchMaxHp: () => state.vitals?.maxHp || 1,
        fetchMp: () => state.vitals?.mp || 0,
        fetchMaxMp: () => state.vitals?.maxMp || 1,
        isDead: () => state.activity === 'dead' || Number(state.vitals?.hp) <= 0,
        effects: Object.fromEntries((state.stats?.coldCombat?.effects || []).map((e) => [e.key, { ...e }]))
    };
    return actor;
}
// The same rule as the hot visit and the hot restart (VisitPolicy): a cold
// bot is never at the manager, so a party member restarts in town.
function eligible(state) {
    return state?.phase === 'cold' && VisitPolicy.mayUse(VisitPolicy.fromState(state));
}
// Whether a far bot's step is its hall's (main's command, ColdVisit; the worker's
// kernel reads the same): a visit under way, its rebuff answered the hall at a free
// moment of its hunt or rest (Bot/AI/Rebuff; a town visit ends first, as a body's
// BotVisit waits; ColdVisit carries it out or drops it, and marks it done), or a
// restart there after death. hall = the bot's owned hall row (null = none). A
// hall-clan bot's rest is no visit: it rests where it stands, as any bot.
function needed(state, hall) {
    if (state?.stats?.clanHallVisit) return true;
    if (Rebuff.pending(state?.stats, 'hall') && (state.activity === 'hunting' || state.activity === 'resting')) return true;
    if (!hall || !eligible(state)) return false;
    return state.activity === 'dead' || Number(state.vitals?.hp) <= 0;
}
// Whether the hall serves a bot now (its rebuff's read): open, its manager present,
// the bot may use it (VisitPolicy), is in no fight's encounter and lacks support it
// gives. From anywhere: a C4 clan member with no buffs goes to his hall (the visit
// teleports there and back, ColdVisit / BotVisit). managerPresent: a boolean (the
// worker's hall row) or a function (main asks World past the cheap gates).
function serves(state, hall, managerPresent, timestamp = Date.now()) {
    if (!hall || state?.stats?.pveEncounter || !available(hall, timestamp) || !VisitPolicy.mayUse(VisitPolicy.fromState(state))) return false;
    const actor = actorFor(state, hall);
    if (!missing(actor, hall, timestamp, Object.values(actor.effects)).length) return false;
    return typeof managerPresent === 'function' ? managerPresent() : managerPresent === true;
}
module.exports = { skillFor, available, point, effectFor, missing, recovery, local, actorFor, eligible, needed, serves };
