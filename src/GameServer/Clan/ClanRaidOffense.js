'use strict';

const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Shots = invoke('GameServer/Inventory/ShotStock');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Formulas = invoke('GameServer/Formulas');

// A bounded analytical forecast, not a second combat simulation. The native
// chooser selects a learned nuke once for this immutable fighter/target/shot
// combination. Its MP and reuse cap the casts; gaps use ordinary weapon hits.
const plans = new WeakMap();
const isMage = fighter => Roles.inferRole(fighter.state) === 'mage';
function expectedDamage(native, fighter, selected, target, shot, at) {
    let damage = 0;
    for (let i = 0; i < 20; i++) {
        let draw = 0;
        const rng = () => ((i + .5 + 7 * draw++) % 20) / 20;
        damage += native.attackDamage(fighter, selected, target, rng, { vsMob: true, at, shot });
    }
    return damage / 20;
}

function planFor(fighter, target, at, charged = fighter.charged !== false) {
    let targets = plans.get(fighter);
    if (!targets) { targets = new WeakMap(); plans.set(fighter, targets); }
    let variants = targets.get(target);
    if (!variants) { variants = new Map(); targets.set(target, variants); }
    if (variants.has(charged)) return variants.get(charged);
    const native = invoke('GameServer/Bot/Population/BackgroundResolver').combat;
    const { state, profile } = fighter;
    const mp = Math.max(0, Number(state.vitals?.mp ?? profile.maxMp) || 0);
    const attacker = { state, profile, vitals: { hp: profile.maxHp, mp }, charges: state.stats?.coldCombat?.charges || 0 };
    const shotPlan = Shots.planForState(state);
    const supply = charged ? { soulshot: shotPlan.kind === 'soulshot', spiritshot: shotPlan.kind !== 'soulshot',
        blessedSpiritshot: shotPlan.kind === 'blessedSpiritshot' } : null;
    const meleeShot = Combat.actionShot(supply);
    const meleeDps = expectedDamage(native, attacker, null, target, meleeShot, at) * 1000 / Combat.normalAttackMs(profile);
    const mob = target.boss ? { ...target, raidBossMaxHp: target.maxHp } : target;
    const cooldowns = { ...(state.stats?.coldCombat?.cooldowns || {}) };
    let selected = null, itemCasts = Infinity;
    for (let attempt = 0; attempt < 4; attempt++) {
        selected = native.chooseSkill(profile, profile.maxHp, mp, cooldowns, at,
            attacker.charges, () => .5, { mob, mobHp: target.maxHp, party: true });
        if (!selected?.magic || selected.skill?.spell !== true) break;
        const semantic = Rules.resolveCached(selected.skill);
        const itemId = Number(semantic.itemConsumeId ?? selected.skill.itemId);
        const itemCount = Number(semantic.itemConsumeCount ?? selected.skill.itemCount);
        itemCasts = itemId > 0 && itemCount > 0 ? Math.floor(Object.values(state.inventory || {})
            .filter(row => Number(row.selfId) === itemId).reduce((sum,row) => sum + Math.max(0,Number(row.amount)||0),0) / itemCount) : Infinity;
        // The cold chooser has no inventory actor. Do not invent bones or a
        // core healer's extra HP budget for a spell the hot executor would deny.
        if (!(Number(selected.skill.hp) > 0) && itemCasts > 0) break;
        cooldowns[selected.skill.selfId] = Infinity;
        selected = null;
    }
    let plan = { meleeDps, mp, selected: null, usesShots: !!meleeShot };
    if (selected?.magic && selected.skill?.spell === true) {
        const semantic = Rules.resolveCached(selected.skill);
        const shot = Combat.actionShot(supply, selected.skill);
        const castMs = Math.max(1,Formulas.calcSkillHitTime(semantic.hitTime ?? selected.skill.hitTime ?? 1000, profile.castSpd,
            { magic: true, spiritshot: shot?.spiritshot === true, staticHitTime: !!semantic.staticHitTime }));
        // Actor.markSkillReuse starts reuse at cast acceptance. Mastery resets
        // are random and cannot pay for this conservative admission forecast.
        let reuse = Math.max(0, Number(semantic.reuseTime ?? selected.skill.reuse) || 0);
        if (!semantic.staticReuse) reuse *= Combat.statMultiplier(profile,'mReuseMul',at)
            / Combat.statMultiplier(profile,'mReuseDiv',at) * 333 / Math.max(1, Number(profile.castSpd) || 333);
        plan = { ...plan, selected, castMs, cycleMs: Math.max(castMs, Math.round(reuse)),
            coldCycleMs: Math.max(castMs, Math.round(reuse), Number(selected.skill.reuse) || 0), itemCasts,
            cost: Math.max(0, Number(selected.skill.mp) || 0),
            hit: expectedDamage(native, attacker, selected, target, shot, at), usesShots: !!shot };
    }
    variants.set(charged, plan);
    return plan;
}

function attack(fighter, target, seconds, at, charged = fighter.charged !== false, coldReuse = false) {
    const plan = planFor(fighter, target, at, charged), horizon = Math.max(.001, seconds), ms = horizon * 1000;
    if (!plan.selected) return { dps: plan.meleeDps, rate: plan.usesShots ? 1000 / Combat.normalAttackMs(fighter.profile) : 0,
        usesShots: plan.usesShots, magic: true };
    const affordable = Math.min(plan.itemCasts, plan.cost > 0 ? Math.floor(plan.mp / plan.cost) : Infinity);
    const count = cycle => ms < plan.castMs ? 0 : Math.min(affordable, 1 + Math.floor((ms - plan.castMs) / cycle));
    // Gate on the slower executor while cold stores raw reuse; reserve ammo
    // for hot's faster casts so the same proof remains valid across handoffs.
    const casts = count(coldReuse ? plan.coldCycleMs : plan.cycleMs);
    const meleeMs = Math.max(0, ms - casts * plan.castMs);
    return { dps: (casts * plan.hit + meleeMs * plan.meleeDps / 1000) / horizon,
        rate: plan.usesShots ? casts / horizon : 0, reserveRate: plan.usesShots ? Math.max(casts, count(plan.cycleMs)) / horizon : 0,
        usesShots: plan.usesShots, magic: true,
        skillId: plan.selected.skill.selfId, casts, castMs: plan.castMs, cost: plan.cost };
}

function forRaid(fighters, timestamp, physicalAttack, { coldReuse = false } = {}) {
    if (!fighters.some(isMage)) return null;
    const physical = new WeakMap();
    return (fighter, target, seconds) => {
        if (isMage(fighter)) return attack(fighter, target, seconds, timestamp, fighter.charged !== false, coldReuse);
        let targets = physical.get(fighter);
        if (!targets) { targets = new WeakMap(); physical.set(fighter, targets); }
        let variants = targets.get(target);
        if (!variants) { variants = new Map(); targets.set(target, variants); }
        const charged = fighter.charged !== false;
        if (!variants.has(charged)) variants.set(charged, physicalAttack(fighter.profile, target, charged));
        return variants.get(charged);
    };
}

module.exports = { attack, forRaid, isMage };
