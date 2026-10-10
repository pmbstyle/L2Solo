const Rules = invoke('GameServer/Skills/C4SkillRules');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const WeaponMask = invoke('GameServer/Skills/WeaponMask');

const MIN_EFFICIENCY = 0.15;
const ELEMENTS = ['fire', 'water', 'wind', 'earth', 'holy', 'dark'];
const DAMAGE_TYPES = new Set([Rules.DAMAGE, Rules.DAMAGE_EFFECT, Rules.DRAIN,
    Rules.DEATH_LINK, Rules.FATAL, Rules.BLOW]);
const weaponStat = kind => ({ 'Weapon.Bow': 'bowWpnVuln', 'Weapon.Knife': 'daggerWpnVuln',
    'Weapon.Blunt': 'bluntWpnVuln', 'Weapon.BigBlunt': 'bluntWpnVuln' })[kind];
const number = (value, fallback = 1) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const positive = value => Math.max(1, number(value));
let npcSource, npcCount = 0, npcIndex = new Map();
// Resolved on first use (the cold worker loads this module before them);
// invoke() re-resolves the path on every call inside spot scans.
let DataCacheModule, HuntingTargetPolicy, ColdCombatProfile;
const dataCache = () => DataCacheModule || (DataCacheModule = invoke('GameServer/DataCache'));
const huntingTargetPolicy = () => HuntingTargetPolicy
    || (HuntingTargetPolicy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy'));
const coldCombatProfile = () => ColdCombatProfile
    || (ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile'));

function npcTemplate(id) {
    const source = dataCache().npcs || [];
    if (npcSource !== source || npcCount !== source.length) {
        npcSource = source;
        npcCount = source.length;
        npcIndex = new Map(source.map(npc => [Number(npc.selfId), npc]));
    }
    return npcIndex.get(Number(id));
}

// A scan owns this snapshot: do not retain live effects, equipment or learned
// skills across decisions. Cold callers already own an immutable profile.
function actorProfile(actor) {
    return {
        classId: actor.fetchClassId?.(), level: actor.fetchLevel?.(),
        role: Roles.combatRoleFor(actor),
        pAtk: actor.fetchCollectivePAtk?.() ?? actor.fetchPAtk?.(),
        mAtk: actor.fetchCollectiveMAtk?.() ?? actor.fetchMAtk?.(),
        atkSpd: actor.fetchCollectiveAtkSpd?.() ?? actor.fetchAtkSpd?.() ?? 300,
        castSpd: actor.fetchCollectiveCastSpd?.() ?? actor.fetchCastSpd?.() ?? 333,
        maxMp: actor.fetchMaxMp?.(), weaponMask: WeaponMask.weaponMaskFor(actor),
        maxHp: actor.fetchMaxHp?.(),
        pDef: actor.fetchCollectivePDef?.() ?? actor.fetchPDef?.(),
        equipment: { weaponKind: actor.backpack?.fetchTotalWeaponKind?.() },
        skills: (actor.skillset?.skills || actor.skillset?.fetchSkills?.() || []).map(skill => ({
            selfId: skill.fetchSelfId?.(), level: skill.fetchLevel?.(),
            reuseReady: actor.canUseSkill?.(skill) !== false,
            semantic: skill.fetchSemantic?.() || {}, passive: skill.fetchPassive?.(),
            spell: skill.fetchSpell?.(), power: skill.fetchPower?.(), mp: skill.fetchConsumedMp?.(),
            hitTime: skill.fetchHitTime?.(), reuse: skill.fetchReuseTime?.(), distance: skill.fetchDistance?.()
        }))
    };
}

function actorProfiles(actors) {
    return actors.filter(Boolean).flatMap(actor => {
        const profile = actorProfile(actor);
        if (actor.summon && !actor.summon.isDead?.() && !actor.summon.state?.fetchDead?.()) {
            return [profile, { ...actorProfile(actor.summon), role: 'dps' }];
        }
        return coldProfiles(profile, { vitals: { mp: actor.fetchMp?.() } });
    });
}

function coldProfiles(profile, state = {}, timestamp = Date.now()) {
    const profiles = [{ ...profile, skills: (profile.skills || []).map(skill => ({
        ...skill, semantic: skill.semantic || Rules.resolveCached(skill)
    })) }];
    const summon = state.stats?.coldCombat?.summon;
    if (summon?.active && number(summon.hp, summon.maxHp) > 0 && summon.expiresAt > timestamp) {
        profiles.push({ ...summon, role: 'dps', skills: [] });
    } else if (Roles.isSummoner(profile.classId)) {
        const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
        const skill = Cold.summonSkills(profile).find(s => s.reuseReady !== false
            && number(s.mp, 0) <= number(state.vitals?.mp, profile.maxMp)
            && number(state.stats?.coldCombat?.cooldowns?.[s.selfId], 0) <= timestamp);
        if (skill) profiles.push({ ...invoke('GameServer/Bot/Population/ColdSummonProfile')(profile, Cold.summonDetails(skill)),
            role: 'dps', skills: [] });
    }
    return profiles;
}

function profileStats(profiles) {
    return [...new Set((profiles || []).flatMap(profile => [weaponStat(profile.equipment?.weaponKind),
        ...(profile.skills || []).map(skill => {
            const trait = (skill.semantic || Rules.resolve(skill)).trait;
            return skill.spell && ELEMENTS.includes(trait) ? `${trait}Vuln` : null;
        })]).filter(Boolean))];
}

function skillStats(actor) {
    return profileStats([{ equipment: { weaponKind: actor.backpack?.fetchTotalWeaponKind?.() },
        skills: (actor.skillset?.skills || []).map(skill => ({
            spell: skill.fetchSpell?.(), semantic: skill.fetchSemantic?.() || {}
        })) }]);
}

function targetView(target, stats = ['bowWpnVuln', 'bluntWpnVuln', 'daggerWpnVuln', ...ELEMENTS.map(e => `${e}Vuln`)]) {
    if (!target || typeof target.fetchHp !== 'function') return target || {};
    // ColdClassPolicy supplies the same projection as native target scans.
    if (target.matchupTarget) return target.matchupTarget;
    // Native effect evaluation loads World/GameTime; cold workers must use
    // their serialized target stats without importing the live world.
    const EffectStats = invoke('GameServer/Effects/EffectStats');
    const vulnerabilities = {};
    for (const stat of stats) {
        vulnerabilities[stat] = EffectStats.multiplier(target, stat, 1);
    }
    const pDef = target.fetchCollectivePDef?.() ?? target.fetchPDef?.();
    const mDef = target.fetchCollectiveMDef?.() ?? target.fetchMDef?.();
    return { vulnerabilities, pDef, mDef, undead: target.fetchUndead?.() === true,
        maxHp: target.fetchMaxHp?.(),
        pAtk: target.fetchCollectivePAtk?.() ?? target.fetchPAtk?.(),
        atkSpd: target.fetchCollectiveAtkSpd?.() ?? target.fetchAtkSpd?.(),
        basePDef: target.fetchPDef?.() ?? pDef, baseMDef: target.fetchMDef?.() ?? mDef };
}

function modifier(target, semantic = {}, magic = false, kind = '') {
    const stat = magic ? (ELEMENTS.includes(semantic.trait) ? `${semantic.trait}Vuln` : null)
        : semantic.trait === 'bow' ? 'bowWpnVuln'
            : semantic.trait === 'dagger' ? 'daggerWpnVuln' : weaponStat(kind);
    const vuln = stat ? Math.max(0, number(target.vulnerabilities?.[stat])) : 1;
    const base = magic ? target.baseMDef : target.basePDef;
    const defense = magic ? target.mDef : target.pDef;
    return vuln * (number(base, 0) > 0 && number(defense, 0) > 0 ? base / defense : 1);
}

function skillModifier(actor, target, skill, view = targetView(target)) {
    return modifier(view, skill.fetchSemantic?.(), skill.fetchSpell?.() === true,
        actor.backpack?.fetchTotalWeaponKind?.() || '');
}

function channels(profile, target) {
    const role = profile.role || Roles.combatRoleFor(profile);
    const kind = profile.equipment?.weaponKind || '';
    const physical = role !== 'mage';
    const result = [];
    if (physical) result.push({ weight: 70 * positive(profile.pAtk) / positive(target.basePDef || target.pDef)
        * positive(profile.atkSpd || 300) / 500,
    modifier: modifier(target, {}, false, kind), magic: false });
    for (const skill of profile.skills || []) {
        const semantic = skill.semantic || Rules.resolve(skill);
        const magic = skill.spell === true;
        if (skill.passive || !DAMAGE_TYPES.has(semantic.skillType) || semantic.target !== 'enemy'
            || semantic.notUsedInC4 || (role === 'mage' && !magic)
            || (semantic.undeadOnly && target.undead !== true)
            || (number(profile.maxMp, 0) > 0 && number(skill.mp, 0) > profile.maxMp)
            || (semantic.requires?.weaponsAllowed && !(semantic.requires.weaponsAllowed & profile.weaponMask))
            || (kind === 'Weapon.Bow' && number(semantic.castRange ?? skill.distance, 0) < 400)) continue;
        const power = Math.max(0, number(skill.power ?? semantic.power, 0));
        if (!power) continue;
        const weight = magic
            ? 91 * Math.sqrt(positive(profile.mAtk)) * power / positive(target.baseMDef || target.mDef)
                / Math.max(0.5, number(skill.hitTime, 3000) / 1000 * 333 / positive(profile.castSpd || 333))
            : 70 * (positive(profile.pAtk) + power) / positive(target.basePDef || target.pDef)
                / Math.max(1, number(skill.hitTime, 1500) / 1000);
        const hitDamage = magic
            ? 91 * Math.sqrt(positive(profile.mAtk)) * power / positive(target.baseMDef || target.mDef)
            : 70 * (positive(profile.pAtk) + power) / positive(target.basePDef || target.pDef);
        result.push({ weight, modifier: modifier(target, semantic, magic, kind), magic,
            survivalWeight: Math.min(weight, hitDamage / Math.max(0.25, number(skill.reuse, 0) / 1000)),
            damageBudget: number(skill.mp, 0) > 0
                ? Math.floor(number(profile.maxMp, 0) / skill.mp) * hitDamage : Infinity });
    }
    return result;
}

function evaluate(profiles, target) {
    let neutral = 0, effective = 0;
    for (const profile of profiles || []) {
        const attacks = channels(profile, target);
        if (!attacks.length) continue; // Missing legacy skill data is not immunity.
        neutral += Math.max(...attacks.map(a => a.weight));
        effective += Math.max(...attacks.map(a => a.weight * a.modifier));
    }
    const efficiency = neutral > 0 ? effective / neutral : 1;
    return { efficiency, eligible: efficiency > MIN_EFFICIENCY,
        penalty: Math.round(Math.max(0, 1 - efficiency) * 900),
        reason: efficiency <= MIN_EFFICIENCY ? 'target_resistance' : 'target_efficiency' };
}

// Full-health readiness, not an estimate of the current injured fight. Keep
// headroom for misses, interrupted casts and the retreat before zero HP.
// Missing legacy projections remain neutral until real stats are available.
function soloSurvival(profiles, target, minimum = 1.5) {
    if (!profiles?.length || !(target.maxHp > 0) || !(target.pAtk > 0)
        || profiles.some(profile => profile.survivalKnown === false || !(profile.maxHp > 0) || !(profile.pDef > 0))) {
        return { eligible: true, survivalRatio: null };
    }
    const lifetime = Math.max(...profiles.map(profile => profile.maxHp
        / (70 * target.pAtk / profile.pDef * positive(target.atkSpd || 253) / 500)));
    const damage = profiles.reduce((sum, profile) => sum + Math.max(0, ...channels(profile, target)
        .map(attack => Math.min((attack.survivalWeight ?? attack.weight) * lifetime,
            attack.damageBudget ?? Infinity) * attack.modifier)), 0);
    const survivalRatio = damage / target.maxHp;
    return { eligible: survivalRatio >= minimum, survivalRatio,
        reason: survivalRatio >= minimum ? 'solo_survival_ready' : 'insufficient_survival_margin' };
}

function soloCanHunt(profiles, target, { maxTargetLevel, npcLevel } = {}) {
    const survival = soloSurvival(profiles, target);
    if (maxTargetLevel && Number(npcLevel || 0) > maxTargetLevel) {
        return { ...survival, eligible: false, reason: 'recovery_level' };
    }
    return survival.survivalRatio === null ? { ...evaluate(profiles, target), survivalRatio: null } : survival;
}

// An optimistic damage bound, not another survival gate. Compile skills once
// against unit defenses and an undead target, then keep at most three numeric
// attack envelopes per profile. Separate maxima for rate/budget and the best
// vulnerability can only increase damage, so an exact-safe mob stays eligible.
function soloSpotUpperBound(profiles) {
    if (!profiles?.length || profiles.some(p => p.survivalKnown === false
        || !Number.isFinite(p.maxHp) || !(p.maxHp > 0) || !Number.isFinite(p.pDef) || !(p.pDef > 0))) {
        return () => true;
    }
    const lifetimeNumerator = Math.max(...profiles.map(p => p.maxHp * p.pDef)) * 500 / 70;
    if (!Number.isFinite(lifetimeNumerator)) return () => true;
    const neutral = { basePDef: 1, pDef: 1, baseMDef: 1, mDef: 1, undead: true };
    const bounds = profiles.map(profile => {
        const bound = { continuous: 0, physicalRate: 0, physicalBudget: 0, magicRate: 0, magicBudget: 0 };
        for (const attack of channels(profile, neutral)) {
            const rate = attack.survivalWeight ?? attack.weight;
            const budget = attack.damageBudget ?? Infinity;
            if (!attack.magic && budget === Infinity) bound.continuous = Math.max(bound.continuous, rate);
            else {
                const prefix = attack.magic ? 'magic' : 'physical';
                bound[`${prefix}Rate`] = Math.max(bound[`${prefix}Rate`], rate);
                bound[`${prefix}Budget`] = Math.max(bound[`${prefix}Budget`], budget);
            }
        }
        return bound;
    });
    // Search-local, capped at 256 species (~8 KiB of pairs); never retained on
    // a bot, a shared verdict fingerprint or a saved combat projection.
    const seen = new Map();
    function maybeSafe(selfId) {
        if (seen.has(selfId)) return seen.get(selfId);
        const npc = npcTemplate(selfId);
        if (!npc || !huntingTargetPolicy().canHunt(npc)) return null;
        const target = coldCombatProfile().npcCombatStats(npc);
        if (!(target?.maxHp > 0) || !(target.pAtk > 0)
            || !(target.basePDef > 0) || !(target.baseMDef > 0)) return true;
        const seconds = lifetimeNumerator / (target.pAtk * positive(target.atkSpd || 253));
        let vulnerability = 1;
        for (const stat in target.vulnerabilities) {
            vulnerability = Math.max(vulnerability, number(target.vulnerabilities[stat]));
        }
        const damage = bounds.reduce((sum, bound) => sum + Math.max(
            bound.continuous * seconds / positive(target.pDef),
            Math.min(bound.physicalRate * seconds, bound.physicalBudget) / positive(target.pDef),
            Math.min(bound.magicRate * seconds, bound.magicBudget) / positive(target.mDef)) * vulnerability, 0);
        const allowed = damage / target.maxHp >= 1.5;
        if (seen.size < 256) seen.set(selfId, allowed);
        return allowed;
    }
    return spot => {
        let total = 0, safe = 0;
        for (const entry of spot.npcEntries || []) {
            const allowed = maybeSafe(Number(entry.selfId));
            if (allowed === null) continue;
            const weight = Math.max(1, number(entry.count));
            total += weight;
            if (allowed) safe += weight;
        }
        return !total || safe / total >= 0.6;
    };
}

function stateProfiles(state, options = {}) {
    if (options.matchupProfiles) return options.matchupProfiles;
    const states = (options.capacityStates?.length ? options.capacityStates : [state])
        .filter(member => member.vitals?.hp !== 0 && member.activity !== 'dead');
    // Do not invent the other members of an incomplete party projection.
    if (options.mode === 'party' && states.length === 1) return [];
    const Cold = coldCombatProfile();
    return states.flatMap(member => typeof member.fetchHp === 'function'
        ? actorProfiles([member])
        : coldProfiles({ ...Cold.profileFor(member, options.timestamp),
            // Partial route projections must not turn an invented default
            // class/build into evidence that the real character is too weak.
            survivalKnown: !!member.stats?.coldCombat
                || Number.isFinite(Number(member.stats?.classId ?? member.classId))
        }, member, options.timestamp));
}

// A spot search checks hundreds of spots with one profile array, and each mob
// species appears on several of them. The verdict depends only on the
// profiles, the species and the safety options. Searches repeat for the same
// bot after every commit, and bots of one class, level and kit share combat
// fields, so verdicts are shared by every profile array with the same fields.
// Profiles unused for VERDICT_PROFILE_IDLE_MS (level-up, new gear) are dropped
// when a new profile is added.
const VERDICT_PROFILE_LIMIT = 4096;
const VERDICT_PROFILE_IDLE_MS = 10 * 60 * 1000;
const npcVerdicts = new WeakMap();
const sharedVerdicts = new Map();
const uniqueVerdicts = new Map();
let verdictSource, verdictCount = 0;

// Raw values with their type: channels() and soloSurvival() coerce with
// number(), compare and test truthiness, so only identical inputs share.
function fingerprintValue(value) {
    switch (typeof value) {
    case 'number': return Object.is(value, -0) ? '-0' : String(value);
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'T' : 'F';
    case 'undefined': return 'u';
    default: if (value === null) return 'n';
    }
    throw new TypeError('unshareable matchup value');
}

// Exactly the fields channels() and soloSurvival() read.
function profileFingerprint(profile) {
    const role = profile.role || Roles.combatRoleFor(profile);
    const parts = [role, profile.equipment?.weaponKind || '', profile.pAtk, profile.atkSpd, profile.mAtk,
        profile.castSpd, profile.maxMp, profile.weaponMask, profile.maxHp, profile.pDef,
        profile.survivalKnown === false].map(fingerprintValue);
    for (const skill of profile.skills || []) {
        const semantic = skill.semantic || Rules.resolveCached(skill);
        parts.push('|', ...[skill.passive, skill.spell === true, skill.mp, skill.power, skill.hitTime, skill.reuse,
            skill.distance, semantic.skillType, semantic.target, semantic.notUsedInC4, semantic.undeadOnly,
            semantic.requires?.weaponsAllowed, semantic.castRange, semantic.power, semantic.trait]
            .map(fingerprintValue));
    }
    return parts.join(',');
}

// Verdicts of one profile array: safety options key -> species id -> verdict.
function verdictsFor(profiles) {
    let verdicts = npcVerdicts.get(profiles);
    if (verdicts) return verdicts;
    const source = dataCache().npcs || [];
    if (verdictSource !== source || verdictCount !== source.length) {
        verdictSource = source;
        verdictCount = source.length;
        sharedVerdicts.clear();
        uniqueVerdicts.clear();
    }
    let fingerprint = null;
    try { fingerprint = profiles.map(profileFingerprint).join('#'); } catch (_) { /* kept per array */ }
    const now = Date.now();
    const shared = fingerprint === null ? null : sharedVerdicts.get(fingerprint);
    if (shared) {
        sharedVerdicts.delete(fingerprint);
        shared.usedAt = now;
        sharedVerdicts.set(fingerprint, shared);
        verdicts = shared.verdicts;
    } else {
        verdicts = new Map();
        if (fingerprint !== null) {
            sharedVerdicts.set(fingerprint, { verdicts, usedAt: now });
            for (const [key, entry] of sharedVerdicts) {
                if (sharedVerdicts.size <= VERDICT_PROFILE_LIMIT && now - entry.usedAt < VERDICT_PROFILE_IDLE_MS) break;
                sharedVerdicts.delete(key);
            }
        }
    }
    npcVerdicts.set(profiles, verdicts);
    return verdicts;
}

function npcVerdict(verdicts, selfId, options) {
    if (verdicts.has(selfId)) return verdicts.get(selfId);
    const npc = npcTemplate(selfId);
    let verdict = null;
    if (npc && huntingTargetPolicy().canHunt(npc)) {
        const target = coldCombatProfile().npcCombatStats(npc);
        const match = evaluate(options.profiles, target);
        const withinRecoveryLevel = !options.maxTargetLevel || Number(npc.template?.level || 0) <= options.maxTargetLevel;
        const canHunt = options.soloSafety ? soloCanHunt(options.profiles, target,
            { maxTargetLevel: options.maxTargetLevel, npcLevel: Number(npc.template?.level || 0) }).eligible
            : match.eligible && withinRecoveryLevel;
        // Read-only verdicts are shared. Mixed-attack and party profiles give
        // continuous efficiencies, so the pool is cleared at a bound; verdicts
        // already handed out stay valid.
        const key = `${canHunt ? 1 : 0}:${fingerprintValue(match.efficiency)}`;
        verdict = uniqueVerdicts.get(key);
        if (!verdict) {
            if (uniqueVerdicts.size >= VERDICT_PROFILE_LIMIT * 4) uniqueVerdicts.clear();
            uniqueVerdicts.set(key, verdict = Object.freeze({ efficiency: match.efficiency, canHunt }));
        }
    }
    verdicts.set(selfId, verdict);
    return verdict;
}

// A spot's matchup reads only its mob list and the verdicts of one profile
// fingerprint and safety options, so it is shared the same way: a spot search
// after every commit checks hundreds of spots against the same verdicts.
const spotMatchups = new WeakMap();
// Equal results are one object: most fingerprints get the same few values on
// most spots. Bounded like the verdict pool; results already handed out stay valid.
const uniqueSpotResults = new Map();

function spotMatchup(spot, profiles, options = {}) {
    if (!profiles?.length) return evaluate([], {});
    let total = 0, effective = 0, eligible = false, safe = 0;
    const byOptions = verdictsFor(profiles);
    const optionsKey = `${options.soloSafety ? 1 : 0}:${options.maxTargetLevel || 0}`;
    let verdicts = byOptions.get(optionsKey);
    if (!verdicts) byOptions.set(optionsKey, verdicts = new Map());
    let bySpot = spotMatchups.get(verdicts);
    if (!bySpot) spotMatchups.set(verdicts, bySpot = new WeakMap());
    const known = bySpot.get(spot);
    if (known) return known;
    const verdictOptions = { profiles, soloSafety: options.soloSafety, maxTargetLevel: options.maxTargetLevel };
    for (const entry of spot.npcEntries || []) {
        const verdict = npcVerdict(verdicts, Number(entry.selfId), verdictOptions);
        if (!verdict) continue;
        const weight = Math.max(1, number(entry.count));
        total += weight;
        effective += weight * Math.min(1, verdict.efficiency);
        const canHunt = verdict.canHunt;
        eligible ||= canHunt;
        if (canHunt) safe += weight;
    }
    const efficiency = total ? effective / total : 1;
    const safeFraction = total ? safe / total : 1;
    const spotEligible = !total || (eligible && (!options.soloSafety || safeFraction >= 0.6));
    const penalty = Math.round((1 - efficiency) * 250 + (options.soloSafety ? (1 - safeFraction) * 250 : 0));
    const key = `${efficiency}:${safeFraction}:${spotEligible ? 1 : 0}:${penalty}`;
    let result = uniqueSpotResults.get(key);
    if (!result) {
        if (uniqueSpotResults.size >= VERDICT_PROFILE_LIMIT * 4) uniqueSpotResults.clear();
        uniqueSpotResults.set(key, result = Object.freeze({ efficiency, safeFraction, eligible: spotEligible, penalty }));
    }
    bySpot.set(spot, result);
    return result;
}

// A fixed attack envelope, shared with the survival gate. Admission may
// compare native buff effects without running an encounter simulation.
function damageRate(profiles, target = {}) {
    return profiles.reduce((sum, profile) => sum + Math.max(0, ...channels(profile, target)
        .map(attack => (attack.survivalWeight ?? attack.weight) * attack.modifier)), 0);
}

module.exports = { MIN_EFFICIENCY, VERDICT_PROFILE_LIMIT, actorProfiles, coldProfiles, targetView, skillModifier, damageRate,
    profileStats, skillStats, evaluate, soloSurvival, soloCanHunt, soloSpotUpperBound, stateProfiles, spotMatchup,
    sharedVerdictProfiles: () => sharedVerdicts.size, uniqueVerdictCount: () => uniqueVerdicts.size };
