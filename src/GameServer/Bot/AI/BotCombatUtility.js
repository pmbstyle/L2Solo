const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const Attack = invoke('GameServer/Skills/WeaponMask');
const Formulas = invoke('GameServer/Formulas');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const ClassPolicy = invoke('GameServer/Bot/AI/BotClassPolicy');
const Feedback = invoke('GameServer/Bot/AI/BotActionFeedback');
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const EffectStats = invoke('GameServer/Effects/EffectStats');

const OFFENSIVE_TYPES = new Set([
    C4SkillRules.DAMAGE,
    C4SkillRules.DAMAGE_EFFECT,
    C4SkillRules.DEATH_LINK,
    C4SkillRules.FATAL,
    C4SkillRules.DRAIN,
    C4SkillRules.BLOW,
    C4SkillRules.EFFECT
]);
const BOW_WEAPON_MASK = 32;
const MIN_BOW_SKILL_RANGE = 400;
const AREA_SOURCE_TARGETS = new Set(['area', 'front_area', 'aura']);
const MAGE_MELEE_FINISH_MAX_HITS = 2;

function distance2d(a, b) {
    if (!a?.fetchLocX || !b?.fetchLocX) return 0;
    const dx = a.fetchLocX() - b.fetchLocX();
    const dy = a.fetchLocY() - b.fetchLocY();
    return Math.sqrt((dx * dx) + (dy * dy));
}

function reserveRatio(role) {
    if (role === 'healer' || role === 'buffer') return 0.45;
    if (role === 'mage') return 0.18;
    return 0.10;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function basicAttackDamageEstimate(bot, target) {
    const pAtk = Number(bot?.fetchCollectivePAtk?.() ?? bot?.fetchPAtk?.());
    const pDef = Number(target?.fetchCollectivePDef?.() ?? target?.fetchPDef?.());
    if (!Number.isFinite(pAtk) || pAtk <= 0 || !Number.isFinite(pDef) || pDef <= 0) return 0;

    // Use an ordinary, non-critical, non-soulshot hit. Random weapon spread,
    // crits, and shots may finish sooner, but they must not make a mage run
    // into melee while the target still has meaningful HP.
    return Math.max(0, Math.round(Formulas.calcMeleeDamage(pAtk, 0, pDef)));
}

function mageMeleeFinishOpportunity(bot, target, maxHits = MAGE_MELEE_FINISH_MAX_HITS) {
    if (!target || target.isDead?.() === true || target.state?.fetchDead?.() === true) return null;
    const targetHp = Number(target.fetchHp?.());
    const damagePerHit = basicAttackDamageEstimate(bot, target);
    const hitLimit = Math.max(1, Math.floor(Number(maxHits) || MAGE_MELEE_FINISH_MAX_HITS));
    if (!Number.isFinite(targetHp) || targetHp <= 0 || damagePerHit <= 0) return null;
    if (targetHp > damagePerHit * hitLimit) return null;
    return {
        targetHp,
        damagePerHit,
        estimatedHits: Math.max(1, Math.ceil(targetHp / damagePerHit)),
        maxHits: hitLimit
    };
}

// A creature's number: the hot collective stat, else the plain one (the cold
// fight adapter, ColdClassPolicy, carries only the plain fetchers).
function statOf(creature, name) {
    const value = Number(creature?.[`fetchCollective${name}`]?.() ?? creature?.[`fetch${name}`]?.());
    return Number.isFinite(value) ? value : 0;
}

// One normal attack: the adapter's own time (cold), else the hot Attack.js
// cycle of the equipped weapon (Formulas.normalAttackMs).
function normalAttackMs(bot) {
    if (bot?.fetchNormalAttackMs) return bot.fetchNormalAttackMs();
    const weapon = bot?.backpack?.fetchEquippedWeapon?.();
    const bow = weapon?.fetchKind?.() === 'Weapon.Bow';
    return Math.max(1, Formulas.normalAttackMs(statOf(bot, 'AtkSpd'), { bow,
        reuseDelay: weapon?.fetchAttackReuseDelay?.(), reuseMul: bow ? EffectStats.multiplier(bot, 'atkReuseMul') : 1 }));
}

// MP a resting bot wins back per ms: the adapter's cold rest rate, else the
// hot Automation's regeneration per its 3 s tick in the faster posture
// (seated, or standing: RestPolicy.sitsToRest, user 10-29).
function seatedMpPerMs(bot) {
    if (bot?.fetchSeatedMpPerMs) return bot.fetchSeatedMpPerMs();
    const amount = (options) => Number(bot?.automation?.fetchRevMpAmount?.(bot, options)) || 0;
    return Math.max(0, amount({ seated: true }), amount({ standing: true })) / Formulas.REGEN_TICK_MS;
}

function seatedHpPerMs(bot) {
    if (bot?.fetchSeatedHpPerMs) return bot.fetchSeatedHpPerMs();
    return Math.max(0, Number(bot?.automation?.fetchRevHpAmount?.(bot, { seated: true })) || 0) / Formulas.REGEN_TICK_MS;
}

// The seated ms one spent MP costs a bot that sits for mana (T100), else 0.
function restMsPerMp(bot, party = false) {
    const seated = seatedMpPerMs(bot);
    return seated > 0 && RestPolicy.sitsForMana(bot, party) ? restShare(bot.fetchMp?.(), bot.fetchMaxMp?.()) / seated : 0;
}

// T100 (docs/game-decisions.md, Bot behaviour): MP is priced in rest time.
// A damage skill's worth is its damage, capped at the target's HP, per ms of
// its cast plus the seated rest that wins its MP back; the alternative is the
// normal attack's hit, capped alike, per attack time - nothing for a staff
// caster, whose weapon only finishes (BotRoles.usesCasterWeaponCombat). A
// skill pays when it beats the alternative, and the paying skill with the best
// rate is cast: a strong nuke while MP is plentiful, a cheaper one as the bar
// empties, none that only overkills. The rest is charged by the share of the
// bar already spent: nothing at full MP (its regeneration would only
// overflow), the whole rest once the bar is empty; a bot that never sits for
// MP (RestPolicy: it rests for HP and its MP refills meanwhile) pays none.
// Estimates are ordinary hits (no crit, shot or spread), skill and attack
// measured alike.

// The numbers every candidate of one pick shares (once per select), or null
// when the bot or target lacks them (no price, the old pick stands).
function priceContext(bot, target, policy = {}) {
    const pAtk = statOf(bot, 'PAtk'), pDef = statOf(target, 'PDef'), mDef = statOf(target, 'MDef');
    const targetHp = Number(target?.fetchHp?.());
    if (!(pAtk > 0 && pDef > 0 && mDef > 0 && targetHp > 0)) return null;
    const party = String(policy.classProfile?.mode || '').startsWith('party');
    const attackRate = Roles.usesCasterWeaponCombat(bot) ? 0
        : Math.min(targetHp, basicAttackDamageEstimate(bot, target)) / normalAttackMs(bot);
    return { pAtk, pDef, mDef, targetHp, attackRate, mAtk: statOf(bot, 'MAtk'),
        atkSpd: Math.max(1, statOf(bot, 'AtkSpd')), castSpd: Math.max(1, statOf(bot, 'CastSpd')),
        restMsPerMp: restMsPerMp(bot, party) };
}

// The share of a full rest a spent MP costs: the share of the bar spent.
function restShare(mp, maxMp) {
    return clamp(1 - ((Number(mp) || 0) / Math.max(1, Number(maxMp) || 1)), 0, 1);
}

// extraMs: casts the plan makes before this one (charge preparation).
function manaPrice(context, decision, totalMp = decision.cost, extraMs = 0) {
    if (!context) return null;
    const skill = decision.skill, spell = skill.fetchSpell?.() === true;
    const raw = spell ? Formulas.calcMagicDamage(context.mAtk, decision.power, context.mDef)
        : skill.fetchSkillType?.() === C4SkillRules.BLOW
            ? Formulas.calcBlowDamage(context.pAtk, 0, context.pDef, decision.power, { rng: () => 0 })
            : Formulas.calcPhysicalDamage(context.pAtk, 0, context.pDef, decision.power, { rng: () => 0.5 });
    const restMs = context.restMsPerMp * Math.max(0, totalMp);
    const rate = Math.min(context.targetHp, raw * decision.effectiveness)
        / Math.max(1, skillHitMs(context, skill) + extraMs + restMs);
    return { rate, attackRate: context.attackRate, pays: rate > context.attackRate };
}

function skillHitMs(context, skill) {
    const spell = skill.fetchSpell?.() === true;
    return Formulas.calcSkillHitTime(Number(skill.fetchHitTime?.()) || (spell ? 1000 : 600),
        spell ? context.castSpd : context.atkSpd, { magic: spell });
}

// The old picks stand in PvP and raids (no rest between kills pays their MP
// back), for a companion whose player set skill priorities or a stance (the
// player decides), and where a caller asks only for reach (priceMana false).
function pricesMana(policy = {}, target = null) {
    const stance = policy.stance || policy.combatStance || 'balanced';
    return policy.pvp !== true && !String(policy.classProfile?.mode || '').endsWith('pvp')
        && policy.raid !== true && !BotRaidSafety.isProtectedRaidEntity(target) && policy.priceMana !== false
        && stance === 'balanced' && !Object.keys(policy.skillPriorities || {}).length;
}

function policyAdjustment(skill, role, range, cost, maxMp, policy = {}) {
    const skillId = String(skill?.fetchSelfId?.() || '');
    const priorities = policy.skillPriorities || {};
    let adjustment = clamp(Number(priorities[skillId] || 0), -50, 50);
    const stance = policy.stance || policy.combatStance || 'balanced';

    // Stance is only a bounded scoring hint for the offensive planner. It
    // cannot bypass learned-skill, range, cooldown, MP, or safety checks, and
    // support/revival planners never call this utility for emergency actions.
    if (stance === 'aggressive') {
        adjustment += Math.min(18, Math.max(0, Number(skill.fetchPower?.() || 0) / 40));
    } else if (stance === 'defensive') {
        const affordableReserve = (maxMp - cost) / Math.max(1, maxMp);
        adjustment += affordableReserve >= reserveRatio(role) ? 10 : -8;
    } else if (stance === 'ranged') {
        adjustment += range >= 400 ? 18 : -18;
    }

    return Math.round(clamp(adjustment, -68, 68));
}

function evaluateCandidate(bot, target, skill, role, policy = {}, plannedCharges = null) {
    const reject = reason => {
        if (policy.rejectedAlternatives && policy.rejectedAlternatives.length < 8 && skill?.fetchPassive?.() !== true) {
            policy.rejectedAlternatives.push({ skillId: skill?.fetchSelfId?.(), reason });
        }
        return null;
    };
    if (!skill || skill.fetchPassive?.()) return null;
    if (target?.isDead?.() === true || target?.state?.fetchDead?.() === true || target?.fetchHp?.() <= 0) return reject('target_dead');
    if (Feedback.blocked(bot,target,skill)) return reject('native_rejection_backoff');
    // SkillRequest rejects a skill still on reuse after the combat planner has
    // already committed to it. Treat that as unavailable here so a melee bot
    // falls back to its normal attack instead of idling until cooldown ends.
    if (bot.canUseSkill?.(skill) === false) return reject('reuse');
    const semantic = skill.fetchSemantic?.() || {};
    if (semantic.notUsedInC4) return null;
    const hpLimit = semantic.condition?.actorHpPercentAtMost;
    if (hpLimit !== undefined && Number(bot.fetchHp?.()) / Math.max(1, Number(bot.fetchMaxHp?.())) * 100 > hpLimit) return null;
    const hpCost = Math.max(0, Number(skill.fetchConsumedHp?.() || 0));
    if (hpCost > 0 && hpCost >= Number(bot.fetchHp?.() || 0)) return null;
    // Internal bot casts bypass the packet-level target restriction checks.
    // Remove undead-only skills before scoring so a living mob cannot make a
    // holy nuke look like the best combat action and waste a cast window.
    if (semantic.undeadOnly && target?.fetchUndead?.() !== true) return null;
    if (policy.avoidAreaDamage === true && AREA_SOURCE_TARGETS.has(String(semantic.sourceTarget || '').toLowerCase())) return null;
    const allowedWeapons = Number(semantic.requires?.weaponsAllowed) || 0;
    if (allowedWeapons && (allowedWeapons & Attack.weaponMaskFor(bot)) === 0) return reject('weapon');
    // Match native rollBlow's mandatory rear gate before spending a cast.
    // Cold combat has no heading evidence, so it uses another valid blow.
    if ((Number(semantic.requires?.condition) & 0x0008) !== 0
        && bot.attack?.isBehindTarget?.(bot,target) !== true) return reject('rear_position_required');
    const requiredCharges = Math.max(0, Number(semantic.requires?.charges) || 0);
    const currentCharges = Math.max(0, Number(plannedCharges ?? bot.fetchCharges?.() ?? bot.charges ?? 0) || 0);
    if (requiredCharges > currentCharges) return reject('charges');
    if (!OFFENSIVE_TYPES.has(skill.fetchSkillType?.())) return null;
    if (skill.fetchTargetKind?.() !== 'enemy') return null;

    // Pure debuffs are tactical tools, not damage rotation. Scoring their
    // effect power as damage made mages spam Sleep/Root until their MP ran out.
    if (skill.fetchSkillType() === C4SkillRules.EFFECT && semantic.effectType === 'debuff') return null;

    const range = Number(skill.fetchDistance?.());
    if (!Number.isFinite(range) || range < 0) return null;
    // Some generic fighter skills (for example Power Strike) have no weapon
    // restriction in the source data.  A bow user must never pick one of
    // those short-range attacks and run into melee just because its score is
    // higher than a shot currently on reuse.
    if ((Attack.weaponMaskFor(bot) & BOW_WEAPON_MASK) !== 0 && range < MIN_BOW_SKILL_RANGE) return null;

    const mp = Number(bot.fetchMp?.() || 0);
    const maxMp = Math.max(1, Number(bot.fetchMaxMp?.() || mp || 1));
    const cost = Math.max(0, Number(skill.fetchConsumedMp?.() || 0));
    // A mage's staff is the primary weapon. Keeping a generic MP reserve made
    // a mage walk into melee even though it could still afford a nuke.
    const classProfile = policy.classProfile || ClassPolicy.profileFor(bot, policy);
    const reserve = classProfile.supported ? classProfile.manaReserve : (policy.pvp ? 0 : reserveRatio(role));
    if (cost > mp || (role !== 'mage' && (mp - cost) / maxMp < reserve)) return reject('mp_budget');

    const type = skill.fetchSkillType();
    const basePower = Math.max(0, Number(skill.fetchPower?.() || 0));
    let power = type === C4SkillRules.FATAL
        ? Formulas.calcFatalPower(basePower, bot.fetchHp?.(), bot.fetchMaxHp?.())
        : basePower;
    if (requiredCharges > 0) power *= 0.8 + (0.201 * currentCharges);
    const distance = distance2d(bot, target);
    const reasons = [];
    let score = 100 + Math.log2(power + 1) * 35 - cost * 1.5;

    if (range + 80 >= distance) {
        score += 100;
        reasons.push('in_range');
    } else {
        score -= Math.min(220, (distance - range) / 5);
        reasons.push('close_distance');
    }

    const spell = skill.fetchSpell?.() === true;
    if (role === 'mage' && spell) {
        score += 170;
        reasons.push('mage_spell');
    }
    if (role === 'archer' && range >= 400) {
        score += 150;
        reasons.push('ranged_attack');
    }
    if (role === 'dagger' && type === C4SkillRules.BLOW) {
        score += 220;
        reasons.push('dagger_blow');
    }
    if (role === 'tank' && type === C4SkillRules.EFFECT) {
        score += 90;
        reasons.push('tank_control');
    }
    const adjustment = policyAdjustment(skill, role, range, cost, maxMp, policy);
    if (adjustment) {
        score += adjustment;
        reasons.push(`policy_${adjustment > 0 ? 'up' : 'down'}:${adjustment}`);
    }
    const preference = ClassPolicy.offensivePreference(bot, target, skill, { ...policy, classProfile });
    score += preference.score;
    reasons.push(...preference.reasons);
    const effectiveness = TargetMatchup.skillModifier(bot, target, skill, policy.matchupTarget);
    // Keep a last-resort attack available in self-defense, but prefer an
    // effective learned element/weapon skill when the target resists another.
    score += Math.round(180 * Math.log2(Math.max(0.01, Math.min(2, effectiveness))));
    if (effectiveness !== 1) reasons.push(`target_efficiency:${effectiveness.toFixed(2)}`);
    return { skill, score: Math.round(score), reasons, cost, range, power, effectiveness,
        intent: type === C4SkillRules.DRAIN && bot.fetchHp?.() < bot.fetchMaxHp?.() ? 'damage_and_sustain' : 'damage',
        policyAdjustment: adjustment,
        classAdjustment: preference.score, classMode: classProfile.mode };
}

function evaluate(bot, target, skill, role, policy = {}) {
    return evaluateCandidate(bot, target, skill, role, policy);
}

function select(bot, target, role, policy = {}) {
    policy = { ...policy, classProfile: policy.classProfile || ClassPolicy.profileFor(bot, policy),
        matchupTarget: TargetMatchup.targetView(target, TargetMatchup.skillStats(bot)) };
    const skills = bot?.skillset?.skills || [];
    const candidates = role === 'mage'
        ? skills.filter((skill) => skill.fetchSpell?.() === true)
        : skills;

    const decisions = candidates.map((skill) => evaluate(bot, target, skill, role, policy)).filter(Boolean);
    if (!pricesMana(policy, target)) return decisions.sort((a, b) => b.score - a.score)[0] || null;
    // Priced (T100): the paying skill with the best damage rate; a skill
    // without a price (no numbers) keeps its place by score after them.
    const context = decisions.length ? priceContext(bot, target, policy) : null;
    const priced = decisions.map((decision) => ({ decision, verdict: manaPrice(context, decision) }))
        .filter(({ decision, verdict }) => !verdict || verdict.pays || rejectPrice(decision, policy));
    return priced.sort((a, b) => (b.verdict?.rate ?? -1) - (a.verdict?.rate ?? -1)
        || b.decision.score - a.decision.score)[0]?.decision || null;
}

// A rejected price joins the bot's rejected alternatives like any other gate.
function rejectPrice(decision, policy) {
    if (Diagnostics.active()) Diagnostics.count('mana_price', 'rejected', policy.classProfile?.role || 'unknown');
    if (policy.rejectedAlternatives && policy.rejectedAlternatives.length < 8) {
        policy.rejectedAlternatives.push({ skillId: decision.skill.fetchSelfId?.(), reason: 'mp_price' });
    }
    return false;
}

// The offensive pick and the charge plan that competes with it, from one
// select: { ready, charge }. ready is the select result in every case.
function selectAttackAndChargePlan(bot, target, role, policy = {}) {
    const ready = select(bot, target, role, policy);
    return { ready, charge: chargePlanAgainst(bot, role, policy, target, ready) };
}

function selectChargePlan(bot, role, policy = {}, target = null) {
    return chargePlanAgainst(bot, role, policy, target, undefined);
}

// ready: the select result already computed by the caller, or undefined to
// compute it here only when the bot has a charge preparation skill.
function chargePlanAgainst(bot, role, policy, target, ready) {
    const skills = bot?.skillset?.skills || [];
    const current = Math.max(0, Number(bot.fetchCharges?.() ?? bot.charges ?? 0) || 0);
    const weaponMask = Attack.weaponMaskFor(bot);
    const mp = Math.max(0, Number(bot.fetchMp?.()) || 0);
    const maxMp = Math.max(1, Number(bot.fetchMaxMp?.()) || mp || 1);
    const profile = policy.classProfile || ClassPolicy.profileFor(bot, policy);
    const reserve = profile.supported ? profile.manaReserve : (policy.pvp ? 0 : reserveRatio(role));
    const preparation = skills
        .filter((skill) => {
            if (!skill || skill.fetchPassive?.() || bot.canUseSkill?.(skill) === false || Feedback.blocked(bot,bot,skill)) return false;
            const semantic = skill.fetchSemantic?.() || {};
            const allowed = Number(semantic.requires?.weaponsAllowed) || 0;
            return semantic.skillType === C4SkillRules.CHARGE
                && !semantic.notUsedInC4
                && (!allowed || (allowed & weaponMask) !== 0);
        });
    if (!preparation.length) return null;
    if (ready === undefined) ready = select(bot, target, role, policy);
    let best = null, context;
    for (const spender of skills) {
        const needed = Math.max(0, Number(spender?.fetchSemantic?.()?.requires?.charges) || 0);
        if (needed <= current) continue;
        // Reuse the offensive gates against this target, substituting only
        // the charges the plan intends to build. Never mutate the actor.
        // A planned spender's rejections are not the bot's rejected alternatives.
        const decision = evaluateCandidate(bot, target, spender, role,
            { ...policy, classProfile: profile, rejectedAlternatives: undefined }, needed);
        if (!decision) continue;
        const casts = needed - current; // C4 Focus Force/Sonic Focus add one.
        for (const skill of preparation) {
            const cap = Math.max(0, Number(skill.fetchSemantic?.()?.maxCharges ?? skill.fetchPower?.()) || 0);
            if (cap < needed || cap <= current) continue;
            const cost = Math.max(0, Number(skill.fetchConsumedMp?.()) || 0) * casts;
            const totalMp = cost + decision.cost;
            if (totalMp > mp || (mp - totalMp) / maxMp < reserve) continue;
            if (pricesMana(policy, target)) {
                if (context === undefined) context = priceContext(bot, target, { ...policy, classProfile: profile });
                if (manaPrice(context, decision, totalMp, context ? casts * skillHitMs(context, skill) : 0)?.pays === false) continue;
            }
            // Preparation competes with an immediately useful attack. This
            // bounded per-cast preference is policy, not a C4 damage formula.
            const score = decision.score - casts * 25 - cost * 1.5;
            if (ready && ready.score >= score) continue;
            if (!best || score > best.score) best = {
                skill, spender, requiredCharges: needed, castsRemaining: casts,
                totalMp, score, reason: 'prepare_available_attack'
            };
        }
    }
    return best;
}

function selectChargeSkill(bot, role, policy = {}, target = null) {
    return selectChargePlan(bot, role, policy, target)?.skill || null;
}

module.exports = {
    OFFENSIVE_TYPES,
    MAGE_MELEE_FINISH_MAX_HITS,
    evaluate,
    select,
    selectChargeSkill,
    selectChargePlan,
    selectAttackAndChargePlan,
    policyAdjustment,
    priceContext,
    manaPrice,
    restShare,
    restMsPerMp,
    seatedHpPerMs,
    statOf,
    skillHitMs,
    basicAttackDamageEstimate,
    mageMeleeFinishOpportunity
};
