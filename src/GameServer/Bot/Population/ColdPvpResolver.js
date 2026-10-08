// Bounded, deterministic skirmishes. No actors, SQL, timers or population scans.
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const { combat } = invoke('GameServer/Bot/Population/BackgroundResolver');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Aid = require('../../Social/OpponentAidPolicy');
const Config = require('./PopulationConfig');
const Aggression = require('../../Social/PvpAggression');
const Visible = require('../../Social/VisibleStrength');
const Tendency = require('../AI/TendencyRoll');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const DeathExperience = invoke('GameServer/Progression/DeathExperience');
const { MAX_ACTIONS, INITIAL_MS: MAX_DURATION_MS } = require('./PvpEncounterBudget');
const FLAG_MS = 15000;
const RECOVERY_MS = 90000;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const clan = state => Number(state.stats?.clanId || state.clanId || 0);

function allowed(sides) {
    const states = sides.flatMap(side => side.members);
    if (states.some(s => s.phase !== 'cold' || !(s.vitals?.hp > 0)
        || !Number.isFinite(s.loc?.locX) || !Number.isFinite(s.loc?.locY)
        || utils.isInPeaceZone(s.loc.locX, s.loc.locY))) return false;
    // Clan diplomacy is not implemented here; never infer a war permission.
    return !sides[0].members.some(a => sides[1].members.some(b => clan(a) > 0 && clan(a) === clan(b)));
}

// A cold side as it knows itself: best look, people with servitors, and people
// weighted by their exact condition (HP, CP, MP; a servitor counts fresh).
// coarse: each condition on the ceil quarters others see it on.
function ownSide(states, timestamp, coarse = false) {
    const condition = state => {
        const p = Profile.profileFor(state, timestamp);
        const exact = Visible.condition(clamp(Number(state.vitals?.hp) || 0, 0, p.maxHp) / p.maxHp, p.maxCp > 0 ? p.cp / p.maxCp : 0,
            clamp(Number(state.vitals?.mp) || 0, 0, p.maxMp) / p.maxMp, Roles.shouldRestForMana(state), p.maxCp > 0);
        return coarse ? Visible.seen(exact, true) : exact;
    };
    return { look: Visible.best(states.map(Visible.stateLook)),
        people: states.reduce((sum, s) => sum + Visible.statePeople(s, timestamp), 0),
        strength: states.reduce((sum, s) => sum + condition(s) + Visible.statePeople(s, timestamp) - 1, 0) };
}

// The start gate (U26, the user's choice, 2026-10-05). Character already decided
// at the author's escalation (the PvP intent) or revenge roll; here the opener
// only declines when it clearly looks weaker: visibly worse gear, fewer people,
// or its own condition at least CLEAR_GAP below the other side's seen one
// (both on ceil quarters; one quarter does not count). One roll on the
// encounter's key keeps a rare 2% exception both ways.
const CLEAR_GAP = 0.5;
function clearlyWeaker(own, other, timestamp) {
    const mine = ownSide(own, timestamp, true), theirs = Visible.stateSide(other, timestamp);
    return Visible.compare(mine.look, theirs.look) < 0 || mine.people < theirs.people
        || mine.strength / mine.people <= theirs.strength / theirs.people - CLEAR_GAP;
}

// key: the encounter's key, for the start gate's one roll.
function resolve({ sides, roles, timestamp, rng, personaFor, step = null, openingSide = 1, key = null }) {
    if (!allowed(sides)) return { started: false, reason: 'pvp_protected_context' };
    if (!step?.resuming && Aggression.normalize(Config.pvpAggression) === 0) return { started: false, reason: 'pvp_passive' };
    const fighters = sides.flatMap((side, index) => side.members
        .filter(state => state.characterId === side.principal.characterId || roles.get(state.characterId) === 'support')
        .map(state => {
            const profile = Profile.profileFor(state, timestamp);
            return { state, side: index, profile, id: state.characterId,
                vitals: { hp: clamp(state.vitals.hp, 0, profile.maxHp), maxHp: profile.maxHp,
                    mp: clamp(state.vitals.mp, 0, profile.maxMp), maxMp: profile.maxMp },
                cp: step ? clamp(Number(state.stats?.coldCombat?.cp ?? profile.cp), 0, profile.maxCp) : profile.cp,
                readyAt: step?.resuming ? Math.max(0, Number(state.stats?.coldPvp?.readyAt || timestamp) - timestamp) : index === openingSide ? 0 : 100,
                flagged: Number(state.stats?.coldPvp?.flagUntil || 0) > timestamp,
                flagUntil: Number(state.stats?.coldPvp?.flagUntil || 0),
                lastVictimId: Number(state.stats?.coldPvp?.lastVictimId || 0),
                lastVictimAt: Number(state.stats?.coldPvp?.lastVictimAt || 0),
                cooldowns: { ...(state.stats?.coldCombat?.cooldowns || {}) },
                ...combat.coldChargeState(state, timestamp),
                kills: [], attacks: 0, skills: 0, heals: 0, preparations: 0 };
        }));
    // Resource retaliation opens on side 1; an independent grievance opens on side 0.
    // Can I win? The opener knows its own side exactly, the other only by look (U26).
    if (!step?.resuming) {
        const involved = side => fighters.filter(f => f.side === side).map(f => f.state);
        const weaker = clearlyWeaker(involved(openingSide), involved(1 - openingSide), timestamp);
        const gateKey = key || `cold_open:${sides[openingSide].principal.characterId}:${sides[1 - openingSide].principal.characterId}:${timestamp}`;
        if (Tendency.roll(gateKey, 'open') >= Tendency.chance(weaker ? 0 : 1)) return { started: false, reason: 'pvp_outmatched' };
    }
    const windowMs = step ? Math.max(0, Math.min(1000, Math.min(step.until, step.expiresAt) - timestamp)) : MAX_DURATION_MS;
    let time = 0, actions = 0, losingSide = null, outcome = 'disengaged';
    const incidents = new Map();
    const help = new Map();
    const opponentAid = new Map();
    const incident = (victim, attacker, killed = false) => {
        const key = `${victim.id}:${attacker.id}`;
        const old = incidents.get(key);
        incidents.set(key, { sourceId: victim.id, targetId: attacker.id,
            targetName: attacker.state.name, killed: killed || old?.killed || false });
    };
    const actionBudget = step ? Math.min(MAX_ACTIONS, step.maxActions ?? MAX_ACTIONS) : MAX_ACTIONS;
    while (actions < actionBudget) {
        const next = fighters.filter(f => f.vitals.hp > 0).sort((a, b) => a.readyAt - b.readyAt || a.id - b.id)[0];
        if (!next || next.readyAt > windowMs || (step && timestamp + next.readyAt >= step.expiresAt)) break;
        time = next.readyAt;
        const opponents = fighters.filter(f => f.side !== next.side && f.vitals.hp > 0);
        const target = opponents.find(f => f.id === sides[1 - next.side].principal.characterId) || opponents[0];
        if (!target) { losingSide = 1 - next.side; outcome = 'defeated'; break; }
        const caution = clamp(Number(personaFor(next.state)?.traits?.caution ?? 0.5), 0, 1);
        if ((actions > 0 || step?.resuming) && next.vitals.hp / next.vitals.maxHp
            < Aggression.retreatHp(0.15 + caution * 0.2, Config.pvpAggression)) {
            losingSide = next.side; outcome = 'retreated'; break;
        }
        actions++;
        combat.expireCharges(next, timestamp + time);
        const allies = fighters.filter(f => f.side === next.side);
        const heal = combat.chooseHeal(next.profile, allies, next.vitals.mp, next.cooldowns, timestamp + time, next);
        const policy = { pvp: true, party: sides[next.side].members.length > 1, hp: next.vitals.hp };
        const preparation = heal ? null : combat.chooseChargeSkill(next.profile, next.vitals.mp,
            next.cooldowns, timestamp + time, next.charges, policy);
        const selected = heal || preparation ? null : combat.chooseSkill(next.profile, next.vitals.hp, next.vitals.mp,
            next.cooldowns, timestamp + time, next.charges, rng, policy);
        const skill = heal?.skill || preparation || selected?.skill;
        const delay = combat.actionDelayMs(next.profile, skill);
        // Resolve only completed actions within the bounded combat window.
        if (!step && time + delay > MAX_DURATION_MS) { next.readyAt = MAX_DURATION_MS + 1; continue; }
        if (skill) {
            combat.spendSkill(next, skill, timestamp + time);
            next.skills++;
        }
        if (preparation) {
            combat.addCharges(next, 1, Rules.resolve(preparation).maxCharges, timestamp + time);
            next.preparations++;
        } else if (heal) {
            for (const event of combat.applyAllyHeal(next, allies, heal)) {
                help.set(`${event.sourceId}:${event.targetId}:${event.type}`, event);
                const recipient = allies.find(f => f.id === event.sourceId);
                const victim = opponents.find(f => f.id === Aid.victimId(recipient, next.id, timestamp + time));
                if (victim) opponentAid.set(`${victim.id}:${next.id}`, { sourceId: victim.id, targetId: next.id, type: 'aided_opponent' });
            }
            next.heals++;
        } else {
            if (!(Number(target.state.stats?.karma || 0) > 0)) {
                next.flagged = true;
                next.flagUntil = Math.ceil(timestamp + time + FLAG_MS);
            }
            next.attacks++;
            incident(target, next);
            // A player target: no monster weaknesses. PvP does not count shots yet.
            let damage = combat.attackDamage(next, selected, target.profile, rng);
            combat.settleCharges(next, skill ? Rules.resolve(skill) : {}, timestamp + time);
            damage = Math.max(0, Math.round(damage));
            const shield = Math.min(target.cp, damage);
            target.cp -= shield;
            const hpBefore = target.vitals.hp;
            target.vitals.hp = Math.max(0, target.vitals.hp - (damage - shield));
            if (target.vitals.hp < hpBefore) { next.lastVictimId = target.id; next.lastVictimAt = timestamp + time; }
            if (target.vitals.hp <= 0) {
                const rescued = fighters.find(f => f.id === target.lastVictimId && f.side === next.side && f.id !== next.id);
                const Help = require('../../Social/CombatHelpPolicy');
                if (rescued && timestamp + time >= target.lastVictimAt && timestamp + time - target.lastVictimAt < Help.THREAT_MS
                    && Help.injured(rescued.vitals.hp, rescued.vitals.maxHp)) {
                    help.set(`${rescued.id}:${next.id}:helped_in_combat`, { sourceId: rescued.id, targetId: next.id, type: 'helped_in_combat' });
                }
                incident(target, next, true);
                next.kills.push({ victimId: target.id, victimLevel: target.state.level,
                    pvp: target.flagged || Number(target.state.stats?.karma || 0) > 0 });
                losingSide = target.side; outcome = 'killed'; time += delay;
                break; // A casualty ends the resource skirmish; no automatic party wipe.
            }
        }
        next.readyAt = time + delay;
    }
    if (!step?.resuming && !fighters.some(f => f.attacks || f.preparations)) return { started: false, reason: 'no_hostile_action' };
    const ongoing = !!step && losingSide === null && step.until < step.expiresAt && actions < actionBudget;
    const durationMs = Math.min(MAX_DURATION_MS, Math.max(1000, time));
    // ARCH-NOTE: Native command checkpoints use integer milliseconds. Keep combat
    // duration exact; round only the persisted deadline up so recovery never begins early.
    const until = Math.ceil(timestamp + durationMs + FLAG_MS);
    const updates = new Map(fighters.map(f => {
        const dead = f.vitals.hp <= 0;
        const enemies = [...(f.state.stats?.pvpEnemies || [])].map(e => ({ ...e }));
        for (const event of incidents.values()) if (event.sourceId === f.id) {
            const newAttack = !step?.seen?.includes(`${event.sourceId}:${event.targetId}:attacked`);
            const newKill = event.killed && !step?.seen?.includes(`${event.sourceId}:${event.targetId}:killed`);
            if (!newAttack && !newKill) continue;
            const old = enemies.find(e => e.id === event.targetId) || { id: event.targetId, attacks: 0, kills: 0 };
            const updated = { ...old, name: event.targetName, attacks: Number(old.attacks || 0) + Number(newAttack),
                kills: Number(old.kills || 0) + Number(!!newKill), lastAttackAt: newAttack ? timestamp : old.lastAttackAt, lastSeenAt: timestamp,
                ...(event.killed ? { lastKillAt: timestamp } : {}) };
            const index = enemies.findIndex(e => e.id === updated.id);
            if (index >= 0) enemies.splice(index, 1);
            enemies.push(updated);
        }
        enemies.sort((a, b) => Number(b.kills || 0) - Number(a.kills || 0) || Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));
        const next = { ...f.state, activity: dead ? 'dead' : 'resting', vitals: f.vitals,
            stats: { ...require('../../Social/PeopleKnowledge').statsAfter(f.state.stats, key), deaths: Number(f.state.stats?.deaths || 0) + Number(dead),
                restUntil: until, pvpEnemies: enemies.slice(0, 3),
                coldPvp: { at: timestamp, until: step ? step.until : until, outcome: ongoing ? 'fighting' : outcome,
                    lastVictimId: f.lastVictimId, lastVictimAt: f.lastVictimAt,
                    readyAt: Math.ceil(timestamp + f.readyAt),
                    flagUntil: dead ? 0 : step ? f.flagUntil : f.flagged ? until : 0,
                    ...(dead ? { recoverUntil: until + RECOVERY_MS } : {}) },
                coldCombat: { ...(f.state.stats?.coldCombat || f.profile), cp: dead ? 0 : f.cp, cpAt: step ? step.until : until,
                    cooldowns: dead ? {} : f.cooldowns,
                    charges: dead ? 0 : f.charges, chargeExpiresAt: dead ? null : f.chargeExpiresAt,
                    ...(dead ? { effects: [], charges: 0, chargeExpiresAt: null, summon: null } : {}) } } };
        // The C4 death penalty of an ordinary cold death, with the PvP context.
        // No clan wars, arenas or PvP zones reach cold PvP (peace zones never fight).
        return [f.id, dead ? DeathExperience.applyColdDeath(next, { timestamp, cold: true, killerPlayable: true }).state : next];
    }));
    return { started: true, ongoing, outcome: ongoing ? 'fighting' : outcome, durationMs, until: step ? step.until : until, losingSide, updates,
        incidents: [...incidents.values()], help: [...help.values()], opponentAid: [...opponentAid.values()], fighters: fighters.map(f => ({ id: f.id, side: f.side,
            hp: f.vitals.hp, mp: f.vitals.mp, cp: f.cp, attacks: f.attacks, skills: f.skills,
            preparations: f.preparations, charges: f.charges, heals: f.heals, kills: f.kills })), actions };
}

module.exports = { resolve, allowed, ownSide, clearlyWeaker, CLEAR_GAP, MAX_ACTIONS, MAX_DURATION_MS, FLAG_MS, RECOVERY_MS };
