const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const DataCache = invoke('GameServer/DataCache');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');

// HP and MP shares under which a bot stops to rest. A party fights a little
// longer than a solo bot; a bot that already retreated (recovery locked)
// rests until it is nearly full. rested: where a solo rest ends (restOver):
// high in the bar, as a player sits once and then chains kills on a full bar,
// not kill-sit-kill-sit at the edge of the next fight (our
// choice, C4 leaves it to the player). 0.95 is the old hot wake line and the
// party's: the last few percent are a long wait for nothing a fight reads.
const THRESHOLDS = {
    solo: { hp: 0.35, mp: 0.20 },
    party: { hp: 0.30, mp: 0.18 },
    locked: { hp: 0.95, mp: 0.95 },
    rested: { hp: 0.95, mp: 0.95 }
};
// How far its caution moves a bot's rested line (restedLine): a reckless bot
// gets up at 0.92, a cautious one at 0.98.
const RESTED_CAUTION_SPREAD = 0.03;

// The mana rule: alone only casters rest for MP; in a party tanks and music
// fighters also recover MP for taunts and songs.
function restsForMana(subject, party = false) {
    return party ? BotRoles.needsPartyManaRecovery(subject) : BotRoles.shouldRestForMana(subject);
}

// Alone, a bot that heals
// itself with MP sits for MP too, so its heals pay the rest time they assume
// (SoloSelfHeal.betweenFights, BotCombatUtility.restMsPerMp). The rest rule
// (needsRest, ColdRest, the MP price) reads this; restsForMana stays the
// role's own mana rule.
function sitsForMana(subject, party = false) {
    return restsForMana(subject, party) || (!party && healsWithMana(subject));
}

// Does a rest under way last until MP is back? Alone by sitsForMana; a party
// member keeps the author's wake line (the mana rule is solo only), the
// role's own mana rule as FollowingState's botRecovering reads it. A tank or a
// music fighter sits for MP at a party's low line (needsRest) but gets up at
// whole HP and follows: Recharge and the leader's camp see to the rest.
function restWaitsForMana(subject, party = false) {
    return party ? restsForMana(subject) : sitsForMana(subject);
}

// Game data, once per class and level: does the class line know a self heal
// it casts again and again for MP (SoloSelfHeal.selfHeal: no HP gate such as
// Revival's, not a buff that also heals such as Battle Roar)?
const manaHealers = new Map();
let healerTree = null;
function healsWithMana(subject) {
    const classId = Number(BotRoles.classIdOf(subject));
    const level = Number(typeof subject?.fetchLevel === 'function' ? subject.fetchLevel() : subject?.level);
    if (!Number.isInteger(classId) || classId < 0 || !(level > 0)) return false;
    if (healerTree !== DataCache.skillTree) { manaHealers.clear(); healerTree = DataCache.skillTree; }
    const key = classId * 1000 + level;
    let heals = manaHealers.get(key);
    if (heals !== undefined) return heals;
    // lazy: cycle SoloSelfHeal -> BotCombatUtility -> RestPolicy.
    const SoloSelfHeal = invoke('GameServer/Bot/AI/SoloSelfHeal');
    const skills = ColdCombatProfile.skillsFor({ level, stats: { classId } }, classId, level);
    heals = skills.some((skill) => {
        if (skill.passive || !(Number(skill.mp) > 0)) return false;
        const semantic = C4SkillRules.resolveCached(skill);
        return SoloSelfHeal.selfHeal(semantic, null, true) && semantic.effectType !== 'buff'
            && semantic.condition?.actorHpPercentAtMost === undefined;
    });
    manaHealers.set(key, heals);
    return heals;
}

// options.pet: a summoner's living pet, { ratio, healable } (PetHealRule.restView):
// the summoner keeps its pet alive, so a pet
// below the bot's own HP line that its owner cannot heal now (no heal, no MP
// for it, silenced) sends the owner to rest as its own HP would; a heal on
// its reuse does not (the bot walks on and casts it when ready).
function needsRest(subject, hpRatio, mpRatio, options = {}) {
    return belowLines(subject, hpRatio, mpRatio, options, sitsForMana);
}
// The retreat rule: does a bot leave a live fight (or stay out of it after a
// flight)? Low HP sends anyone, low MP only a bot of the role's own mana rule.
// A melee self-healer sits for MP between fights (sitsForMana) but keeps
// swinging at low MP in a fight, as any melee bot does; it does not run as a mage.
function needsRetreat(subject, hpRatio, mpRatio, options = {}) {
    return belowLines(subject, hpRatio, mpRatio, options, restsForMana);
}
function belowLines(subject, hpRatio, mpRatio, options, manaRule) {
    const limits = options.locked ? THRESHOLDS.locked : options.party ? THRESHOLDS.party : THRESHOLDS.solo;
    return hpRatio < limits.hp || (mpRatio < limits.mp && manaRule(subject, options.party === true))
        || petNeedsRest(options.pet, limits.hp);
}
function petNeedsRest(pet, line = THRESHOLDS.solo.hp) {
    return !!pet && pet.healable !== true && Number(pet.ratio) < line;
}
// A rest ends only once the pet it waits for is whole too (or its owner can heal it).
function petRested(pet) {
    return !petNeedsRest(pet, THRESHOLDS.locked.hp);
}

// A solo bot's rested line: THRESHOLDS.rested moved by its persona's caution
// (BotPersona traits, 0.5 without one: the tables' reference bot), within
// RESTED_CAUTION_SPREAD. Deterministic per bot, hot and cold.
function restedLine(persona = null) {
    const caution = Number(persona?.traits?.caution);
    const shift = Number.isFinite(caution) ? (Math.max(0, Math.min(1, caution)) - 0.5) * 2 * RESTED_CAUTION_SPREAD : 0;
    return { hp: THRESHOLDS.rested.hp + shift, mp: THRESHOLDS.rested.mp + shift };
}

// When a rest is over, hot (RestingState) and cold (BackgroundResolver.resolveRest)
// alike: at the bot's rested line (restedLine; MP too when it rests for mana:
// restWaitsForMana / ColdRest.requiresManaRecovery), a party member at the
// locked line (its camp and its healers see to the rest). whole: a rest the
// next fight sent an already rested bot to (it was refused at its line) ends
// on a full bar, HP and MP, as the whole-bar pull verdict that picked the
// fight admits it there: no stand, refuse and sit again. The pet rested either
// way (petRested).
function restOver(vitals, { mana = false, pet = null, party = false, persona = null, whole = false } = {}) {
    if (!petRested(pet)) return false;
    const hp = Number(vitals?.hp) || 0, mp = Number(vitals?.mp) || 0;
    const maxHp = Math.max(1, Number(vitals?.maxHp) || 0), maxMp = Math.max(1, Number(vitals?.maxMp) || 0);
    if (whole) return hp >= maxHp && mp >= maxMp;
    const line = party ? THRESHOLDS.locked : restedLine(persona);
    return hp / maxHp >= line.hp && (!mana || mp / maxMp >= line.mp);
}

function raidReady(subject, vitals = subject?.vitals || {}, paidCost = null) {
    // A native cast pays immediately before effects, in the same callback.
    // Admission requires the reserve before that one payment; this credits
    // only the executor's actual debit for the guard, never its saved vitals.
    const hp = Number(vitals.hp) + Math.max(0, Number(paidCost?.hp) || 0), maxHp = Number(vitals.maxHp);
    const mp = Number(vitals.mp) + Math.max(0, Number(paidCost?.mp) || 0), maxMp = Number(vitals.maxMp);
    if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0) return false;
    if (restsForMana(subject, true) && (!Number.isFinite(mp) || !Number.isFinite(maxMp) || maxMp <= 0)) return false;
    return !needsRest(subject, hp / maxHp, mp / maxMp, { party: true, locked: true });
}

// The rest's posture: a bot sits only when sitting
// refills what it lacks faster than standing does (C4: a Sorcerer's Clear
// Mind, 1297, regenerates MP standing only, past its seated rate from 48).
// seated, standing: the two postures' { hp, mp } per regen tick; mana: the
// bot rests for MP too (sitsForMana).
function sitsToRest(seated, standing, missingHp, missingMp, mana) {
    const ticks = (regen) => Math.max(Math.max(0, missingHp) / Math.max(0.01, Number(regen?.hp) || 0),
        mana ? Math.max(0, missingMp) / Math.max(0.01, Number(regen?.mp) || 0) : 0);
    return ticks(seated) <= ticks(standing);
}

module.exports = { THRESHOLDS, restsForMana, sitsForMana, restWaitsForMana, needsRest, needsRetreat, petRested, restedLine, restOver, raidReady, sitsToRest };
