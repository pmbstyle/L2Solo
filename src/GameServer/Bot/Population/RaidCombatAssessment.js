'use strict';

// Shared native raid forecast. Roster ownership and role composition belong to
// the caller; damage, regen, defenses, healing and physical shot supply do not.
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Shots = invoke('GameServer/Inventory/ShotStock');
const F = invoke('GameServer/Formulas');
const HitRules = invoke('GameServer/Combat/HitRules');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Minions = require('../../../../data/Npcs/Minions/c4_raid_bosses.json');
const Supply = require('./RaidSupplyPolicy');
const Healing = require('./RaidHealingEstimate');
const id = s => Number(s?.characterId ?? s?.id);
const guards = new Map();
for (const row of Minions) {
    const key = Number(row.bossId);
    if (!guards.has(key)) guards.set(key, []);
    guards.get(key).push(row);
}

function prepared(members, timestamp) {
    let states = structuredClone(members).map(s => {
        const p = Combat.profileFor(s);
        return { ...s, vitals: { hp: p.maxHp, maxHp: p.maxHp, mp: p.maxMp, maxMp: p.maxMp } };
    });
    const resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    let at = timestamp;
    for (let pass = 0; pass < 6; pass++) {
        const preparation = resolver.prepareRaidParty(states, at);
        states = preparation.memberResults.map(({ state, result }) => ({ ...state, ...result.patch }));
        if (preparation.ready) return { states, at: preparation.nextResolveAt, ready: true };
        const next = preparation.nextResolveAt;
        states = states.map(s => ({ ...s, ...resolver.resolveRest({ ...s, activity: 'resting' }, next - at, next, { party: true }).patch }));
        at = next;
    }
    return { states, at, ready: false };
}

const preparedProfiles = new WeakMap();
function fightersFor(preparation, roleFor) {
    let held = preparedProfiles.get(preparation);
    if (!held || held.roleFor !== roleFor) {
        held = { roleFor, fighters: preparation.states.map(state => ({ state, role: roleFor(state),
            profile: Combat.fightProfile(state, preparation.at) })) };
        preparedProfiles.set(preparation, held);
    }
    return held.fighters;
}

function attack(p, target, charged) {
    const cycle = Combat.normalAttackMs(p);
    const hit = Combat;
    let landed = 0;
    for (let i = 0; i < 20; i++) landed += Number(hit.hitSucceeds(p.accur, target.evasion, () => (i + .5) / 20));
    // The fight's modifier of a normal hit (HitRules.targetModifier: a knife meets no dagger weakness).
    const modifier = HitRules.targetModifier({ weaponKind: p.equipment.weaponKind, race: target.race, undead: target.undead === true },
        stat => Combat.npcVulnerability(target, stat), stat => Combat.statMultiplier(p, stat, Date.now()));
    return { rate: 1000 / cycle, dps: F.calcPhysicalDamage(p.pAtk, 0, target.pDef, 0,
        { soulshot: charged, rng: () => .5 }) * (1 + Math.min(1, p.critical / 1000))
        * (landed / 20) * modifier * 1000 / cycle };
}

// Check native worn slots and compatible heavy body pieces. Grade is not a
// defense stat: the combat profile below owns P.Def, enchants and passives.
function tankArmor(state) {
    const items = require('../../Item/ItemTemplateIndex');
    const data = invoke('GameServer/DataCache');
    const slots = new Set();
    for (const row of Object.values(state.inventory || {})) {
        if (!(row.amount > 0) || !(row.equipped || row.equippedCount > 0)) continue;
        const item = items.find(data.items, row.selfId);
        for (const slot of Gear.equippedSlotsFor(row, item?.etc?.slot)) {
            if (slot === 8 && item?.template?.kind === 'Armor.Shield') slots.add(8);
            if ([10, 11, 15].includes(slot) && item?.template?.kind === 'Armor.Chain') slots.add(slot);
        }
    }
    return [...(!slots.has(8) ? ['raid_tank_shield'] : []),
        ...(!(slots.has(15) || slots.has(10) && slots.has(11)) ? ['raid_tank_body'] : [])];
}

// The offense calculation shared by target screening and full admission.
// It consumes prepared native profiles; no new buffs, gear or shot stock are invented.
function guardProfiles(npc) {
    const data = invoke('GameServer/DataCache'), items = require('../../Item/ItemTemplateIndex');
    return (guards.get(Number(npc.selfId)) || []).map(r => ({
        profile: Combat.npcCombatStats(items.find(data.npcs, r.minionId)), count: Number(r.max || r.min || 0) }));
}

function damageEstimate(damage, npc, { offenseFor = null, maxFightSeconds = 720 } = {}) {
    const boss = Combat.npcCombatStats(npc);
    if (!boss) return null;
    const regen = Number(npc.vitals?.revHp || 0) / 3;
    const adds = guardProfiles(npc);
    const evaluate = horizon => {
        const hit = (fighter, target) => offenseFor ? offenseFor(fighter, target, horizon)
            : attack(fighter.profile, target, fighter.charged !== false);
        const attacks = damage.map(f => ({ fighter: f, ...hit(f, boss) }));
        if (offenseFor) for (const action of attacks) {
            action.reserveRate = action.usesShots !== false ? action.reserveRate ?? action.rate : 0;
            for (const guard of adds) if (guard.profile) {
                const guardAction = hit(action.fighter, guard.profile);
                if (guardAction.usesShots !== false) action.reserveRate = Math.max(action.reserveRate, guardAction.reserveRate ?? guardAction.rate);
            }
            action.usesShots = action.reserveRate > 0;
        }
        const grossDps = attacks.reduce((sum, a) => sum + a.dps * (a.fighter.contribution ?? 1), 0) * .85;
        let addSeconds = 0, seconds = Infinity;
        if (grossDps > regen) {
            addSeconds = adds.reduce((sum, a) => {
                if (!a.profile) return sum;
                const dps = damage.reduce((value, f) => value + hit(f, a.profile).dps * (f.contribution ?? 1), 0) * .65;
                return sum + a.profile.maxHp * a.count / Math.max(1, dps);
            }, 0);
            seconds = boss.maxHp / (grossDps - regen) + addSeconds;
            for (let i = 0; i < 4; i++) seconds = boss.maxHp / (grossDps - regen) + addSeconds * Math.max(1, Math.ceil(seconds / 300));
        }
        return { attacks, grossDps, regen, adds, addSeconds, seconds, complete: adds.every(a => !!a.profile) };
    };
    // The physical-only path retains its exact previous result. A caster's
    // finite MP makes DPS depend on duration. Find an affordable horizon using
    // at most seven probes and six refinements of cached native attack facts.
    if (!offenseFor) return evaluate(maxFightSeconds);
    let low = 0, high = Math.max(.001, maxFightSeconds), result;
    const fits = (value, horizon) => value.grossDps > regen * 1.5 && value.seconds <= horizon;
    for (let part = 64; part >= 1; part /= 2) {
        const horizon = high / part;
        result = evaluate(horizon);
        if (fits(result, horizon)) { high = horizon; break; }
        low = horizon;
    }
    if (!fits(result, high)) return result;
    for (let pass = 0; pass < 6; pass++) {
        const mid = (low + high) / 2, candidate = evaluate(mid);
        if (fits(candidate, mid)) { high = mid; result = candidate; }
        else low = mid;
    }
    return { ...result, seconds: high };
}

function equipmentFailures(members, roleFor = Roles.inferRole, readinessCache = null) {
    const failures = new Set();
    for (const s of members) {
        const key = id(s);
        let g = readinessCache?.get(key);
        if (!g) { g = Gear.combatReadiness(s); readinessCache?.set(key, g); }
        if (!g.hasWeapon || g.armorCount < 2) failures.add('raid_equipment');
        if (roleFor(s) === 'tank') tankArmor(s).forEach(reason => failures.add(reason));
    }
    return [...failures];
}

function assessment(members, spot, { timestamp = Date.now(), maxFightSeconds = 720, reserve = 1.3,
    preparation = null, fundSupplies = false, roleFor = Roles.inferRole, compositionReady = true,
    levelAllowed = () => true, readinessCache = null, offenseEstimate = null, coreMemberIds = null } = {}) {
    const reasons = [], unchecked = [];
    const fail = reason => { if (!reasons.includes(reason)) reasons.push(reason); };
    const result = details => ({ ready: reasons.length === 0, reason: reasons[0] || 'raid_ready',
        reasons, unchecked, ...details });
    if (!compositionReady) { fail('raid_composition'); unchecked.push('equipment', 'combat'); return result(); }
    const level = Number(spot.avgLevel);
    if (members.some(s => !levelAllowed(s, level))) { fail('raid_level'); unchecked.push('equipment', 'combat'); return result(); }
    const data = invoke('GameServer/DataCache');
    const item = require('../../Item/ItemTemplateIndex');
    const core = member => !coreMemberIds || coreMemberIds.includes(id(member));
    equipmentFailures(members.filter(core), roleFor, readinessCache).forEach(fail);
    // Unsafe/missing equipment has no meaningful prepared combat forecast.
    // Collect independent gear failures, but never spend a second simulation.
    if (reasons.length) { unchecked.push('combat'); return result(); }
    const prep = preparation || prepared(members, timestamp);
    if (!prep.ready) { fail('raid_preparation_mana'); unchecked.push('combat'); return result(); }
    const npc = item.find(data.npcs, spot.raidBossTemplateId);
    const boss = Combat.npcCombatStats(npc);
    if (!boss) { fail('raid_template_missing'); unchecked.push('combat'); return result(); }
    const fighters = fightersFor(prep, roleFor);
    const coreFighters = fighters.filter(f => core(f.state));
    // Reuse the single set of prepared profiles for independent failures.
    const estimate = offenseEstimate || damageEstimate(fighters.filter(f => f.role !== 'healer'), npc);
    const { attacks, grossDps, regen, adds, addSeconds, seconds } = estimate;
    if (!Number.isFinite(grossDps) || !Number.isFinite(regen) || fighters.some(f =>
        ![f.profile.pDef, f.profile.maxHp].every(v => Number.isFinite(v) && v > 0))) {
        fail('raid_profile_invalid'); unchecked.push('combat'); return result();
    }
    if (grossDps <= regen * 1.5) fail('raid_damage_below_regeneration');
    const tank = coreFighters.find(f => f.role === 'tank');
    const incoming = target => F.calcPhysicalDamage(target.pAtk, 0, tank.profile.pDef, 0, { rng: () => .5 })
        * 1000 / F.calcMeleeAtkTime(target.atkSpd);
    const bossIncoming = incoming(boss);
    const addIncoming = adds.reduce((sum, a) => sum + (a.profile ? incoming(a.profile) * a.count : 0), 0);
    const tankRequiredHp = (bossIncoming + addIncoming) * 12;
    if (tank.profile.maxHp < tankRequiredHp) fail('raid_tank_survival');
    const offense = invoke('GameServer/Npc/NpcSkills').combatSkillsFor({ fetchSelfId: () => npc.selfId,
        fetchLevel: () => level, fetchMaxHp: () => boss.maxHp, fetchHp: () => boss.maxHp })
        .filter(s => [Rules.DAMAGE, Rules.DAMAGE_EFFECT, Rules.DRAIN].includes(s.fetchSkillType()) && s.fetchPower() > 0);
    let skillPressure = 0;
    for (const skill of offense) {
        const semantic = skill.fetchSemantic();
        const area = ['aura', 'area', 'front_area'].includes(semantic.sourceTarget);
        const targets = area ? coreFighters : [tank];
        let total = 0;
        for (const target of targets) {
            const burst = skill.fetchSpell() ? F.calcMagicDamage(boss.mAtk, skill.fetchPower(), target.profile.mDef)
                : F.calcPhysicalDamage(boss.pAtk, 0, target.profile.pDef, skill.fetchPower(), { rng: () => .5 });
            if (burst * 1.3 > target.profile.maxHp) fail('raid_skill_burst_survival');
            total += burst;
        }
        skillPressure += total / Math.max(3, skill.fetchReuseTime() / 1000, skill.fetchHitTime() / 1000 + 1);
    }
    const defense = { tankId: id(tank.state), pDef: tank.profile.pDef, maxHp: tank.profile.maxHp,
        requiredHp: tankRequiredHp, bossDps: bossIncoming, guardDps: addIncoming };
    // A nonpositive net DPS has no finite kill time. Do not manufacture a
    // negative/Infinity duration or claim that mana/stock passed that fight.
    if (!(grossDps > regen)) {
        unchecked.push('duration', 'healing', 'supplies');
        return result({ grossDps, regen, defense });
    }
    if (!Number.isFinite(seconds)) {
        fail('raid_fight_too_long'); unchecked.push('healing', 'supplies');
        return result({ grossDps, regen, defense });
    }
    if (seconds > maxFightSeconds) {
        fail('raid_fight_too_long'); unchecked.push('healing', 'supplies');
        return result({ seconds, grossDps, regen, defense });
    }
    const shotPlans = attacks.filter(a => a.fighter.charged !== false && a.usesShots !== false).map(a => {
        const f = a.fighter, plan = Shots.planForState(f.state);
        const stock = Number(f.state.inventory?.[plan.selfId]?.amount || 0) + Shots.beginnerAmount(f.state, plan);
        const required = Math.ceil((a.reserveRate ?? a.rate) * seconds * plan.perAction * reserve);
        return { id: id(f.state), selfId: plan.selfId, stock, required, perAction: plan.perAction };
    });
    if (shotPlans.some(s => !s.perAction || !fundSupplies && s.stock < s.required)) fail('raid_shot_reserve');
    const healing = Healing.capacity(coreFighters.filter(f => f.role === 'healer'),
        { ...tank.state, vitals: { ...tank.state.vitals, maxHp: tank.profile.maxHp } }, seconds, prep.at);
    // Preserve the native 25% healing margin and the same respawning guards.
    const healingRequired = (Math.max(bossIncoming, skillPressure) * seconds
        + addIncoming * addSeconds * Math.max(1, Math.ceil(seconds / 300))) * 1.25;
    if (healing < healingRequired) fail('raid_healing_mana');
    const supplies = fundSupplies ? Supply.supplies(members, shotPlans, timestamp) : null;
    if (supplies?.some(s => s.available < s.missing)) fail('raid_supplies_unavailable');
    if (supplies?.some(s => s.missing > 0 && s.available >= s.missing && s.cash < (s.reserveCost ?? s.cost)))
        fail('raid_consumables_funds');
    return result({ seconds, grossDps, regen, shotPlans, healing, healingRequired, defense,
        ...(supplies ? { supplies } : {}),
        ...(!reasons.length ? { kits: members.map(s => [id(s), Combat.kitEvents(s).join(':')]) } : {}) });
}

module.exports = { prepared, fightersFor, tankArmor, equipmentFailures, attack, guardProfiles, damageEstimate, assessment };
