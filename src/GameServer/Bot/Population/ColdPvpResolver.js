// Bounded, deterministic skirmishes. No actors, SQL, timers or population scans.
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const { combat } = invoke('GameServer/Bot/Population/BackgroundResolver');
const Formulas = invoke('GameServer/Formulas');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const MAX_ACTIONS = 256;
const MAX_DURATION_MS = 30000;
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

function resolve({ sides, roles, timestamp, rng, personaFor }) {
    if (!allowed(sides)) return { started: false, reason: 'pvp_protected_context' };
    const fighters = sides.flatMap((side, index) => side.members
        .filter(state => state.characterId === side.principal.characterId || roles.get(state.characterId) === 'support')
        .map(state => {
            const profile = Profile.profileFor(state, timestamp);
            return { state, side: index, profile, id: state.characterId,
                vitals: { hp: clamp(state.vitals.hp, 0, profile.maxHp), maxHp: profile.maxHp,
                    mp: clamp(state.vitals.mp, 0, profile.maxMp), maxMp: profile.maxMp },
                cp: profile.cp, readyAt: index === 1 ? 0 : 100, flagged: Number(state.stats?.coldPvp?.flagUntil || 0) > timestamp,
                cooldowns: { ...(state.stats?.coldCombat?.cooldowns || {}) },
                kills: [], attacks: 0, skills: 0, heals: 0 };
        }));
    const power = side => fighters.filter(f => f.side === side).reduce((sum, f) => sum
        + (f.vitals.hp + f.cp) * Math.sqrt(Math.max(f.profile.pAtk, f.profile.mAtk)
            * (f.profile.pDef + f.profile.mDef)), 0);
    // The victim of the resource intrusion is the one considering retaliation.
    if (power(1) < power(0) * 0.6) return { started: false, reason: 'pvp_outmatched' };
    let time = 0, actions = 0, losingSide = null, outcome = 'disengaged';
    const incidents = new Map();
    const incident = (victim, attacker, killed = false) => {
        const key = `${victim.id}:${attacker.id}`;
        const old = incidents.get(key);
        incidents.set(key, { sourceId: victim.id, targetId: attacker.id,
            targetName: attacker.state.name, killed: killed || old?.killed || false });
    };
    while (actions < MAX_ACTIONS) {
        const next = fighters.filter(f => f.vitals.hp > 0).sort((a, b) => a.readyAt - b.readyAt || a.id - b.id)[0];
        if (!next || next.readyAt > MAX_DURATION_MS) break;
        time = next.readyAt;
        const opponents = fighters.filter(f => f.side !== next.side && f.vitals.hp > 0);
        const target = opponents.find(f => f.id === sides[1 - next.side].principal.characterId) || opponents[0];
        if (!target) { losingSide = 1 - next.side; outcome = 'defeated'; break; }
        const caution = clamp(Number(personaFor(next.state)?.traits?.caution ?? 0.5), 0, 1);
        if (actions > 0 && next.vitals.hp / next.vitals.maxHp < 0.15 + caution * 0.2) {
            losingSide = next.side; outcome = 'retreated'; break;
        }
        actions++;
        const allies = fighters.filter(f => f.side === next.side);
        const heal = combat.chooseHeal(next.profile, allies, next.vitals.mp, next.cooldowns, timestamp + time);
        const selected = heal ? null : combat.chooseSkill(next.profile, next.vitals.hp, next.vitals.mp,
            next.cooldowns, timestamp + time, 0, rng);
        const skill = heal?.skill || selected?.skill;
        const delay = combat.actionDelayMs(next.profile, skill);
        // Resolve only completed actions within the bounded combat window.
        if (time + delay > MAX_DURATION_MS) { next.readyAt = MAX_DURATION_MS + 1; continue; }
        if (skill) {
            next.vitals.mp = Math.max(0, next.vitals.mp - Number(skill.mp || 0));
            next.cooldowns[skill.selfId] = timestamp + time + delay + Math.max(0, Number(skill.reuse || 0));
            next.skills++;
        }
        if (heal) {
            const semantic = Rules.resolve(skill);
            const targets = semantic.target === 'self' ? [next] : semantic.target === 'party' ? allies : [heal.target];
            for (const ally of targets.filter(f => f.vitals.hp > 0)) {
                const amount = semantic.skillType === Rules.HEAL_PERCENT
                    ? ally.vitals.maxHp * Number(skill.power || 0) / 100 : Formulas.calcHealAmount(skill.power);
                ally.vitals.hp = Math.min(ally.vitals.maxHp, ally.vitals.hp + Math.max(0, amount));
            }
            next.heals++;
        } else {
            next.flagged = true;
            next.attacks++;
            incident(target, next);
            let damage = selected?.magic
                ? Formulas.calcMagicDamage(next.profile.mAtk, Math.max(1, selected.power), target.profile.mDef,
                    { magicCritical: rng() < Math.min(0.25, next.profile.critical / 1000) })
                : combat.hitSucceeds(next.profile.accur, target.profile.evasion, rng)
                    ? Formulas.calcPhysicalDamage(next.profile.pAtk, next.profile.equipment.pAtkRnd,
                        target.profile.pDef, selected?.power || 0, { critical: Formulas.rollCritical(next.profile.critical, rng), rng }) : 0;
            damage = Math.max(0, Math.round(damage));
            const shield = Math.min(target.cp, damage);
            target.cp -= shield;
            target.vitals.hp = Math.max(0, target.vitals.hp - (damage - shield));
            if (target.vitals.hp <= 0) {
                incident(target, next, true);
                next.kills.push({ victimId: target.id, victimLevel: target.state.level,
                    pvp: target.flagged || Number(target.state.stats?.karma || 0) > 0 });
                losingSide = target.side; outcome = 'killed'; time += delay;
                break; // A casualty ends the resource skirmish; no automatic party wipe.
            }
        }
        next.readyAt = time + delay;
    }
    if (!fighters.some(f => f.attacks)) return { started: false, reason: 'no_hostile_action' };
    const durationMs = Math.min(MAX_DURATION_MS, Math.max(1000, time));
    const until = timestamp + durationMs + FLAG_MS;
    const updates = new Map(fighters.map(f => {
        const dead = f.vitals.hp <= 0;
        const enemies = [...(f.state.stats?.pvpEnemies || [])].map(e => ({ ...e }));
        for (const event of incidents.values()) if (event.sourceId === f.id) {
            const old = enemies.find(e => e.id === event.targetId) || { id: event.targetId, attacks: 0, kills: 0 };
            const updated = { ...old, name: event.targetName, attacks: Number(old.attacks || 0) + 1,
                kills: Number(old.kills || 0) + Number(event.killed), lastAttackAt: timestamp, lastSeenAt: timestamp,
                ...(event.killed ? { lastKillAt: timestamp } : {}) };
            const index = enemies.findIndex(e => e.id === updated.id);
            if (index >= 0) enemies.splice(index, 1);
            enemies.push(updated);
        }
        enemies.sort((a, b) => Number(b.kills || 0) - Number(a.kills || 0) || Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));
        return [f.id, { ...f.state, activity: dead ? 'dead' : 'resting', vitals: f.vitals,
            stats: { ...f.state.stats, deaths: Number(f.state.stats?.deaths || 0) + Number(dead),
                restUntil: until, pvpEnemies: enemies.slice(0, 3),
                coldPvp: { at: timestamp, until, outcome, flagUntil: !dead && f.flagged ? until : 0,
                    ...(dead ? { recoverUntil: until + RECOVERY_MS } : {}) },
                coldCombat: { ...(f.state.stats?.coldCombat || f.profile), cp: dead ? 0 : f.cp, cpAt: until,
                    cooldowns: dead ? {} : f.cooldowns,
                    ...(dead ? { effects: [], charges: 0, chargeExpiresAt: null, summon: null } : {}) } } }];
    }));
    return { started: true, outcome, durationMs, until, losingSide, updates,
        incidents: [...incidents.values()], fighters: fighters.map(f => ({ id: f.id, side: f.side,
            hp: f.vitals.hp, mp: f.vitals.mp, cp: f.cp, attacks: f.attacks, skills: f.skills, heals: f.heals, kills: f.kills })), actions };
}

module.exports = { resolve, allowed, MAX_ACTIONS, MAX_DURATION_MS, FLAG_MS, RECOVERY_MS };
