'use strict';

// A cold monster's side of a fight (combat core, T106): its skills and the
// state of its fight, its weapon hit time, one rolled action on a fighter
// (coldMobAction: BackgroundResolver's solo, party and raid fights) and the
// expected damage of its actions (actionMix: the solo gate
// BotTargetMatchup.soloSurvival and the offline hunt model), both over the
// same choice (NpcCombatChoice), cast times and hit rules (HitRules), so the
// gate judges the fight the bot meets.
const Formulas = invoke('GameServer/Formulas');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const NpcCombatChoice = invoke('GameServer/Npc/NpcCombatChoice');
const HitRules = invoke('GameServer/Combat/HitRules');
const CombatantView = invoke('GameServer/Combat/CombatantView');
const Pull = invoke('GameServer/Bot/AI/BotPullEstimate');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Diagnostics = require('../Economy/EconomyDiagnostics');

// The cold adapter of HitRules.targetModifier for a monster's hit on a
// fighter ({ profile }: a fighter or a bare holder): the fighter's weaknesses
// at the hit's time. A bot is no monster race and never undead: no bonus term.
function mobHitModifier(mob, target, at, { magic = false, skill = false, trait = '' } = {}) {
    return HitRules.targetModifier({ magic, skill, trait, weaponKind: String(mob?.weaponKind || '') },
        stat => Profile.statMultiplier(target.profile, stat, at, Profile.hitSources(target, at)), () => 1);
}

// The cold monster's fight beside its HP: MP, its skills' reuse, the self
// buffs it holds, its last debuff, its AI type (NpcCombatChoice).
const mobSkillLists = new Map();
function coldMobSkills(mob) {
    const id = Number(mob?.selfId) || 0;
    if (!mobSkillLists.has(id)) mobSkillLists.set(id, id ? NpcSkills.combatSkillsFor({ fetchSelfId: () => id }) : []);
    return mobSkillLists.get(id);
}
// saved: coldMobFightSave of the fight's last slice (its times relative to
// that slice's end, as the encounter's other timers). held: per impairment,
// characterId -> the time this monster's control on that fighter ends.
const MOB_IMPAIRMENTS = { hard_control: 'disabled', sleep: 'disabled', root: 'rooted', mute: 'silenced' };
// heldUntil: the time a bot's stun on this monster ends; dots: the bot's
// damage over time on it (landOnMob).
function coldMobFight(mob, saved = null) {
    const skills = coldMobSkills(mob);
    return { skills, mp: saved ? Number(saved.mp ?? mob.maxMp) || 0 : Number(mob.maxMp) || 0,
        heldUntil: Number(saved?.heldFor) || 0, dots: (saved?.dots || []).map((dot) => ({ ...dot })),
        cooldowns: { ...(saved?.cooldowns || {}) }, buffs: new Set(saved?.buffs || []),
        lastDebuffAt: Number.isFinite(saved?.debuffAgo) ? -saved.debuffAgo : -Infinity,
        held: { disabled: { ...(saved?.held?.disabled || {}) }, rooted: { ...(saved?.held?.rooted || {}) },
            silenced: { ...(saved?.held?.silenced || {}) } },
        aiType: skills.length ? NpcCombatChoice.aiTypeFor(mob.aiType, skills, mob.atkRadius) : 'fighter' };
}
function coldMobFightSave(fight, time) {
    const dots = (fight.dots || []).map((dot) => ({ ...dot, next: dot.next - time }));
    const heldFor = Math.max(0, (Number(fight.heldUntil) || 0) - time);
    if (!fight.skills.length && !dots.length && !heldFor) return null;
    const after = (map) => Object.fromEntries(Object.entries(map).filter(([, until]) => until > time)
        .map(([key, until]) => [key, until - time]));
    const effects = { ...(dots.length ? { dots } : {}), ...(heldFor ? { heldFor } : {}) };
    if (!fight.skills.length) return effects;
    return { mp: fight.mp, cooldowns: after(fight.cooldowns), buffs: [...fight.buffs],
        held: { disabled: after(fight.held.disabled), rooted: after(fight.held.rooted), silenced: after(fight.held.silenced) },
        debuffAgo: Number.isFinite(fight.lastDebuffAt) ? time - fight.lastDebuffAt : null, ...effects };
}

// Damage over time on a cold fighter or monster (hot EffectTicker.applyDot):
// holder.dots, per effect key its next tick (fight time), ticks left, damage
// and interval. The same effect landing again starts over (the hot ticker
// clears its timer); its first tick comes one interval after it lands.
function addDot(holder, key, dot, landedAt) {
    const count = Math.max(0, Number(dot.count) || 0), damage = Math.max(0, Number(dot.damage) || 0);
    if (!count || !damage) return;
    const intervalMs = Math.max(1, Number(dot.intervalMs) || 3000);
    holder.dots = (holder.dots || []).filter((held) => held.key !== String(key || ''));
    holder.dots.push({ key: String(key || ''), next: landedAt + intervalMs, left: count, damage, intervalMs });
}
// The damage a holder's dots deal up to time (their ticks at or before it); finished ones leave.
function dotDamage(holder, time) {
    if (!holder.dots?.length) return 0;
    let damage = 0;
    for (const dot of holder.dots) {
        while (dot.left > 0 && dot.next <= time) {
            damage += dot.damage;
            dot.left -= 1;
            dot.next += dot.intervalMs;
        }
    }
    holder.dots = holder.dots.filter((dot) => dot.left > 0);
    return damage;
}

// An effect's land chance in percent on a cold monster (HitRules.effectLandChance
// against its trait resist, ColdCombatProfile.npcTraitResist: a raid boss's
// passive 4045 cuts sleep, root, stun and paralysis to a tenth). caster
// { level, mAtk, soulshot, spiritshot, blessedSpiritshot }.
function controlLandChance(mob, semantic, magic, caster) {
    return HitRules.effectLandChance(semantic, magic, caster, { level: mob.level, mDef: mob.mDef },
        Profile.npcTraitResist(mob, semantic.effectTrait || semantic.trait));
}

// A bot's effect on the cold monster: the effect part of a damage+effect or a
// drain skill (Stun Shot, Shield Stun, Ice Dagger's bleed; hot
// C4SkillEffects.execute), rolled by controlLandChance. A stun or a paralysis
// holds the monster (fight.heldUntil: it acts again only after), a poison or
// a bleed deals its damage over time (fight.dots, dotDamage). Not modelled: a
// sleep (the fighter's next hit wakes it), fear and stat debuffs (the
// monster's numbers are fixed for the fight). skill: the cold skill record.
// Returns whether an effect landed.
function landOnMob(mob, fight, skill, caster, time, rng) {
    const semantic = C4SkillRules.resolveCached(skill);
    if (!semantic.effect || semantic.effectType !== 'debuff') return false;
    const durationMs = Number(semantic.durationMs ?? skill.buffTime) || 0;
    const hold = durationMs > 0 && NpcCombatChoice.category({ fetchSemantic: () => semantic }) === 'hard_control';
    const dot = HitRules.dotOf(semantic, skill.level, skill.power);
    if (!hold && !dot) return false;
    if (!(controlLandChance(mob, semantic, skill.spell === true, caster) >= rng() * 100)) return false;
    if (hold) fight.heldUntil = Math.max(Number(fight.heldUntil) || 0, time + durationMs);
    if (dot) addDot(fight, semantic.effect, dot, time);
    return true;
}

// A self buff's stats on the cold monster, as the hot one gains them
// (EffectStats); positional stats are not modelled. The monster object is
// the fight's own (npcForSpot, pullView or the saved encounter), so a buff
// cast in one slice stays on it in the next.
const MOB_BUFF_MULS = { pAtkMul: 'pAtk', pDefMul: 'pDef', mAtkMul: 'mAtk', mDefMul: 'mDef', pAtkSpdMul: 'atkSpd',
    castSpdMul: 'castSpd', mCritRateMul: 'mCritRate' };
const MOB_BUFF_ADDS = { pEvasionRateAdd: 'evasion', pAccuracyCombatAdd: 'accur', reflectDam: 'reflectDam' };
function buffColdMob(mob, semantic) {
    for (const [stat, value] of Object.entries(semantic.stats || {})) {
        if (MOB_BUFF_MULS[stat]) mob[MOB_BUFF_MULS[stat]] = Number(mob[MOB_BUFF_MULS[stat]] || 0) * Number(value);
        else if (MOB_BUFF_ADDS[stat]) mob[MOB_BUFF_ADDS[stat]] = Number(mob[MOB_BUFF_ADDS[stat]] || 0) + Number(value);
    }
    Profile.forgetViews(mob);
}

// The time between a cold monster's weapon hits, as the hot Npc's (a bow
// draws longer).
function mobAttackMs(mob) {
    return Math.max(250, Formulas.normalAttackMs(mob.atkSpd, { bow: mob.weaponKind === 'Weapon.Bow' }));
}

// A monster skill's cast as the hot Npc's: its C4 hit time at the
// monster's cast (spell) or attack speed, 1000 / 600 ms without one.
function mobSkillCastMs(mob, skill) {
    const spell = skill.fetchSpell?.() === true;
    return Math.max(250, Formulas.calcSkillHitTime(Number(skill.fetchHitTime?.()) || (spell ? 1000 : 600),
        spell ? mob.castSpd : mob.atkSpd, { magic: spell }));
}

// A damage skill's hit context on a fighter: a spell meets its element's
// weakness, a physical skill the monster's weapon weakness.
function skillContext(mob, skill, target, at) {
    const semantic = skill.fetchSemantic?.() || {};
    if (skill.fetchSpell?.() === true) {
        return { power: skill.fetchPower(), modifier: mobHitModifier(mob, target, at, { magic: true, trait: semantic.trait }) };
    }
    return { power: skill.fetchPower(), blow: semantic.skillType === C4SkillRules.BLOW,
        bow: mob.weaponKind === 'Weapon.Bow', modifier: mobHitModifier(mob, target, at, { skill: true, trait: semantic.trait }) };
}

// The share of a monster spell that passes the level-fail roll on a fighter
// (HitRules.rollsMagicLevel: a nuke, a drain), 1 for any other skill.
function spellLands(mob, skill, profile) {
    const semantic = skill.fetchSemantic?.() || {};
    return HitRules.rollsMagicLevel(semantic, skill.fetchSpell?.() === true)
        ? HitRules.magicLevelChance(semantic, mob.level, profile.level) / 100 : 1;
}

// The mean of coldMobAction on a fighter (target: { profile }, a fighter or
// a bare profile holder) from a fresh fight: per action its damage (mean,
// second moment) and length, per second the damage. A damage skill is cast
// with its rolled chance (NpcCombatChoice.chance, in its list order), at
// most once per reuse; the weapon hit otherwise. Self buffs and controls
// are left out (a control's damage is none, its hold on the fighter is not
// in the mean): the mean errs high. A skill the fighter's numbers cannot
// meet (no M.Def for a spell) is left out too.
function actionMix(mob, target, at = 0, fight = coldMobFight(mob)) {
    const profile = target.profile;
    const attacker = Profile.attackerView(mob);
    const defender = Profile.defenderView(profile, at, target);
    const bow = mob.weaponKind === 'Weapon.Bow';
    const meleeMs = mobAttackMs(mob);
    const hitChance = Profile.expectedHitChance(mob.accur, profile.evasion);
    const modifier = mobHitModifier(mob, target, at);
    const critical = Math.min(1, Math.max(0, attacker.critRate) / 1000);
    const plain = HitRules.expectedMelee(CombatantView.view({ ...attacker, critRate: 0 }), defender, { bow, modifier });
    const crit = HitRules.expectedMelee(CombatantView.view({ ...attacker, critRate: 1000 }), defender, { bow, modifier });
    const spread = 1 + Math.pow(Number(attacker.pAtkRnd) || 0, 2) / 3 / 10000;
    let left = 1, mean = 0, square = 0, ms = 0, spellDamage = 0;
    const pack = Pull.packOf(mob);
    for (const skill of fight.skills) {
        if (skill.fetchTargetKind?.() !== 'enemy' || NpcCombatChoice.category(skill) !== 'damage') continue;
        const spell = skill.fetchSpell?.() === true;
        if (spell && !(Number(profile.mDef) > 0)) continue;
        const castMs = mobSkillCastMs(mob, skill);
        const share = left * Math.min(NpcCombatChoice.chance(skill, 'damage', fight.aiType) / 100,
            (meleeMs + castMs) / NpcCombatChoice.reuseMs(skill));
        const context = skillContext(mob, skill, target, at);
        const each = pack * (spell ? HitRules.expectedMagicSkill : HitRules.expectedPhysicalSkill)(attacker, defender, context)
            * spellLands(mob, skill, profile);
        mean += share * each; square += share * each * each; ms += share * castMs; left -= share;
        if (spell) spellDamage += share * each;
    }
    mean += left * hitChance * ((1 - critical) * plain + critical * crit);
    square += left * hitChance * ((1 - critical) * plain * plain + critical * crit * crit) * spread;
    ms += left * meleeMs;
    return { perAction: mean, squarePerAction: square, actionMs: ms, perSecond: mean / ms * 1000,
        actionsPerSecond: 1000 / ms, spellShare: mean > 0 ? spellDamage / mean : 0 };
}

// The monster's expected damage per second on a profile (actionMix).
function incomingPerSecond(mob, profile, at = 0) {
    return actionMix(mob, { profile }, at).perSecond;
}

// A monster that fights in melee only: a short weapon reach and no ranged
// spell (its AI type by NpcCombatChoice.aiTypeFor reads both).
function meleeOnly(mob) {
    if (!(Number(mob?.atkRadius) < 200)) return false;
    return coldMobFight(mob).aiType === 'fighter';
}

// One action of a cold monster on a fighter, as the hot Npc's: a self buff
// it lacks, a control or damage skill by its rolled chances
// (NpcCombatChoice), else its weapon hit (HitRules). A control that lands
// holds the fighter (fight.held; a stun or sleep also its readyAt): a sleep
// until the monster's next blow wakes it. A pull's skills strike as its
// weapon hits do (BotPullEstimate.pullView: x its pack). pAtk: a raid's boss
// share. Returns { damage, delayMs } (delayMs: to the monster's next action).
function coldMobAction(mob, fight, target, { time, at, rng, mobHp = mob.maxHp, pAtk = null }) {
    const profile = target.profile;
    const id = target.state?.characterId;
    const meleeMs = mobAttackMs(mob);
    const attacker = pAtk === null || pAtk === mob.pAtk ? Profile.attackerView(mob) : CombatantView.view({ ...Profile.attackerView(mob), pAtk });
    const defender = Profile.defenderView(profile, at, target);
    const bow = mob.weaponKind === 'Weapon.Bow';
    const choice = fight.skills.length ? NpcCombatChoice.select({
        skills: fight.skills,
        usable: (skill) => fight.mp >= skill.fetchConsumedMp() && !(fight.cooldowns[skill.fetchSelfId()] > time),
        buffNeeded: (skill) => !fight.buffs.has(skill.fetchSemantic?.()?.effect)
            && (skill.fetchSkillType?.() !== 'hot' || mobHp < mob.maxHp),
        impairments: { disabled: fight.held.disabled[id] > time, rooted: fight.held.rooted[id] > time,
            silenced: fight.held.silenced[id] > time },
        aiType: fight.aiType,
        // A hot player carries no AI type: the hot Npc reads 'fighter'.
        targetAiType: 'fighter',
        debuffReady: time - fight.lastDebuffAt >= NpcCombatChoice.DEBUFF_GAP_MS,
        rng
    }) : null;
    if (!choice) {
        const damage = Profile.hitSucceeds(mob.accur, profile.evasion, rng)
            ? HitRules.melee(attacker, defender, { bow, spreadRng: rng, modifier: mobHitModifier(mob, target, at) }, rng).damage
            : 0;
        return { damage, delayMs: meleeMs };
    }
    const skill = choice.skill, semantic = skill.fetchSemantic?.() || {};
    const spell = skill.fetchSpell?.() === true;
    if (Diagnostics.active()) Diagnostics.count('cold_mob', 'skill', choice.category);
    fight.mp -= skill.fetchConsumedMp();
    fight.cooldowns[skill.fetchSelfId()] = time + NpcCombatChoice.reuseMs(skill);
    const castMs = mobSkillCastMs(mob, skill);
    let damage = 0;
    if (choice.category === 'buff') {
        fight.buffs.add(semantic.effect);
        buffColdMob(mob, semantic);
    } else if (choice.category === 'damage') {
        // A nuke or a drain first rolls the level-fail roll (hot C4SkillEffects.execute).
        if (!spell || !HitRules.rollsMagicLevel(semantic, true) || HitRules.magicLevelLands(semantic, mob.level, profile.level, rng)) {
            const context = skillContext(mob, skill, target, at);
            damage = Pull.packOf(mob) * (spell ? HitRules.magicSkill : HitRules.physicalSkill)(attacker, defender, context, rng).damage;
        }
    } else {
        if (choice.category === 'debuff') fight.lastDebuffAt = time;
        // Debuffs, root and mute take the monster's action. Of their effects
        // a cold fighter meets the hold (until they end) and a poison or a
        // bleed (its damage over time, dotDamage); a stat debuff is not
        // modelled (the fighter's profile is fixed for the fight).
        const durationMs = Number(semantic.durationMs) || 0;
        const impairment = MOB_IMPAIRMENTS[choice.category];
        // A pet takes no damage over time here (its HP is the summon's, ticked by no fight loop).
        const dot = target.vitals ? HitRules.dotOf(semantic, skill.fetchLevel?.(), skill.fetchPower?.()) : null;
        if ((impairment && durationMs > 0) || dot) {
            const family = HitRules.resistStats(semantic.effectTrait || semantic.trait);
            const sources = Profile.hitSources(target, at);
            const resist = HitRules.traitResistModifier(Profile.statAdd(profile, family.resist, at, sources),
                Profile.statMultiplier(profile, family.vulnerability, at, sources));
            const chance = HitRules.effectLandChance(semantic, spell, { level: mob.level, mAtk: mob.mAtk },
                { level: profile.level, mDef: profile.mDef }, resist);
            if (chance >= rng() * 100) {
                if (Diagnostics.active()) Diagnostics.count('cold_mob', 'landed', choice.category);
                if (impairment && durationMs > 0) {
                    // A sleep ends at the monster's next weapon hit.
                    const until = time + castMs + (choice.category === 'sleep' ? Math.min(durationMs, meleeMs) : durationMs);
                    fight.held[impairment][id] = until;
                    if (impairment === 'disabled') target.readyAt = Math.max(Number(target.readyAt) || 0, until);
                }
                if (dot) addDot(target, semantic.effect, dot, time + castMs);
            }
        }
    }
    // spell: the damage met M.Def (the hunt tables split it, HuntCycle).
    return { damage, delayMs: castMs, spell: spell && choice.category === 'damage' };
}

module.exports = { mobHitModifier, coldMobFight, coldMobFightSave, buffColdMob, mobAttackMs,
    mobSkillCastMs, coldMobAction, actionMix, incomingPerSecond, meleeOnly, addDot, dotDamage, landOnMob, controlLandChance };
