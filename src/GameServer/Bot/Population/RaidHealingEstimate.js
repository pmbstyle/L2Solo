'use strict';

const Rules = invoke('GameServer/Skills/C4SkillRules');
const F = invoke('GameServer/Formulas');
const Capabilities = require('../../Clan/ClanCandidateCapabilities');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');

function spell(skill, maxHp) {
    if (!(skill?.mp > 0) || !Capabilities.healingSkill(skill)) return null;
    const semantic = Rules.resolveCached(skill);
    const burst = semantic.skillType === Rules.HOT ? 0
        : semantic.skillType === Rules.HEAL_PERCENT ? maxHp * Number(semantic.healPower ?? skill.power) / 100
            : F.calcHealAmount(semantic.healPower ?? skill.power);
    const hot = semantic.hot;
    return { skill, semantic, burst: Math.min(maxHp, Math.max(0, burst)),
        heal: Math.max(0, Number(hot?.heal) || 0), ticks: Math.max(0, Math.floor(Number(hot?.count) || 0)),
        interval: Math.max(1, Number(hot?.intervalMs) || 1000),
        family: hot ? semantic.stackFamily || semantic.effect || String(skill.selfId) : null };
}

// Ordering only: one native cast on one recipient, without multiplying an
// aura by nine. Admission below also limits its mana, uptime and recipients.
function efficiency(skill, maxHp) {
    const plan = spell(skill, maxHp);
    return plan ? (plan.burst + plan.heal * plan.ticks) / skill.mp : 0;
}

function canHeal(state, target, semantic) {
    if (semantic.target !== 'ally' && semantic.sourceTarget !== 'clan')
        return ['friendly', 'party'].includes(semantic.target);
    if (state.characterId === target.characterId) return true;
    const clan = Number(state.clanId || state.stats?.clanId || 0);
    return clan > 0 && clan === Number(target.clanId || target.stats?.clanId || 0);
}

function options(fighter, target, seconds, timestamp) {
    const { state, profile } = fighter;
    const sources = Combat.fightSources(profile, timestamp).sources;
    const horizon = Math.max(0, seconds * 1000);
    const mana = Math.max(0, Number(state.vitals?.mp) || 0) + Math.max(0, Number(profile.maxMp) || 0) * seconds / 600;
    const plans = [{ healing: 0, family: null }];
    for (const skill of profile.skills || []) {
        const plan = spell(skill, target.vitals?.maxHp || 0);
        if (!plan || !canHeal(state, target, plan.semantic)) continue;
        const semantic = plan.semantic;
        const hpLimit = semantic.condition?.actorHpPercentAtMost;
        if (hpLimit !== undefined && !(state.vitals?.hp * 100 <= profile.maxHp * hpLimit)) continue;
        const castMs = Math.max(1, F.calcSkillHitTime(semantic.hitTime ?? skill.hitTime ?? 1000,
            skill.spell ? profile.castSpd : profile.atkSpd,
            { magic: skill.spell === true, staticHitTime: semantic.staticHitTime }));
        let reuse = Math.max(0, Number(semantic.reuseTime ?? skill.reuse) || 0);
        if (!semantic.staticReuse) {
            const magic = skill.spell === true;
            reuse *= Combat.statMultiplier(profile, magic ? 'mReuseMul' : 'pReuseMul', timestamp, sources);
            reuse /= Combat.statMultiplier(profile, magic ? 'mReuseDiv' : 'pReuseDiv', timestamp, sources);
            reuse *= 333 / (Number(magic ? profile.castSpd : profile.atkSpd) || 333);
        }
        // Actor.markSkillReuse starts at cast acceptance. Random mastery
        // resets are not guaranteed and cannot fund a conservative forecast.
        reuse = Math.max(0, Math.round(reuse));
        // A conditional rescue cannot assume the caster will repeatedly
        // return to critical HP during this forecast.
        const affordable = Math.min(Math.floor(mana / skill.mp), hpLimit === undefined ? Infinity : 1);
        const castsWithin = gap => horizon < castMs ? 0 : Math.min(affordable, 1 + Math.floor((horizon - castMs) / gap));
        // Direct healing can be repeated; its incidental HoT is then not
        // credited. It still occupies that family for the other provider.
        if (plan.burst > 0) plans.push({ healing: castsWithin(Math.max(castMs, reuse)) * plan.burst, family: plan.family });
        if (!plan.heal || !plan.ticks) continue;
        // Native support waits for the previous HoT to end before recasting.
        // A short fight receives only ticks which land before its end.
        const duration = plan.ticks * plan.interval, gap = Math.max(reuse, duration + castMs);
        const casts = castsWithin(gap);
        const full = Math.min(casts, Math.max(0, 1 + Math.floor((horizon - castMs - duration) / gap)));
        const tail = casts > full ? Math.max(0, Math.min(plan.ticks,
            Math.floor((horizon - castMs - full * gap) / plan.interval))) : 0;
        plans.push({ healing: casts * plan.burst + (full * plan.ticks + tail) * plan.heal, family: plan.family });
    }
    return plans;
}

// Keep the conservative single-spell strategy per healer. Merge equivalent
// native HoT families so a clan's extra supports never cause a Cartesian
// product of spell choices; one best total per occupied-family mask survives.
function capacity(healers, target, seconds, timestamp = Date.now()) {
    if (!(seconds > 0) || !Number.isFinite(seconds) || !(target.vitals?.maxHp > 0)) return 0;
    const choices = healers.map(fighter => options(fighter, target, seconds, timestamp));
    const families = new Map();
    let states = new Map([[0n, 0]]);
    for (const plans of choices) {
        const best = new Map();
        for (const plan of plans) best.set(plan.family, Math.max(best.get(plan.family) || 0, plan.healing));
        const next = new Map();
        for (const [family, healing] of best) {
            if (family && !families.has(family)) families.set(family, 1n << BigInt(families.size));
            const flag = family ? families.get(family) : 0n;
            for (const [used, value] of states) {
                if (used & flag) continue;
                const mask = used | flag;
                next.set(mask, Math.max(next.get(mask) || 0, value + healing));
            }
        }
        states = next;
    }
    return Math.max(0, ...states.values());
}

module.exports = { efficiency, capacity };
