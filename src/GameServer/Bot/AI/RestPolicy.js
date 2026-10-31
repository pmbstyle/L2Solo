const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const DataCache = invoke('GameServer/DataCache');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');

// HP and MP shares under which a bot stops to rest. A party fights a little
// longer than a solo bot; a bot that already retreated (recovery locked)
// rests until it is nearly full.
const THRESHOLDS = {
    solo: { hp: 0.35, mp: 0.20 },
    party: { hp: 0.30, mp: 0.18 },
    locked: { hp: 0.95, mp: 0.95 }
};

// The mana rule: alone only casters rest for MP; in a party tanks and music
// fighters also recover MP for taunts and songs.
function restsForMana(subject, party = false) {
    return party ? BotRoles.needsPartyManaRecovery(subject) : BotRoles.shouldRestForMana(subject);
}

// T106 (docs/game-decisions.md "Self-heal and MP"): alone, a bot that heals
// itself with MP sits for MP too, so its heals pay the rest time they assume
// (SoloSelfHeal.betweenFights, BotCombatUtility.restMsPerMp). The rest rule
// (needsRest, ColdRest, the MP price) reads this; restsForMana stays the
// role's own mana rule.
function sitsForMana(subject, party = false) {
    return restsForMana(subject, party) || (!party && healsWithMana(subject));
}

// Does a rest under way last until MP is back? Alone by sitsForMana; a party
// member keeps the author's wake line (T107: the mana rule is solo only), the
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
// the summoner keeps its pet alive (docs/game-decisions.md, 10-30), so a pet
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

// The rest's posture (user 10-29, T106): a bot sits only when sitting
// refills what it lacks faster than standing does (C4: a Sorcerer's Clear
// Mind, 1297, regenerates MP standing only, past its seated rate from 48).
// seated, standing: the two postures' { hp, mp } per regen tick; mana: the
// bot rests for MP too (sitsForMana).
function sitsToRest(seated, standing, missingHp, missingMp, mana) {
    const ticks = (regen) => Math.max(Math.max(0, missingHp) / Math.max(0.01, Number(regen?.hp) || 0),
        mana ? Math.max(0, missingMp) / Math.max(0.01, Number(regen?.mp) || 0) : 0);
    return ticks(seated) <= ticks(standing);
}

module.exports = { THRESHOLDS, restsForMana, sitsForMana, restWaitsForMana, needsRest, needsRetreat, petRested, raidReady, sitsToRest };
