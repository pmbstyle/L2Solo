// The buffs a bot is given or buys for its hunt, and the Newbie Guide's: one owner
// for main (the casts, the hot rebuff) and the cold worker (the rebuff decision, a
// far bot's guide visit), which loads it without the packet modules (lazy below).
const EffectStore = invoke('GameServer/Effects/EffectStore');
const BuffCatalog = invoke('GameServer/Effects/BuffCatalog');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const Loadout = invoke('GameServer/Bot/AI/PartyBuffLoadout');

const BUFF_DURATION_MS = 20 * 60 * 1000;
const REFRESH_THRESHOLD_MS = 2 * 60 * 1000;
// The Newbie Guide serves characters up to this level: the NPC's own cap, what a player
// sees (NewbieBuff), the one number for players and bots (ours until a C4 source, L2J
// Lisvus's newbie guide script, names it).
const NEWBIE_GUIDE_MAX_LEVEL = 25;
const ALL_BUFFS = BuffCatalog.ALL_BUFFS;

const NEWBIE_BUFF_TYPES = ['windwalk', 'shield', 'haste'];
const SUPPORT_BUFF_TYPES = ['might', 'shield', 'haste', 'windwalk'];
const NEWBIE_BUFFS = Object.fromEntries(NEWBIE_BUFF_TYPES.map((type) => [type, ALL_BUFFS[type]]));
const SUPPORT_BUFFS = Object.fromEntries(SUPPORT_BUFF_TYPES.map((type) => [type, ALL_BUFFS[type]]));

function ensureStore(actor) {
    if (!actor.activeBuffs) {
        actor.activeBuffs = {};
    }
    return actor.activeBuffs;
}

function now() {
    return Date.now();
}

function effectData(buff) {
    const semantic = C4SkillRules.resolve({
        selfId: buff.id,
        level: buff.level
    });
    return {
        key: semantic.effect || buff.key,
        id: buff.id,
        level: buff.level,
        name: buff.name,
        type: semantic.effectType || 'buff',
        category: semantic.effectTrait || semantic.trait || semantic.effect || buff.key,
        stackFamily: semantic.stackFamily,
        stackOrder: semantic.stackOrder,
        stats: semantic.stats || {}
    };
}

function isNewbieEligible(actor) {
    return actor && actor.fetchLevel() <= NEWBIE_GUIDE_MAX_LEVEL && actor.fetchKarma() === 0;
}

// The starter towns' Newbie Guides (C4 spawns), and the reach a newbie walks back to
// one: the guide's town radius.
const GUIDES = Object.freeze([
    { name: 'Talking Island', npcSelfId: 7598, locX: -84081, locY: 243227, locZ: -3723, head: 9000 },
    { name: 'Elven Village', npcSelfId: 7599, locX: 45475, locY: 48359, locZ: -3060, head: 49152 },
    { name: 'Dark Elven Village', npcSelfId: 7600, locX: 12111, locY: 16686, locZ: -4582, head: 63240 },
    { name: 'Dwarven Village', npcSelfId: 7601, locX: 115632, locY: -177996, locZ: -905, head: 32768 },
    { name: 'Orc Village', npcSelfId: 7602, locX: -45032, locY: -113598, locZ: -192, head: 32768 }
].map(Object.freeze));
const GUIDE_TOWN_RADIUS = 7500;
const pointOf = at => ({ locX: Number(at?.fetchLocX?.() ?? at?.locX ?? 0), locY: Number(at?.fetchLocY?.() ?? at?.locY ?? 0) });
const distance2d = (a, b) => Math.hypot(Number(a?.locX || 0) - Number(b?.locX || 0), Number(a?.locY || 0) - Number(b?.locY || 0));
// The guide closest to a point (an actor or a plain location).
function closestGuide(at) {
    const point = pointOf(at);
    return GUIDES.reduce((best, guide) => distance2d(point, guide) < distance2d(point, best) ? guide : best, GUIDES[0]);
}
// Whether the guide stands within its town radius of the point: the one reach rule.
function guideInReach(at, guide = closestGuide(at)) {
    return !!guide && distance2d(pointOf(at), guide) <= GUIDE_TOWN_RADIUS;
}
// Whether a level and karma may take the guide's blessing (a far state's fields).
const newbieEligible = (level, karma) => Number(level) <= NEWBIE_GUIDE_MAX_LEVEL && !(Number(karma) > 0);

// The support a bot is given or buys for a hunt and renews when it ends: a Newbie
// Guide's, a clan hall's or a buffer's 20-minute buffs (C4 buff time 1200 s). Not a
// song or a dance (two-minute party tactics), not a toggle, not a debuff. A party
// buffer's casts are the same buffs: a grouped bot's rebuff answers none.
const REBUFF_FAMILIES = new Set(['wind_walk', 'shield', 'haste', 'might', 'blessed_body', 'magic_barrier',
    'blessed_soul', 'concentration', 'berserker_spirit', 'bless_shield', 'guidance', 'vampiric_rage', 'acumen',
    'empower', 'focus', 'death_whisper', 'agility', 'mental_shield', 'resist_shock', 'wild_magic']);
function rebuffable(effect) {
    return !!effect && effect.type !== 'debuff' && effect.toggle !== true && REBUFF_FAMILIES.has(Loadout.family(effect.key));
}
// The buffed fact: one rebuffable effect in force at `at` (a far state's saved
// effects, stats.coldCombat.effects, or a body's live list).
function buffedAt(effects, at) {
    return (effects || []).some(effect => Number(effect?.expiresAt || 0) > at && rebuffable(effect));
}
// The guide's blessing as saved effects (a far bot's: stats.coldCombat.effects),
// the same buffs applyFullNewbieBlessing casts on a body.
function newbieEffects(timestamp) {
    return NEWBIE_BUFF_TYPES.map(type => ({ ...effectData(ALL_BUFFS[type]), expiresAt: timestamp + BUFF_DURATION_MS }));
}

function remainingMs(actor, key) {
    const effectRemaining = EffectStore.remainingMs(actor, key);
    if (effectRemaining > 0) return effectRemaining;
    if (!actor?.activeBuffs?.[key]) return 0;
    return Math.max(0, actor.activeBuffs[key] - now());
}

function missingNewbieBuffs(actor, thresholdMs = 0) {
    return NEWBIE_BUFF_TYPES
        .map((type) => ALL_BUFFS[type])
        .filter((buff) => remainingMs(actor, buff.key) <= thresholdMs)
        .map((buff) => buff.key);
}

function needsNewbieRefresh(actor, thresholdMs = REFRESH_THRESHOLD_MS) {
    return isNewbieEligible(actor) && missingNewbieBuffs(actor, thresholdMs).length > 0;
}

function refreshActorPackets(session, actor, Generics) {
    const actorGenerics = Generics || invoke(path.actor);
    const ServerResponse = invoke('GameServer/Network/Response');

    actor.statusUpdateVitals(actor);
    actorGenerics.calculateStats(session, actor);

    session.dataSendToMe(ServerResponse.userInfo(actor));
    session.dataSendToMe(ServerResponse.abnormalStatusUpdate.fromActor(actor));
    session.dataSendToMe(ServerResponse.shortBuffStatusUpdate.fromActor(actor));
    try {
        const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
        PartyCompanionService.updateActorEffects(session);
    } catch (err) {
        utils.infoWarn('BotParty', 'party effect refresh failed: %s', err.message);
    }

    if (session.accountId && String(session.accountId).startsWith('bot_')) {
        session.dataSendToOthers(ServerResponse.charInfo(actor), actor);
        session.dataSendToOthers(ServerResponse.relationChanged(actor), actor);
    }
}

function needsBuff(actor, buffType, thresholdMs = REFRESH_THRESHOLD_MS) {
    const buff = ALL_BUFFS[buffType];
    return !!buff && remainingMs(actor, buff.key) <= thresholdMs;
}

function nextSupportBuff(actor, thresholdMs = REFRESH_THRESHOLD_MS) {
    return SUPPORT_BUFF_TYPES.find((type) => needsBuff(actor, type, thresholdMs)) || null;
}

function broadcastSkillCast(casterSession, caster, target, buff) {
    if (!casterSession?.dataSendToMeAndOthers || !caster || !target || caster === target) return;
    casterSession.dataSendToMeAndOthers(invoke('GameServer/Network/Response').skillStarted(caster, target.fetchId(), {
        fetchSelfId: () => buff.id,
        fetchCalculatedHitTime: () => 800,
        fetchReuseTime: () => 1000
    }), caster);
}

function applyBuff(session, actor, buffType, Generics, source = {}) {
    const buff = ALL_BUFFS[buffType];
    if (!buff || !actor) return null;

    const effect = EffectStore.apply(actor, {
        ...effectData(buff),
        durationMs: BUFF_DURATION_MS
    });
    if (!effect) return null;

    const store = ensureStore(actor);
    store[effect.key] = effect.expiresAt;
    invoke('GameServer/Effects/EffectTicker').scheduleExpiry(session, actor, effect);
    broadcastSkillCast(source.casterSession, source.caster, actor, buff);
    refreshActorPackets(session, actor, Generics);

    return {
        key: buff.key,
        name: buff.name,
        expiresAt: effect.expiresAt
    };
}

function applyNewbieBuff(session, actor, buffType, Generics, source) {
    if (!NEWBIE_BUFFS[buffType]) return null;
    return applyBuff(session, actor, buffType, Generics, source);
}

function applySupportBuff(session, actor, buffType, Generics, source) {
    if (!SUPPORT_BUFFS[buffType]) return null;
    return applyBuff(session, actor, buffType, Generics, source);
}

// The Newbie Guide's blessing: its buffs only, no HP/MP (C4: L2J Lisvus's newbie
// helper casts its buff skills and restores nothing).
function applyFullNewbieBlessing(session, actor, Generics) {
    if (!actor) return null;

    const store = ensureStore(actor);
    const expiresAt = now() + BUFF_DURATION_MS;
    NEWBIE_BUFF_TYPES.map((type) => ALL_BUFFS[type]).forEach((buff) => {
        const effect = EffectStore.apply(actor, {
            ...effectData(buff),
            expiresAt
        });
        if (!effect) return;
        store[effect.key] = effect.expiresAt;
        invoke('GameServer/Effects/EffectTicker').scheduleExpiry(session, actor, effect);
    });

    refreshActorPackets(session, actor, Generics);

    return {
        buffs: NEWBIE_BUFF_TYPES.map((type) => ALL_BUFFS[type].key),
        expiresAt
    };
}

function snapshot(actor) {
    const buffs = {};
    Object.values(ALL_BUFFS).forEach((buff) => {
        buffs[buff.key] = Math.round(remainingMs(actor, buff.key) / 1000);
    });

    return {
        eligible: isNewbieEligible(actor),
        needsRefresh: needsNewbieRefresh(actor),
        needsSupportRefresh: SUPPORT_BUFF_TYPES.some((type) => needsBuff(actor, type)),
        ...buffs
    };
}

module.exports = {
    BUFF_DURATION_MS,
    REFRESH_THRESHOLD_MS,
    NEWBIE_GUIDE_MAX_LEVEL,
    GUIDES,
    GUIDE_TOWN_RADIUS,
    ALL_BUFFS,
    NEWBIE_BUFFS,
    SUPPORT_BUFFS,
    applyBuff,
    applyNewbieBuff,
    applySupportBuff,
    applyFullNewbieBlessing,
    isNewbieEligible,
    newbieEligible,
    closestGuide,
    guideInReach,
    rebuffable,
    buffedAt,
    newbieEffects,
    missingNewbieBuffs,
    needsNewbieRefresh,
    needsBuff,
    nextSupportBuff,
    remainingMs,
    snapshot
};
