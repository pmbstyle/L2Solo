'use strict';

// Owner: when a solo bot on mobs heals itself, hot and cold alike.
// No fixed HP line:
// - in a fight, only when the bot would not outlive the mob otherwise (the
//   damage it takes until the mob dies reaches its HP at the fight's pace) and
//   the heal outgains what the bot loses during its cast;
// - between fights, when the heal gives HP faster than sitting does (its cast
//   plus the seated rest that wins its MP back, at its MP price), and the bot
//   misses at least what it heals: a heal ready now between fights; where the
//   bot would sit down to rest, a heal on its reuse too, its wait counted, and
//   the bot waits for it on its feet.
// It reads the hot actor's API: a hot bot, or a cold profile through
// ColdClassPolicy.actorFor. Party and PvP heals stay the author's
// (BotSkillCapabilities, BotPvpTactics, the cold chooseHeal).
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const Formulas = invoke('GameServer/Formulas');
const Utility = invoke('GameServer/Bot/AI/BotCombatUtility');
const PetHealRule = invoke('GameServer/Bot/AI/PetHealRule');

const INSTANT = new Set([C4SkillRules.HEAL, C4SkillRules.HEAL_PERCENT, C4SkillRules.HEAL_STATIC, C4SkillRules.HEAL_HOT]);
const PERIODIC = new Set([C4SkillRules.HOT, C4SkillRules.HEAL_HOT]);
const ON_SELF = new Set(['self', 'friendly', 'party', 'ally']);

// The heal a skill gives its caster: the instant part, and with periodic the
// ticks too (between fights the bot waits them out).
function healAmount(actor, skill, semantic, periodic) {
    const type = semantic.skillType;
    const maxHp = Number(actor.fetchMaxHp?.()) || 0;
    let amount = !INSTANT.has(type) ? 0
        : type === C4SkillRules.HEAL_PERCENT ? maxHp * (Number(skill.fetchPower?.()) || 0) / 100
            : Formulas.calcHealAmount(skill.fetchPower?.());
    if (periodic && PERIODIC.has(type) && semantic.hot) amount += (Number(semantic.hot.heal) || 0) * (Number(semantic.hot.count) || 0);
    return amount;
}

// A skill that heals its caster (periodic: the heals over time count too).
function selfHeal(semantic, targetKind, periodic) {
    return (INSTANT.has(semantic.skillType) || (periodic && PERIODIC.has(semantic.skillType)))
        && ON_SELF.has(semantic.target || targetKind);
}

// The heals a bot has: { skill, limit (its HP percent at most), amount, mp,
// castMs }. A cold actor is one fixed profile (ColdClassPolicy.actorFor,
// fixedProfile): its list is made once; a hot actor's per call
// (its buffs move its numbers).
const lists = new WeakMap();
function candidates(actor, periodic) {
    const fixed = actor.fixedProfile === true;
    let held = fixed ? lists.get(actor) : null;
    if (!held) {
        held = {};
        if (fixed) lists.set(actor, held);
    }
    const key = periodic ? 'periodic' : 'instant';
    if (held[key]) return held[key];
    const speed = { castSpd: Math.max(1, Utility.statOf(actor, 'CastSpd')), atkSpd: Math.max(1, Utility.statOf(actor, 'AtkSpd')) };
    const list = [];
    for (const skill of actor.skillset?.skills || []) {
        if (!skill || skill.fetchPassive?.()) continue;
        const semantic = skill.fetchSemantic?.() || {};
        if (!selfHeal(semantic, skill.fetchTargetKind?.(), periodic)) continue;
        const amount = healAmount(actor, skill, semantic, periodic);
        if (amount > 0) list.push({ skill, limit: semantic.condition?.actorHpPercentAtMost, amount,
            mp: Number(skill.fetchConsumedMp?.()) || 0, castMs: Math.max(1, Utility.skillHitMs(speed, skill)) });
    }
    return held[key] = list;
}

// The heals the bot can cast on itself now (candidates by its HP, MP and
// reuse; wait: those on their reuse too); none while it may not cast: a
// silenced bot fights on with its weapon and walks on between fights.
function heals(actor, periodic, wait = false) {
    const list = candidates(actor, periodic);
    if (!list.length || PetHealRule.castBlocked(actor)) return [];
    const hp = Number(actor.fetchHp?.()) || 0, maxHp = Math.max(1, Number(actor.fetchMaxHp?.()) || 1);
    const mp = Number(actor.fetchMp?.()) || 0;
    return list.filter((heal) => (heal.limit === undefined || hp / maxHp * 100 <= heal.limit)
        && heal.mp <= mp && (wait || actor.canUseSkill?.(heal.skill) !== false));
}

// In a fight: pace { dealtPerMs (to the mob), takenPerMs (by the bot) }, mobHp.
// Returns the heal to cast, or null.
function inFight(actor, { mobHp, dealtPerMs, takenPerMs }) {
    const hp = Number(actor.fetchHp?.()) || 0;
    if (!(takenPerMs > 0) || !(mobHp > 0)) return null;
    const untilDeadMs = dealtPerMs > 0 ? mobHp / dealtPerMs : Infinity;
    if (takenPerMs * untilDeadMs < hp) return null;
    const missing = Math.max(0, Number(actor.fetchMaxHp?.()) - hp);
    let best = null, bestGain = 0;
    for (const heal of heals(actor, false)) {
        const gain = Math.min(missing, heal.amount) - takenPerMs * heal.castMs;
        if (gain > bestGain) { best = heal; bestGain = gain; }
    }
    return best?.skill || null;
}

// The heal to cast instead of sitting: { skill, waitMs } or null. Between
// fights only a heal ready now counts (waitMs 0): the next fight does not
// wait for one. wait (the bot would sit down to rest): a heal on its reuse is
// a heal coming, priced with its wait, and the bot stands while it waits (our
// choice: no sit and stand per heal); the regeneration of that wait is not
// counted, so the rule leans to sitting, never to a wait that loses.
function betweenFights(actor, { wait = false } = {}) {
    const missing = Math.max(0, Number(actor.fetchMaxHp?.()) - (Number(actor.fetchHp?.()) || 0));
    const sitting = Utility.seatedHpPerMs(actor);
    if (!(missing > 0)) return null;
    const restMsPerMp = Utility.restMsPerMp(actor);
    let best = null, bestRate = sitting, bestWaitMs = 0;
    for (const heal of heals(actor, true, wait)) {
        if (heal.amount > missing) continue;
        const waitMs = wait ? Math.max(0, Number(actor.skillReadyInMs(heal.skill)) || 0) : 0;
        const rate = heal.amount / (waitMs + heal.castMs + heal.mp * restMsPerMp);
        if (rate > bestRate) { best = heal; bestRate = rate; bestWaitMs = waitMs; }
    }
    return best ? { skill: best.skill, waitMs: bestWaitMs } : null;
}

// The pace of a fight from its start: start { at, hp, mobHp, healed }.
function pace(start, { at, hp, mobHp }) {
    const ms = Number(at) - Number(start.at);
    if (!(ms > 0)) return { dealtPerMs: 0, takenPerMs: 0 };
    return { dealtPerMs: Math.max(0, start.mobHp - mobHp) / ms,
        takenPerMs: Math.max(0, start.hp + (Number(start.healed) || 0) - hp) / ms };
}

// Hot: a solo hunter's turn. Casts the heal on itself and returns true, or false.
function tryInFight(session, bot, npc, Generics) {
    if (bot.state?.fetchCasts?.()) return false;
    const now = Date.now(), targetId = Number(npc?.fetchId?.()) || 0;
    if (session.selfHealPace?.targetId !== targetId) {
        session.selfHealPace = { targetId, at: now, hp: Number(bot.fetchHp()), mobHp: Number(npc.fetchHp()), healed: 0 };
        return false;
    }
    const skill = inFight(bot, { mobHp: Number(npc.fetchHp()), ...pace(session.selfHealPace,
        { at: now, hp: Number(bot.fetchHp()), mobHp: Number(npc.fetchHp()) }) });
    return skill ? castOnSelf(session, bot, skill, Generics, 'solo_self_heal_in_fight') : false;
}

function tryBetweenFights(session, bot, Generics) {
    if (bot.state?.fetchCasts?.()) return false;
    const pick = betweenFights(bot);
    return pick ? castOnSelf(session, bot, pick.skill, Generics, 'solo_self_heal_between_fights') : false;
}

// Hot: at a rest door, before the bot sits down. A heal, ready or on its
// reuse, that beats the rest keeps it on its feet (the between-fights turn
// casts it once ready; its own cast in flight is such a heal); true then.
function healsInsteadOfRest(session, bot) {
    const pick = betweenFights(bot, { wait: true });
    if (!pick) return false;
    session.lastCombatDecision = { action: 'wait_heal', reason: 'solo_self_heal_instead_of_rest',
        skillId: pick.skill.fetchSelfId(), waitMs: pick.waitMs, at: Date.now() };
    return true;
}

function castOnSelf(session, bot, skill, Generics, reason) {
    const semantic = skill.fetchSemantic?.() || {};
    if (session.selfHealPace) session.selfHealPace.healed += healAmount(bot, skill, semantic, false);
    session.lastCombatDecision = { action: 'cast_skill', reason, skillId: skill.fetchSelfId(), at: Date.now() };
    Generics.skillExec(session, bot, { id: bot.fetchId(), selfId: skill.fetchSelfId(), ctrl: false });
    return true;
}

module.exports = { selfHeal, inFight, betweenFights, pace, healAmount, tryInFight, tryBetweenFights, healsInsteadOfRest };
