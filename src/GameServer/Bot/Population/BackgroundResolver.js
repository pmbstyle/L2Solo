const ProgressionRates = invoke('GameServer/ProgressionRates');
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const ChargeLifecycle = invoke('GameServer/Skills/ChargeLifecycle');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function randInt(rng, min, max) {
    return Math.floor(rng() * (max - min + 1)) + min;
}

function midpointBand(levelBand) {
    if (!levelBand) return 1;
    const parts = String(levelBand).split('-').map((value) => Number(value));
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return Number(parts[0]) || 1;
    return Math.round((parts[0] + parts[1]) / 2);
}

function botCombatStats(state, timestamp = Date.now()) {
    return ColdCombatProfile.profileFor(state, timestamp);
}

const ELEMENTAL_DAMAGE_TRAITS = new Set(['fire', 'water', 'wind', 'earth', 'holy', 'dark']);
const PHYSICAL_RACE_STATS = Object.freeze({
    animal: 'pAtk-animals',
    beast: 'pAtk-monsters',
    construct: 'pAtk-mcreatures',
    dragon: 'pAtk-dragons',
    giant: 'pAtk-giants',
    insect: 'pAtk-insects',
    plant: 'pAtk-plants'
});

function mobVulnerability(mob, stat) {
    const value = Number(mob?.vulnerabilities?.[stat]);
    return Number.isFinite(value) ? Math.max(0, value) : 1;
}

function coldWeaponVulnerability(bot, mob, semantic = {}) {
    const kind = String(bot?.equipment?.weaponKind || '');
    if (semantic.trait === 'bow' || kind === 'Weapon.Bow') return mobVulnerability(mob, 'bowWpnVuln');
    if (kind === 'Weapon.Blunt' || kind === 'Weapon.BigBlunt') return mobVulnerability(mob, 'bluntWpnVuln');
    if (semantic.trait === 'dagger' || kind === 'Weapon.Knife') return mobVulnerability(mob, 'daggerWpnVuln');
    return 1;
}

function coldPhysicalTargetModifier(bot, mob, semantic = {}, timestamp = Date.now()) {
    let modifier = coldWeaponVulnerability(bot, mob, semantic);
    if (mob?.undead === true) modifier *= ColdCombatProfile.statMultiplier(bot, 'pAtkUndeadMul', timestamp);
    const raceStat = PHYSICAL_RACE_STATS[String(mob?.race || '').toLowerCase()];
    if (raceStat) modifier *= ColdCombatProfile.statMultiplier(bot, raceStat, timestamp);
    return modifier;
}

function coldMagicTargetModifier(mob, semantic = {}) {
    return ELEMENTAL_DAMAGE_TRAITS.has(semantic.trait)
        ? mobVulnerability(mob, `${semantic.trait}Vuln`)
        : 1;
}

function coldNpcWeaponModifier(mob, target, timestamp = Date.now()) {
    const kind = String(mob?.weaponKind || '');
    if (kind === 'Weapon.Bow') return ColdCombatProfile.statMultiplier(target, 'bowWpnVuln', timestamp);
    if (kind === 'Weapon.Blunt' || kind === 'Weapon.BigBlunt') {
        return ColdCombatProfile.statMultiplier(target, 'bluntWpnVuln', timestamp);
    }
    return 1;
}

function coldChargeState(state, timestamp) {
    const coldCombat = state.stats?.coldCombat || {};
    const expiresAt = Number(coldCombat.chargeExpiresAt) || 0;
    return expiresAt > timestamp
        ? { charges: Math.max(0, Number(coldCombat.charges) || 0), chargeExpiresAt: expiresAt }
        : { charges: 0, chargeExpiresAt: null };
}

function expireCharges(holder, timestamp) {
    if (holder.chargeExpiresAt && holder.chargeExpiresAt <= timestamp) {
        holder.charges = 0;
        holder.chargeExpiresAt = null;
    }
}

function addCharges(holder, amount, maximum, timestamp) {
    const previous = Math.max(0, Number(holder.charges) || 0);
    const maxCharges = Math.max(1, Number(maximum) || 1);
    holder.charges = Math.min(maxCharges, previous + Math.max(0, Number(amount) || 0));
    if (previous === 0 && holder.charges > 0) {
        holder.chargeExpiresAt = timestamp + ChargeLifecycle.EXPIRY_MS;
    }
}

function consumeCharges(holder, amount) {
    holder.charges = Math.max(0, Number(holder.charges) - Math.max(0, Number(amount) || 0));
    if (holder.charges === 0) holder.chargeExpiresAt = null;
}

function coldPassiveRegenAdd(state, skillId, stat) {
    const classId = Number(state.stats?.classId ?? state.classId);
    const skill = (DataCache.skillTree || []).find((tree) => Number(tree.classId) === classId)?.skills
        ?.find((entry) => Number(entry.selfId) === skillId);
    const level = Number(state.level || midpointBand(state.levelBand));
    const skillLevel = (skill?.levels || [])
        .filter((entry) => Number(entry.pLevel) <= level)
        .reduce((highest, entry) => Math.max(highest, Number(entry.level) || 0), 0);
    if (!skillLevel) return 0;

    return Number(C4SkillRules.resolve({ selfId: skillId, level: skillLevel }).stats?.[stat]) || 0;
}

function coldRestRegenPerTick(state) {
    const level = Math.max(1, Number(state.level || midpointBand(state.levelBand)) || 1);
    const classId = Number(state.stats?.classId ?? state.classId);
    const template = (DataCache.classTemplates || []).find((entry) => Number(entry.classId) === classId) || {};
    const baseStats = template.base || {};
    const hpBase = Number(DataCache.revitalize?.hp?.[level]) || 0;
    const mpBase = Number(DataCache.revitalize?.mp?.[level]) || 0;
    const hp = ((hpBase * Formulas.calcLevelMod(level) * Formulas.calcBaseMod.CON(Number(baseStats.con) || 1))
        + coldPassiveRegenAdd(state, 212, 'regHpAdd')) * 1.5;
    const mp = ((mpBase * Formulas.calcLevelMod(level) * Formulas.calcBaseMod.MEN(Number(baseStats.men) || 1))
        + coldPassiveRegenAdd(state, 229, 'regMpAdd')) * 1.5;

    return { hp: Math.max(0, hp), mp: Math.max(0, mp) };
}

function requiresManaRecovery(state, options = {}) {
    if (typeof options.requireMana === 'boolean') return options.requireMana;
    return options.party === true
        ? BotRoles.needsPartyManaRecovery(state)
        : BotRoles.shouldRestForMana(state);
}

function needsRest(state, vitals, options = {}) {
    const hpRatio = Number(vitals?.hp ?? 0) / Math.max(1, Number(vitals?.maxHp ?? vitals?.hp ?? 1));
    const mpRatio = Number(vitals?.mp ?? 0) / Math.max(1, Number(vitals?.maxMp ?? vitals?.mp ?? 1));
    return hpRatio < Number(options.hpThreshold ?? 0.35)
        || (requiresManaRecovery(state, options) && mpRatio < Number(options.mpThreshold ?? 0.20));
}

function estimateRestMs(state, vitals, options = {}) {
    const maxHp = Number(vitals.maxHp || vitals.hp || 1);
    const maxMp = Number(vitals.maxMp || vitals.mp || 1);
    const missingHp = Math.max(0, maxHp - Number(vitals.hp || 0));
    const missingMp = Math.max(0, maxMp - Number(vitals.mp || 0));
    const regen = coldRestRegenPerTick(state);
    const hpSeconds = missingHp / Math.max(0.01, regen.hp / 3);
    const mpSeconds = requiresManaRecovery(state, options)
        ? missingMp / Math.max(0.01, regen.mp / 3)
        : 0;

    return Math.round(Math.max(hpSeconds, mpSeconds, 8) * 1000);
}

function applyStandingRegen(state, sourceVitals, elapsedMs, timestamp = Date.now()) {
    const combat = botCombatStats(state, timestamp);
    const vitals = {
        hp: Math.max(0, Number(sourceVitals?.hp ?? combat.maxHp)),
        maxHp: combat.maxHp,
        mp: Math.max(0, Number(sourceVitals?.mp ?? combat.maxMp)),
        maxMp: combat.maxMp
    };
    const sitting = coldRestRegenPerTick(state);
    const ticks = Math.max(0, Number(elapsedMs) || 0) / 3000;
    // C4 base regeneration continues while standing. The 1.5 multiplier in
    // coldRestRegenPerTick is the seated bonus, so remove it for hunt time.
    vitals.hp = Math.min(vitals.maxHp, vitals.hp + (sitting.hp / 1.5) * ticks);
    vitals.mp = Math.min(vitals.maxMp, vitals.mp + (sitting.mp / 1.5) * ticks);
    return vitals;
}

function resolveRest(state, elapsedMs, timestamp, options = {}) {
    const combat = botCombatStats(state, timestamp);
    const vitals = {
        hp: Math.max(0, Number(state.vitals?.hp || 0)),
        maxHp: combat.maxHp,
        mp: Math.max(0, Number(state.vitals?.mp || 0)),
        maxMp: combat.maxMp
    };
    const regen = coldRestRegenPerTick(state);
    const ticks = Math.max(0, Number(elapsedMs) || 0) / 3000;
    vitals.hp = Math.min(vitals.maxHp, vitals.hp + regen.hp * ticks);
    vitals.mp = Math.min(vitals.maxMp, vitals.mp + regen.mp * ticks);

    const hpReady = vitals.hp / Math.max(1, vitals.maxHp) >= 0.95;
    const requireMana = requiresManaRecovery(state, options);
    const mpReady = !requireMana || vitals.mp / Math.max(1, vitals.maxMp) >= 0.95;
    // A persisted deadline can come from the old all-roles MP policy. For a
    // non-mana role, recompute only the remaining HP recovery instead.
    const scheduledRemainingMs = requireMana
        ? Math.max(0, Number(state.stats?.restUntil || 0) - timestamp)
        : 0;
    const remainingMs = Math.max(estimateRestMs(state, vitals, options), scheduledRemainingMs);
    const resting = !hpReady || !mpReady || scheduledRemainingMs > 0;
    const restUntil = resting ? timestamp + remainingMs : null;

    return {
        patch: {
            activity: resting ? 'resting' : 'hunting',
            vitals,
            stats: { ...(state.stats || {}), restUntil }
        },
        events: resting ? [] : [{
            type: 'recovered',
            summary: `${state.name || 'Bot'} finished recovering and returned to hunting`,
            weight: 1
        }],
        materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        // Sleeping is not an active simulation state.  Persist the exact
        // recovery deadline so the scheduler can leave this bot alone until
        // HP/MP should have changed.
        nextResolveAt: resting ? restUntil : timestamp + 30000,
        debug: { activity: resting ? 'resting' : 'recovered', regen, remainingMs, requireMana }
    };
}

function resolveTravel(state, timestamp = Date.now()) {
    const travel = state.stats?.travel;
    if (!travel?.to || !travel?.arrivalAt) return null;
    const isLegacyGiranMarketTrip = travel.townName === 'Giran'
        && ['market_sale_inventory', 'market_search_for_weapon', 'market_search_for_gear'].includes(travel.reason)
        && travel.method !== 'soe_gatekeeper';
    // Cold bots model the native SoE/gatekeeper sequence as a short transit,
    // not a visible straight-line cross-continent walk.  They remain at the
    // origin while casting/transiting and appear only at the destination.
    const nativeTransit = ['soe_gatekeeper', 'gatekeeper_spot'].includes(travel.method)
        // Routes persisted before native cold travel had no method.  Treat the
        // known long-distance lifecycle reasons as native too, so a restart
        // does not leave old craft/market travellers visibly map-walking.
        || ['component_craft', 'component_craft_return', 'equipment_craft', 'equipment_craft_return', 'dual_sword_combine', 'dual_sword_combine_return', 'return_after_market'].includes(travel.reason);
    const startedAt = Number(travel.startedAt || timestamp);
    const arrivalAt = Number(travel.arrivalAt);
    const progress = isLegacyGiranMarketTrip ? 1 : nativeTransit
        ? (timestamp >= arrivalAt ? 1 : 0)
        : Math.max(0, Math.min(1, (timestamp - startedAt) / Math.max(1, arrivalAt - startedAt)));
    const from = travel.from || state.loc || {};
    const to = travel.to;
    const loc = {
        locX: Math.round(Number(from.locX || 0) + (Number(to.locX || 0) - Number(from.locX || 0)) * progress),
        locY: Math.round(Number(from.locY || 0) + (Number(to.locY || 0) - Number(from.locY || 0)) * progress),
        locZ: Math.round(Number(from.locZ || 0) + (Number(to.locZ || 0) - Number(from.locZ || 0)) * progress)
    };
    const arrived = progress >= 1;
    const arrivalActivity = travel.arrivalActivity || 'shopping';
    const nextStats = { ...(state.stats || {}), travel: arrived ? null : travel };
    if (arrived && travel.clearMarketReturn) nextStats.marketReturn = null;
    return {
        patch: {
            activity: arrived ? arrivalActivity : 'traveling',
            loc,
            currentRegion: arrived ? travel.regionName || travel.townName || state.currentRegion : state.currentRegion,
            spotId: arrived && travel.spotId ? travel.spotId : state.spotId,
            stats: nextStats
        },
        events: arrived ? [{
            type: travel.arrivalEvent || (arrivalActivity === 'crafting' ? 'arrived_craft_station' : 'arrived_town'),
            summary: arrivalActivity === 'shopping'
                ? `${state.name || 'Bot'} used SoE via ${travel.viaTown || 'town'} and reached ${travel.townName || 'town'} to shop`
                : arrivalActivity === 'crafting'
                    ? `${state.name || 'Bot'} arrived at ${travel.stationId || 'a Giran craft station'} via SoE and gatekeeper`
                    : `${state.name || 'Bot'} reached ${travel.regionName || 'the hunting area'} via gatekeeper`,
            weight: 2,
            meta: { townName: travel.townName || null, stationId: travel.stationId || null, reason: travel.reason || null }
        }] : [],
        materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        // Until arrival nothing changes.  On arrival, schedule the finite
        // shopping/crafting transition for the next scheduler pass instead of
        // parking the bot for another arbitrary polling interval.
        nextResolveAt: arrived && ['shopping', 'crafting'].includes(arrivalActivity)
            ? timestamp
            : arrived ? timestamp + 30000 : arrivalAt,
        debug: { activity: 'traveling', arrived, progress, townName: travel.townName || null, arrivalActivity }
    };
}

function staleShopping(state) {
    return state?.activity === 'shopping'
        && !state.stats?.marketReturn
        && !state.stats?.supplyErrand
        && state.currentRegion !== 'Giran';
}

function resolveDeathRecovery(state, timestamp = Date.now()) {
    const combat = botCombatStats(state, timestamp);
    const respawnDelayMs = 90000;

    return {
        patch: {
            activity: 'resting',
            vitals: {
                hp: combat.maxHp,
                maxHp: combat.maxHp,
                mp: combat.maxMp,
                maxMp: combat.maxMp
            },
            stats: {
                ...(state.stats || {}),
                lastRespawnAt: timestamp,
                restUntil: timestamp + respawnDelayMs,
                coldCombat: {
                    ...(state.stats?.coldCombat || {}),
                    charges: 0,
                    chargeExpiresAt: null,
                    summon: null
                }
            }
        },
        events: [{
            type: 'respawn',
            summary: `${state.name || 'Bot'} recovered after dying near ${state.currentRegion || 'the hunting area'}`,
            weight: 2,
            meta: { spotId: state.spotId || null }
        }],
        materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        nextResolveAt: timestamp + respawnDelayMs,
        debug: { activity: 'respawning', respawnDelayMs }
    };
}

function hitSucceeds(accuracy, evasion, rng) {
    const chance = clamp((80 + (2 * (Number(accuracy) - Number(evasion)))) / 100, 0.2, 0.98);
    return rng() < chance;
}

function actionDelayMs(profile, skill = null) {
    if (skill?.spell) {
        return Math.max(250, Formulas.calcRemoteAtkTime(Math.max(1, Number(skill.hitTime) || 1000), profile.castSpd));
    }
    if (skill) {
        return Math.max(250, Formulas.calcRemoteAtkTime(Math.max(1, Number(skill.hitTime) || 600), profile.atkSpd));
    }
    return Math.max(250, Formulas.calcMeleeAtkTime(profile.atkSpd));
}

function effectiveSkillPower(profile, skill, hp) {
    const basePower = Number(skill?.power) || 0;
    return C4SkillRules.resolve(skill || {}).skillType === C4SkillRules.FATAL
        ? Formulas.calcFatalPower(basePower, hp, profile.maxHp)
        : basePower;
}

function chooseSkill(profile, hp, mp, cooldowns, time, charges = 0) {
    return ColdCombatProfile.offensiveSkills(profile)
        .filter((skill) => {
            const requiredCharges = Math.max(0, Number(C4SkillRules.resolve(skill).requires?.charges) || 0);
            return Number(skill.mp || 0) <= mp
                && Number(cooldowns[skill.selfId] || 0) <= time
                && requiredCharges <= charges;
        })
        .map((skill) => {
            const semantic = C4SkillRules.resolve(skill);
            const magic = skill.spell === true;
            const power = effectiveSkillPower(profile, skill, hp);
            let rawDamage = magic
                ? Formulas.calcMagicDamage(profile.mAtk, Math.max(1, power), 1)
                : Formulas.calcPhysicalDamage(profile.pAtk, profile.equipment.pAtkRnd, 1, power);
            const requiredCharges = Math.max(0, Number(semantic.requires?.charges) || 0);
            if (requiredCharges > 0) rawDamage *= 0.8 + (0.201 * charges);
            return { skill, magic, power, score: rawDamage / actionDelayMs(profile, skill) };
        })
        .sort((a, b) => b.score - a.score)[0] || null;
}

function chooseChargeSkill(profile, mp, cooldowns, time, charges = 0) {
    const needed = ColdCombatProfile.offensiveSkills(profile).reduce((maximum, skill) => (
        Math.max(maximum, Number(C4SkillRules.resolve(skill).requires?.charges) || 0)
    ), 0);
    if (needed <= charges) return null;
    return (profile.skills || []).filter((skill) => {
        const semantic = C4SkillRules.resolve(skill);
        const requiredWeapon = Number(semantic.requires?.weaponsAllowed) || 0;
        return !skill.passive
            && semantic.skillType === C4SkillRules.CHARGE
            && Number(skill.mp || 0) <= mp
            && Number(cooldowns[skill.selfId] || 0) <= time
            && (!requiredWeapon || (requiredWeapon & profile.weaponMask) !== 0);
    }).sort((a, b) => Number(b.level || 0) - Number(a.level || 0))[0] || null;
}

function activeMusicEffectForSkill(profile, skill, timestamp) {
    const skillId = Number(skill.selfId) || 0;
    const semantic = C4SkillRules.resolve(skill);
    return (profile.effects || []).some((effect) => (
        effect
        && effect.type !== 'debuff'
        && effect.toggle !== true
        && (!effect.expiresAt || Number(effect.expiresAt) > timestamp)
        && (Number(effect.id) === skillId || effect.key === semantic.effect)
    ));
}

function actorLocation(state = {}) {
    return state.loc || state.location || state;
}

function withinSkillRadius(source, target, semantic) {
    const radius = Math.max(0, Number(semantic.radius) || 0);
    if (!radius) return true;
    const sourceLoc = actorLocation(source.state);
    const targetLoc = actorLocation(target.state);
    const coordinates = ['locX', 'locY'].map((key) => [Number(sourceLoc?.[key]), Number(targetLoc?.[key])]);
    if (coordinates.some(([from, to]) => !Number.isFinite(from) || !Number.isFinite(to))) return true;
    const dx = coordinates[0][0] - coordinates[0][1];
    const dy = coordinates[1][0] - coordinates[1][1];
    return (dx * dx) + (dy * dy) <= radius * radius;
}

function chooseMusicAction(provider, targets, timestamp) {
    const skill = ColdCombatProfile.partyMusicSkills(provider.profile)
        .map((candidate) => {
            const semantic = C4SkillRules.resolve(candidate);
            const affected = targets.filter((target) => target.vitals.hp > 0
                && withinSkillRadius(provider, target, semantic)
                && !activeMusicEffectForSkill(target.profile, candidate, timestamp));
            return {
                skill: candidate,
                affected,
                cost: ColdCombatProfile.partyMusicMpCost(provider.profile, candidate, timestamp)
            };
        })
        .filter((candidate) => candidate.cost <= provider.vitals.mp && candidate.affected.length > 0)
        .sort((a, b) => Number(a.skill.selfId) - Number(b.skill.selfId))[0];
    return skill || null;
}

function replaceMusicEffect(effects, nextEffect) {
    return [
        ...(effects || []).filter((effect) => Number(effect.id) !== Number(nextEffect.id) && effect.key !== nextEffect.key),
        nextEffect
    ];
}

function refreshFighterProfile(fighter, effects, timestamp) {
    const coldCombat = {
        ...(fighter.state.stats?.coldCombat || {}),
        classId: fighter.profile.classId,
        skills: fighter.profile.skills,
        effects
    };
    fighter.state = {
        ...fighter.state,
        stats: { ...(fighter.state.stats || {}), coldCombat }
    };
    const hp = fighter.vitals.hp;
    const mp = fighter.vitals.mp;
    fighter.profile = botCombatStats(fighter.state, timestamp);
    fighter.vitals.maxHp = fighter.profile.maxHp;
    fighter.vitals.maxMp = fighter.profile.maxMp;
    fighter.vitals.hp = Math.min(hp, fighter.vitals.maxHp);
    fighter.vitals.mp = Math.min(mp, fighter.vitals.maxMp);
}

function applyMusicAction(provider, action, timestamp) {
    if (!action?.affected?.length) return 0;
    const effect = ColdCombatProfile.partyMusicEffect(action.skill, timestamp);
    const semantic = C4SkillRules.resolve(action.skill);
    const targets = action.affected.length === 1 && action.affected[0] === provider
        ? action.affected
        : [provider, ...action.affected.filter((target) => target !== provider)];
    targets.filter((target) => target.vitals.hp > 0 && withinSkillRadius(provider, target, semantic))
        .forEach((target) => refreshFighterProfile(target, replaceMusicEffect(target.profile.effects, effect), timestamp));
    return action.cost;
}

function mutableCombatState(state = {}) {
    return {
        ...state,
        inventory: Object.fromEntries(Object.entries(state.inventory || {}).map(([key, item]) => [key, { ...item }])),
        stats: {
            ...(state.stats || {}),
            coldCombat: { ...(state.stats?.coldCombat || {}) }
        }
    };
}

function applyColdPotionTicks(fighter, time) {
    const hot = fighter?.potionHot;
    if (!hot) return 0;
    let healed = 0;
    while (hot.remaining > 0 && hot.nextAt <= time) {
        const before = fighter.vitals.hp;
        fighter.vitals.hp = Math.min(fighter.vitals.maxHp, fighter.vitals.hp + hot.heal);
        healed += fighter.vitals.hp - before;
        hot.remaining -= 1;
        hot.nextAt += hot.intervalMs;
    }
    if (hot.remaining <= 0) fighter.potionHot = null;
    return healed;
}

function startColdPotion(fighter, time) {
    if (!fighter || fighter.potionsUsed > 0 || fighter.potionHot) return null;
    const potion = HealingPotionStock.consumeColdPotion(
        fighter.state.inventory,
        fighter.vitals.hp,
        fighter.vitals.maxHp,
        fighter.state
    );
    if (!potion) return null;
    const effect = HealingPotionStock.coldEffectFor(potion, time);
    fighter.vitals.hp = Math.min(fighter.vitals.maxHp, fighter.vitals.hp + Number(effect.immediateHeal || 0));
    fighter.potionHot = effect.hot;
    fighter.potionsUsed = Number(fighter.potionsUsed || 0) + 1;
    return potion;
}

function summonNpcStats(fighter, details) {
    const direct = (DataCache.npcs || []).find((entry) => Number(entry.selfId) === Number(details.npcId));
    const skill = (DataCache.skills || []).find((entry) => Number(entry.selfId) === Number(details.skillId));
    const skillLevel = Number(details.skillLevel || 1);
    const levelCandidates = (skill?.levels || [])
        .map((level) => ({
            level: Number(level.level) || 0,
            npc: (DataCache.npcs || []).find((entry) => Number(entry.selfId) === Number(level.npcId))
        }))
        .filter((entry) => entry.npc)
        .sort((a, b) => Math.abs(a.level - skillLevel) - Math.abs(b.level - skillLevel));
    const summonName = String(skill?.template?.name || skill?.name || '').toLowerCase();
    const fallbackIds = summonName.includes('soulless') || summonName.includes('reanimated')
        || summonName.includes('corrupted') || summonName.includes('cursed man')
        ? [12070, 12366, 12071, 12367]
        : [];
    const familyFallback = fallbackIds
        .map((id) => (DataCache.npcs || []).find((entry) => Number(entry.selfId) === id))
        .find(Boolean);
    const npc = direct || levelCandidates[0]?.npc || familyFallback;
    return {
        npcId: Number(details.npcId || 0),
        maxHp: Math.max(1, Number(npc?.vitals?.maxHp || fighter.profile.maxHp * 1.15)),
        pAtk: Math.max(1, Number(npc?.stats?.pAtk || fighter.profile.pAtk * 0.85)),
        pAtkRnd: Math.max(0, Number(npc?.stats?.pAtkRnd || fighter.profile.equipment?.pAtkRnd || 0)),
        pDef: Math.max(1, Number(npc?.stats?.pDef || fighter.profile.pDef * 0.8)),
        accur: Math.max(1, Number(npc?.stats?.accur || fighter.profile.accur)),
        critical: Math.max(0, Number(npc?.stats?.crit || fighter.profile.critical)),
        atkSpd: Math.max(1, Number(npc?.stats?.atkSpd || fighter.profile.atkSpd))
    };
}

function persistedSummon(fighter, timestamp) {
    const saved = fighter.state.stats?.coldCombat?.summon;
    if (!saved?.active || Number(saved.expiresAt || 0) <= timestamp) return null;
    const skill = (fighter.profile.skills || []).find((candidate) => Number(candidate.selfId) === Number(saved.skillId));
    const details = ColdCombatProfile.summonDetails(skill || saved);
    const npcStats = summonNpcStats(fighter, details);
    const savedHp = Number(saved.hp || 0);
    return {
        ...saved,
        ...npcStats,
        skillId: Number(saved.skillId || skill?.selfId || 0),
        expiresAt: Number(saved.expiresAt),
        hp: Math.min(npcStats.maxHp, Math.max(1, savedHp || npcStats.maxHp)),
        maxHp: npcStats.maxHp
    };
}

function setPersistedSummon(fighter, summon) {
    fighter.state = {
        ...fighter.state,
        stats: {
            ...(fighter.state.stats || {}),
            coldCombat: {
                ...(fighter.state.stats?.coldCombat || {}),
                summon: summon || null
            }
        }
    };
}

function summonAttackDelay(summon) {
    return Math.max(250, Formulas.calcMeleeAtkTime(Number(summon?.atkSpd) || 253));
}

function startColdSummon(fighter, timestamp, cooldowns, skills = ColdCombatProfile.summonSkills(fighter.profile)) {
    const skill = skills.find((candidate) => (
        Number(cooldowns[candidate.selfId] || 0) <= timestamp
        && Number(candidate.mp || 0) <= fighter.vitals.mp
    ));
    if (!skill) return false;

    const details = ColdCombatProfile.summonDetails(skill);
    fighter.vitals.mp = Math.max(0, fighter.vitals.mp - Number(skill.mp || 0));
    const totalLifeTime = Math.max(30000, Number(details.totalLifeTime || 1200000));
    const summon = {
        ...summonNpcStats(fighter, details),
        active: true,
        skillId: Number(skill.selfId),
        expiresAt: timestamp + totalLifeTime
    };
    setPersistedSummon(fighter, summon);
    fighter.summon = summon;
    fighter.summonUses = Number(fighter.summonUses || 0) + 1;
    cooldowns[skill.selfId] = timestamp + Math.max(0, Number(skill.reuse || 0));
    fighter.readyAt = Number(fighter.readyAt || 0) + actionDelayMs(fighter.profile, skill);
    fighter.summonReadyAt = fighter.readyAt + summonAttackDelay(summon);
    return true;
}

function startColdCorpseSummon(fighter, timestamp, cooldowns) {
    if (!BotRoles.isNecromancer(fighter.profile?.classId) || fighter.summon) return false;
    const persisted = persistedSummon(fighter, timestamp);
    if (persisted) {
        const sameActiveSummon = fighter.summon?.active === true
            && Number(fighter.summon.skillId) === Number(persisted.skillId)
            && Number(fighter.summon.expiresAt) === Number(persisted.expiresAt);
        fighter.summon = persisted;
        if (!sameActiveSummon) {
            fighter.summonReadyAt = Number(fighter.readyAt || 0) + summonAttackDelay(persisted);
        }
        return false;
    }
    return startColdSummon(
        fighter,
        timestamp,
        cooldowns,
        ColdCombatProfile.corpseSummonSkills(fighter.profile)
    );
}

function ensureColdSummon(fighter, timestamp, cooldowns) {
    const existing = persistedSummon(fighter, timestamp);
    if (existing) {
        const sameActiveSummon = fighter.summon?.active === true
            && Number(fighter.summon.skillId) === Number(existing.skillId)
            && Number(fighter.summon.expiresAt) === Number(existing.expiresAt);
        fighter.summon = existing;
        if (!sameActiveSummon) {
            fighter.summonReadyAt = Number(fighter.readyAt || 0) + summonAttackDelay(existing);
        }
        return false;
    }
    if (fighter.state.stats?.coldCombat?.summon?.active) setPersistedSummon(fighter, null);
    fighter.summon = null;
    return startColdSummon(fighter, timestamp, cooldowns);
}

function summonDamage(fighter, mob, rng) {
    const summon = fighter.summon;
    if (!summon?.active || Number(summon.expiresAt || 0) <= Number(fighter.now || 0)) return 0;
    if (!hitSucceeds(summon.accur, mob.evasion, rng)) return 0;
    return Math.max(0, Formulas.calcPhysicalDamage(
        summon.pAtk,
        summon.pAtkRnd,
        mob.pDef,
        0,
        { critical: Formulas.rollCritical(summon.critical, rng) }
    ));
}

function resolveFight({ state, spot, pressure, targetNpcId = 0, rng, timestamp = Date.now() }) {
    const fightState = mutableCombatState(state);
    let bot = botCombatStats(fightState, timestamp);
    const mob = ColdCombatProfile.npcForSpot(spot, rng, { preferredNpcId: targetNpcId }) || {
        level: Number(spot.avgLevel || bot.level), maxHp: Math.max(1, Number(spot.mob?.hp || 1)),
        pAtk: Math.max(1, Number(spot.mob?.damage || 1)), pAtkRnd: 0, pDef: 1, mDef: 1,
        accur: 1, evasion: 0, critical: 0, atkSpd: 253, mAtk: 1, castSpd: 333
    };
    const vitals = {
        hp: Number(state.vitals?.hp ?? bot.maxHp),
        mp: Number(state.vitals?.mp ?? bot.maxMp),
        maxHp: bot.maxHp,
        maxMp: bot.maxMp
    };
    const soloFighter = {
        state: fightState,
        profile: bot,
        role: BotRoles.inferRole(fightState),
        vitals,
        readyAt: 0,
        summonReadyAt: Number.POSITIVE_INFINITY,
        summonUses: 0,
        summonActions: 0,
        now: timestamp,
        potionsUsed: 0,
        potionHot: null
    };
    let botReadyAt = 0;
    let mobReadyAt = 0;
    let time = 0;
    let mobHp = mob.maxHp;
    let actions = 0;
    let skillUses = 0;
    let musicUses = 0;
    let summonUses = 0;
    let summonActions = 0;
    const chargeState = coldChargeState(state, timestamp);
    let charges = chargeState.charges;
    let chargeExpiresAt = chargeState.chargeExpiresAt;
    const cooldowns = { ...(state.stats?.coldCombat?.cooldowns || {}) };
    const fightLimitMs = 12000;

    // A resolve contains only a handful of fights, and a fight itself is
    // bounded by time and actions. This is deliberately cheaper than a live
    // Actor while retaining its hit, critical, damage and speed formulas.
    while (vitals.hp > 0 && mobHp > 0 && time < fightLimitMs && actions < 48) {
        const summonReadyAt = soloFighter.summon?.active
            ? Number(soloFighter.summonReadyAt)
            : Number.POSITIVE_INFINITY;
        const summonActs = summonReadyAt <= botReadyAt && summonReadyAt <= mobReadyAt;
        const botActs = !summonActs && botReadyAt <= mobReadyAt;
        time = summonActs ? summonReadyAt : botActs ? botReadyAt : mobReadyAt;
        if (time >= fightLimitMs) break;
        applyColdPotionTicks(soloFighter, time);
        actions += 1;

        if (summonActs) {
            soloFighter.now = timestamp + time;
            if (Number(soloFighter.summon.expiresAt || 0) <= soloFighter.now) {
                setPersistedSummon(soloFighter, null);
                soloFighter.summon = null;
                soloFighter.summonReadyAt = Number.POSITIVE_INFINITY;
                continue;
            }
            mobHp -= summonDamage(soloFighter, mob, rng);
            summonActions += 1;
            soloFighter.summonActions += 1;
            soloFighter.summonReadyAt = time + summonAttackDelay(soloFighter.summon);
            if (mobHp <= 0) break;
        }
        else if (botActs) {
            soloFighter.now = timestamp + time;
            soloFighter.readyAt = botReadyAt;
            const summonedNow = ensureColdSummon(soloFighter, timestamp + time, cooldowns);
            summonUses = Number(soloFighter.summonUses || 0);
            if (summonedNow) {
                botReadyAt = soloFighter.readyAt;
                continue;
            }
            const heldCharges = { charges, chargeExpiresAt };
            expireCharges(heldCharges, timestamp + time);
            charges = heldCharges.charges;
            chargeExpiresAt = heldCharges.chargeExpiresAt;
            if (startColdPotion(soloFighter, time)) {
                botReadyAt += 250;
                continue;
            }
            const music = chooseMusicAction(soloFighter, [soloFighter], timestamp + time);
            if (music) {
                applyMusicAction(soloFighter, music, timestamp + time);
                bot = soloFighter.profile;
                vitals.mp = Math.max(0, vitals.mp - music.cost);
                cooldowns[music.skill.selfId] = timestamp + time + Math.max(0, Number(music.skill.reuse || 0));
                skillUses += 1;
                musicUses += 1;
                botReadyAt += actionDelayMs(bot, music.skill);
                continue;
            }
            const chargeSkill = chooseChargeSkill(bot, vitals.mp, cooldowns, timestamp + time, charges);
            if (chargeSkill) {
                const semantic = C4SkillRules.resolve(chargeSkill);
                const nextCharges = { charges, chargeExpiresAt };
                addCharges(nextCharges, 1, semantic.maxCharges, timestamp + time);
                charges = nextCharges.charges;
                chargeExpiresAt = nextCharges.chargeExpiresAt;
                vitals.mp = Math.max(0, vitals.mp - Number(chargeSkill.mp || 0));
                cooldowns[chargeSkill.selfId] = timestamp + time + Math.max(0, Number(chargeSkill.reuse || 0));
                skillUses += 1;
                botReadyAt += actionDelayMs(bot, chargeSkill);
                continue;
            }
            const selected = chooseSkill(bot, vitals.hp, vitals.mp, cooldowns, timestamp + time, charges);
            const skill = selected?.skill || null;
            const magic = selected?.magic === true;
            let damage = 0;
            if (magic) {
                const magicCritical = rng() < clamp(bot.critical / 1000, 0, 0.25);
                const semantic = C4SkillRules.resolve(selected.skill);
                damage = Formulas.calcMagicDamage(bot.mAtk, Math.max(1, selected.power), mob.mDef, { magicCritical })
                    * coldMagicTargetModifier(mob, semantic);
            } else if (hitSucceeds(bot.accur, mob.evasion, rng)) {
                const critical = Formulas.rollCritical(bot.critical, rng);
                const semantic = selected?.skill ? C4SkillRules.resolve(selected.skill) : {};
                damage = Formulas.calcPhysicalDamage(bot.pAtk, bot.equipment.pAtkRnd, mob.pDef, selected?.power || 0, { critical })
                    * coldPhysicalTargetModifier(bot, mob, semantic, timestamp + time);
            }
            if (skill) {
                const semantic = C4SkillRules.resolve(skill);
                const requiredCharges = Math.max(0, Number(semantic.requires?.charges) || 0);
                if (requiredCharges > 0) damage *= 0.8 + (0.201 * charges);
                const nextCharges = { charges, chargeExpiresAt };
                consumeCharges(nextCharges, semantic.requires?.charges);
                if (Number(semantic.chargeOnUse) > 0) {
                    addCharges(nextCharges, semantic.chargeOnUse, semantic.maxCharges, timestamp + time);
                }
                charges = nextCharges.charges;
                chargeExpiresAt = nextCharges.chargeExpiresAt;
                vitals.mp = Math.max(0, vitals.mp - Number(skill.mp || 0));
                cooldowns[skill.selfId] = timestamp + time + Math.max(0, Number(skill.reuse || 0));
                skillUses += 1;
            }
            mobHp -= Math.max(0, damage);
            botReadyAt += actionDelayMs(bot, skill);
            if (mobHp <= 0) {
                soloFighter.readyAt = botReadyAt;
                startColdCorpseSummon(soloFighter, timestamp + time, cooldowns);
                summonUses = Number(soloFighter.summonUses || 0);
                break;
            }
        } else if (hitSucceeds(mob.accur, bot.evasion, rng)) {
            const critical = Formulas.rollCritical(mob.critical, rng);
            const damage = Formulas.calcMeleeDamage(mob.pAtk, mob.pAtkRnd, bot.pDef, { critical })
                * coldNpcWeaponModifier(mob, bot, timestamp + time);
            vitals.hp -= Math.max(0, damage);
            mobReadyAt += Math.max(250, Formulas.calcMeleeAtkTime(mob.atkSpd));
        } else {
            mobReadyAt += Math.max(250, Formulas.calcMeleeAtkTime(mob.atkSpd));
        }
    }

    // Background time jumps past the quiet tail of a completed potion HoT.
    // Apply that tail only after the damage sequence and only to survivors.
    if (vitals.hp > 0) applyColdPotionTicks(soloFighter, Number.MAX_SAFE_INTEGER);

    const died = vitals.hp <= 0;
    const won = mobHp <= 0;
    if (!won) {
        return {
            won: false,
            died,
            hp: Math.max(0, Math.round(vitals.hp)),
            maxHp: Math.max(1, Math.round(vitals.maxHp)),
            mp: Math.max(0, Math.round(vitals.mp)),
            maxMp: Math.max(1, Math.round(vitals.maxMp)),
            exp: 0,
            sp: 0,
            adena: 0,
            loot: [],
            cooldowns,
            charges: died ? 0 : charges,
            chargeExpiresAt: died ? null : chargeExpiresAt,
            effects: soloFighter.profile.effects,
            inventory: fightState.inventory,
            summon: soloFighter.summon || null,
            debug: { actions, skillUses, musicUses, summonUses, summonActions, potionsUsed: soloFighter.potionsUsed, mobSelfId: mob.selfId || null, timedOut: !died }
        };
    }

    const rewards = BackgroundDropResolver.progressionForFight({ spot, npcSelfId: mob.selfId, rng });
    const expMultiplier = pressure?.expMultiplier || 1;
    const rates = ProgressionRates.profile();
    const rolledRewards = BackgroundDropResolver.rollRewardsForFight({
        spot,
        killerLevel: Number(state.level || bot.level),
        npcSelfId: mob.selfId,
        rng
    });
    const adena = rolledRewards === null
        ? Math.round(randInt(rng, spot.rewards.adenaMin, spot.rewards.adenaMax) * rates.adena)
        : rolledRewards.adena;
    const loot = rolledRewards?.items || [];
    if (String(state.stats?.role || '') === 'spoiler'
        || [54, 55].includes(Number(state.stats?.classId ?? state.classId))) {
        loot.push(...BackgroundDropResolver.rollSpoilForFight({
            spot,
            killerLevel: Number(state.level || bot.level),
            npcSelfId: mob.selfId,
            rng
        }));
    }

    return {
        won: true,
        died: false,
        hp: Math.max(1, Math.round(vitals.hp)),
        maxHp: Math.max(1, Math.round(vitals.maxHp)),
        mp: Math.max(0, Math.round(vitals.mp)),
        maxMp: Math.max(1, Math.round(vitals.maxMp)),
        exp: Math.round(rewards.exp * expMultiplier * rates.exp
            * ColdCombatProfile.statMultiplier(bot, 'expMul', timestamp)),
        sp: Math.round(rewards.sp * expMultiplier * rates.sp),
        adena,
        loot,
        cooldowns,
        charges,
        chargeExpiresAt,
        effects: soloFighter.profile.effects,
        inventory: fightState.inventory,
        summon: soloFighter.summon || null,
        debug: { actions, skillUses, musicUses, summonUses, summonActions, potionsUsed: soloFighter.potionsUsed, mobSelfId: mob.selfId || null, timedOut: false }
    };
}

function chooseHeal(profile, allies, mp, cooldowns, time) {
    const injured = allies.filter((ally) => ally.vitals.hp > 0 && ally.vitals.hp / Math.max(1, ally.vitals.maxHp) < 0.7)
        .sort((a, b) => (a.vitals.hp / a.vitals.maxHp) - (b.vitals.hp / b.vitals.maxHp))[0];
    if (!injured) return null;
    const skill = (profile.skills || []).filter((candidate) => {
        if (candidate.passive || Number(candidate.mp || 0) > mp || Number(cooldowns[candidate.selfId] || 0) > time) return false;
        const semantic = C4SkillRules.resolve(candidate);
        return [C4SkillRules.HEAL, C4SkillRules.HEAL_PERCENT].includes(semantic.skillType)
            && ['self', 'party', 'ally', 'friendly'].includes(semantic.target);
    }).sort((a, b) => Number(b.power || 0) - Number(a.power || 0))[0];
    return skill ? { skill, target: injured } : null;
}

function resolvePartyFight({ members, spot, targetNpcId = 0, rng = Math.random, timestamp = Date.now() }) {
    const mob = ColdCombatProfile.npcForSpot(spot, rng, { preferredNpcId: targetNpcId }) || {
        level: Number(spot.avgLevel || 1), maxHp: Math.max(1, Number(spot.mob?.hp || 1)),
        pAtk: Math.max(1, Number(spot.mob?.damage || 1)), pAtkRnd: 0, pDef: 1, mDef: 1,
        accur: 1, evasion: 0, critical: 0, atkSpd: 253
    };
    const fighters = members.map((state) => {
        const fighterState = mutableCombatState(state);
        const profile = botCombatStats(fighterState, timestamp);
        const chargeState = coldChargeState(fighterState, timestamp);
        return {
            state: fighterState,
            profile,
            role: fighterState.party?.role || fighterState.stats?.role || 'dps',
            vitals: {
                hp: Math.min(profile.maxHp, Math.max(0, Number(state.vitals?.hp ?? profile.maxHp))),
                maxHp: profile.maxHp,
                mp: Math.min(profile.maxMp, Math.max(0, Number(state.vitals?.mp ?? profile.maxMp))),
                maxMp: profile.maxMp
            },
            cooldowns: { ...(state.stats?.coldCombat?.cooldowns || {}) },
            readyAt: 0,
            actions: 0,
            skillUses: 0,
            heals: 0,
            musicUses: 0,
            charges: chargeState.charges,
            chargeExpiresAt: chargeState.chargeExpiresAt,
            summonUses: 0,
            summonActions: 0,
            summonReadyAt: Number.POSITIVE_INFINITY,
            potionsUsed: 0,
            potionHot: null,
            now: timestamp
        };
    });
    let mobHp = mob.maxHp;
    let mobReadyAt = 0;
    let time = 0;
    let actions = 0;
    const fightLimitMs = 15000;

    while (mobHp > 0 && fighters.some((fighter) => fighter.vitals.hp > 0) && time < fightLimitMs && actions < 96) {
        const alive = fighters.filter((fighter) => fighter.vitals.hp > 0);
        const next = alive.sort((a, b) => a.readyAt - b.readyAt)[0];
        const nextSummon = alive
            .filter((fighter) => fighter.summon?.active && Number.isFinite(Number(fighter.summonReadyAt)))
            .sort((a, b) => a.summonReadyAt - b.summonReadyAt)[0];
        const ownerReadyAt = next ? next.readyAt : Number.POSITIVE_INFINITY;
        const summonReadyAt = nextSummon ? Number(nextSummon.summonReadyAt) : Number.POSITIVE_INFINITY;
        const summonActs = nextSummon && summonReadyAt <= ownerReadyAt && summonReadyAt <= mobReadyAt;
        const botActs = !summonActs && next && ownerReadyAt <= mobReadyAt;
        time = summonActs ? summonReadyAt : botActs ? ownerReadyAt : mobReadyAt;
        if (time >= fightLimitMs) break;
        fighters.forEach((fighter) => applyColdPotionTicks(fighter, time));
        actions += 1;

        if (summonActs) {
            nextSummon.now = timestamp + time;
            if (Number(nextSummon.summon.expiresAt || 0) <= nextSummon.now) {
                setPersistedSummon(nextSummon, null);
                nextSummon.summon = null;
                nextSummon.summonReadyAt = Number.POSITIVE_INFINITY;
                continue;
            }
            mobHp -= summonDamage(nextSummon, mob, rng);
            nextSummon.summonActions += 1;
            nextSummon.summonReadyAt = time + summonAttackDelay(nextSummon.summon);
            if (mobHp <= 0) break;
        }
        else if (botActs) {
            next.actions += 1;
            expireCharges(next, timestamp + time);
            next.now = timestamp + time;
            const summonedNow = ensureColdSummon(next, timestamp + time, next.cooldowns);
            if (summonedNow) continue;
            if (startColdPotion(next, time)) {
                next.readyAt += 250;
                continue;
            }
            const heal = chooseHeal(next.profile, fighters, next.vitals.mp, next.cooldowns, timestamp + time);
            if (heal) {
                const amount = Formulas.calcHealAmount(heal.skill.power);
                heal.target.vitals.hp = Math.min(heal.target.vitals.maxHp, heal.target.vitals.hp + amount);
                next.vitals.mp = Math.max(0, next.vitals.mp - Number(heal.skill.mp || 0));
                next.cooldowns[heal.skill.selfId] = timestamp + time + Math.max(0, Number(heal.skill.reuse || 0));
                next.skillUses += 1;
                next.heals += 1;
                next.readyAt += actionDelayMs(next.profile, heal.skill);
                continue;
            }

            const music = chooseMusicAction(next, fighters, timestamp + time);
            if (music) {
                applyMusicAction(next, music, timestamp + time);
                next.vitals.mp = Math.max(0, next.vitals.mp - music.cost);
                next.cooldowns[music.skill.selfId] = timestamp + time + Math.max(0, Number(music.skill.reuse || 0));
                next.skillUses += 1;
                next.musicUses += 1;
                next.readyAt += actionDelayMs(next.profile, music.skill);
                continue;
            }

            const chargeSkill = chooseChargeSkill(next.profile, next.vitals.mp, next.cooldowns, timestamp + time, next.charges);
            if (chargeSkill) {
                const semantic = C4SkillRules.resolve(chargeSkill);
                addCharges(next, 1, semantic.maxCharges, timestamp + time);
                next.vitals.mp = Math.max(0, next.vitals.mp - Number(chargeSkill.mp || 0));
                next.cooldowns[chargeSkill.selfId] = timestamp + time + Math.max(0, Number(chargeSkill.reuse || 0));
                next.skillUses += 1;
                next.readyAt += actionDelayMs(next.profile, chargeSkill);
                continue;
            }
            const selected = chooseSkill(next.profile, next.vitals.hp, next.vitals.mp, next.cooldowns, timestamp + time, next.charges);
            const skill = selected?.skill || null;
            let damage = 0;
            if (selected?.magic) {
                const magicCritical = rng() < clamp(next.profile.critical / 1000, 0, 0.25);
                const semantic = C4SkillRules.resolve(selected.skill);
                damage = Formulas.calcMagicDamage(next.profile.mAtk, Math.max(1, selected.power), mob.mDef, { magicCritical })
                    * coldMagicTargetModifier(mob, semantic);
            } else if (hitSucceeds(next.profile.accur, mob.evasion, rng)) {
                const semantic = selected?.skill ? C4SkillRules.resolve(selected.skill) : {};
                damage = Formulas.calcPhysicalDamage(next.profile.pAtk, next.profile.equipment.pAtkRnd, mob.pDef, selected?.power || 0, {
                    critical: Formulas.rollCritical(next.profile.critical, rng)
                }) * coldPhysicalTargetModifier(next.profile, mob, semantic, timestamp + time);
            }
            if (skill) {
                const semantic = C4SkillRules.resolve(skill);
                const requiredCharges = Math.max(0, Number(semantic.requires?.charges) || 0);
                if (requiredCharges > 0) damage *= 0.8 + (0.201 * next.charges);
                consumeCharges(next, semantic.requires?.charges);
                if (Number(semantic.chargeOnUse) > 0) {
                    addCharges(next, semantic.chargeOnUse, semantic.maxCharges, timestamp + time);
                }
                next.vitals.mp = Math.max(0, next.vitals.mp - Number(skill.mp || 0));
                next.cooldowns[skill.selfId] = timestamp + time + Math.max(0, Number(skill.reuse || 0));
                next.skillUses += 1;
            }
            mobHp -= Math.max(0, damage);
            next.readyAt += actionDelayMs(next.profile, skill);
            if (mobHp <= 0) {
                const necromancer = fighters.find((fighter) => (
                    fighter.vitals.hp > 0
                    && BotRoles.isNecromancer(fighter.profile?.classId)
                    && !fighter.summon
                ));
                if (necromancer) {
                    startColdCorpseSummon(necromancer, timestamp + time, necromancer.cooldowns);
                }
                break;
            }
        } else {
            const targets = fighters.filter((fighter) => fighter.vitals.hp > 0);
            const tank = targets.find((fighter) => fighter.role === 'tank');
            const target = tank || targets[Math.floor(rng() * targets.length)];
            if (target && hitSucceeds(mob.accur, target.profile.evasion, rng)) {
                const damage = Formulas.calcMeleeDamage(mob.pAtk, mob.pAtkRnd, target.profile.pDef, {
                    critical: Formulas.rollCritical(mob.critical, rng)
                }) * coldNpcWeaponModifier(mob, target.profile, timestamp + time);
                target.vitals.hp = Math.max(0, target.vitals.hp - damage);
            }
            mobReadyAt += Math.max(250, Formulas.calcMeleeAtkTime(mob.atkSpd));
        }
    }

    fighters.filter((fighter) => fighter.vitals.hp > 0)
        .forEach((fighter) => applyColdPotionTicks(fighter, Number.MAX_SAFE_INTEGER));

    return {
        won: mobHp <= 0,
        timedOut: mobHp > 0 && fighters.some((fighter) => fighter.vitals.hp > 0),
        members: fighters,
        debug: {
            actions,
            skillUses: fighters.reduce((sum, fighter) => sum + fighter.skillUses, 0),
            musicUses: fighters.reduce((sum, fighter) => sum + fighter.musicUses, 0),
            summonUses: fighters.reduce((sum, fighter) => sum + Number(fighter.summonUses || 0), 0),
            summonActions: fighters.reduce((sum, fighter) => sum + Number(fighter.summonActions || 0), 0),
            potionsUsed: fighters.reduce((sum, fighter) => sum + Number(fighter.potionsUsed || 0), 0),
            mobSelfId: mob.selfId || null
        }
    };
}

const BackgroundResolver = {
    resolveRest,
    resolvePartyFight,
    needsRest,
    estimateRestMs,
    applyStandingRegen,
    effectiveSkillPower,
    resolveSolo({ state, spot, pressure = {}, targetNpcId = 0, elapsedMs = 60000, rng = Math.random, timestamp = Date.now() }) {
        if (!state) {
            return {
                patch: {},
                events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: timestamp + 60000,
                debug: { reason: 'missing_state_or_spot' }
            };
        }

        if (state.activity === 'traveling') {
            const travelResult = resolveTravel(state, timestamp);
            if (travelResult) return travelResult;
        }

        if (state.stats?.supplyErrand) {
            const expiresAt = Number(state.stats.supplyErrand.expiresAt || 0);
            if (expiresAt > 0 && timestamp >= expiresAt) {
                return {
                    patch: {
                        activity: 'hunting',
                        stats: {
                            ...(state.stats || {}),
                            supplyErrand: null,
                            lastReason: 'supply_errand_expired'
                        }
                    },
                    events: [{
                        type: 'supply_errand_expired',
                        summary: `${state.name || 'Bot'} abandoned an expired companion supply errand and resumed hunting`,
                        weight: 2
                    }],
                    materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                    nextResolveAt: timestamp + 30000,
                    debug: { activity: 'supply_errand_expired' }
                };
            }
            return {
                patch: { activity: 'shopping', stats: { ...(state.stats || {}) } },
                events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: timestamp + 30000,
                debug: { activity: 'supply_errand' }
            };
        }

        if (staleShopping(state) && spot) {
            return {
                patch: {
                    activity: 'hunting',
                    spotId: spot.id,
                    currentRegion: state.homeRegion || state.currentRegion,
                    loc: { ...spot.center },
                    stats: { ...(state.stats || {}), legacyShoppingRecoveredAt: timestamp }
                },
                events: [{
                    type: 'shopping_recovered',
                    summary: `${state.name || 'Bot'} left a stale town-shopping state and returned to hunting`,
                    weight: 1
                }],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: timestamp + 30000,
                debug: { activity: 'shopping_recovered' }
            };
        }

        if (state.activity === 'shopping') {
            return {
                patch: { activity: 'shopping' },
                events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: timestamp + 120000,
                debug: { activity: 'shopping' }
            };
        }

        if (state.activity === 'merchant') {
            return {
                patch: { activity: 'merchant' },
                events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: timestamp + 60000,
                debug: { activity: 'merchant' }
            };
        }

        if (state.activity === 'crafting') {
            return {
                patch: { activity: 'crafting' },
                events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: timestamp + 60000,
                debug: { activity: 'crafting' }
            };
        }

        const reportedHp = Number(state.vitals?.hp);
        if (state.activity === 'dead' || (Number.isFinite(reportedHp) && reportedHp <= 0)) {
            return resolveDeathRecovery(state, timestamp);
        }

        if (state.activity === 'resting') {
            return resolveRest(state, elapsedMs, timestamp);
        }

        if (!spot) {
            return {
                patch: {},
                events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: timestamp + 60000,
                debug: { reason: 'missing_spot' }
            };
        }

        const maxFights = Math.max(1, Math.floor(elapsedMs / 12000));
        const fights = Math.min(maxFights, Math.max(1, Math.ceil((spot.density || 1) / 3)));
        const events = [];
        const materialize = { exp: 0, sp: 0, adena: 0, items: [] };
        const patch = {
            vitals: applyStandingRegen(state, state.vitals, elapsedMs, timestamp),
            activity: 'hunting',
            spotId: spot.id
        };

        let wins = 0;
        let died = false;
        let combatActions = 0;
        let skillUses = 0;
        let musicUses = 0;
        let summonUses = 0;
        let summonActions = 0;
        let potionsUsed = 0;
        const foughtNpcIds = [];

        for (let i = 0; i < fights; i++) {
            const fightState = {
                ...state,
                vitals: patch.vitals,
                inventory: patch.inventory || state.inventory,
                stats: { ...(state.stats || {}), ...(patch.stats || {}) }
            };
            const result = resolveFight({ state: fightState, spot, pressure, targetNpcId, rng, timestamp });
            patch.vitals.hp = result.hp;
            patch.vitals.maxHp = result.maxHp;
            patch.vitals.mp = result.mp;
            patch.vitals.maxMp = result.maxMp;
            patch.inventory = result.inventory || patch.inventory || state.inventory;
            patch.stats = {
                ...(patch.stats || state.stats || {}),
                coldCombat: {
                    ...(state.stats?.coldCombat || ColdCombatProfile.profileFor(fightState, timestamp)),
                    ...(patch.stats?.coldCombat || {}),
                    effects: result.effects || patch.stats?.coldCombat?.effects || [],
                    cooldowns: result.cooldowns || {},
                    charges: result.charges || 0,
                    chargeExpiresAt: result.chargeExpiresAt || null,
                    summon: result.died ? null : (result.summon || null)
                }
            };
            materialize.exp += result.exp;
            materialize.sp += result.sp;
            materialize.adena += result.adena;
            materialize.items.push(...result.loot);
            combatActions += Number(result.debug?.actions || 0);
            skillUses += Number(result.debug?.skillUses || 0);
            musicUses += Number(result.debug?.musicUses || 0);
            summonUses += Number(result.debug?.summonUses || 0);
            summonActions += Number(result.debug?.summonActions || 0);
            potionsUsed += Number(result.debug?.potionsUsed || 0);

            if (result.won) {
                wins += 1;
                if (Number(result.debug?.mobSelfId) > 0) foughtNpcIds.push(Number(result.debug.mobSelfId));
            }
            if (result.died) {
                died = true;
                patch.activity = 'dead';
                patch.deathCount = (state.stats?.deaths || 0) + 1;
                events.push({
                    type: 'death',
                    summary: `${state.name || 'Bot'} died near ${spot.name}`,
                    weight: 4,
                    meta: { spotId: spot.id, fights: i + 1 }
                });
                break;
            }

            const hpPct = patch.vitals.hp / Math.max(1, patch.vitals.maxHp || patch.vitals.hp);
            const mpPct = patch.vitals.mp / Math.max(1, patch.vitals.maxMp || patch.vitals.mp || 1);
            if (needsRest(fightState, patch.vitals)) {
                patch.activity = 'resting';
                patch.stats = {
                    ...(patch.stats || state.stats || {}),
                    restUntil: timestamp + estimateRestMs(fightState, patch.vitals)
                };
                events.push({
                    type: 'rest',
                    summary: `${state.name || 'Bot'} sat down to recover near ${spot.name}`,
                    weight: 2,
                    meta: { spotId: spot.id, hpPct, mpPct }
                });
                break;
            }
        }

        if (wins > 0 && !died) {
            events.push({
                type: 'hunt',
                summary: `${state.name || 'Bot'} won ${wins} fights near ${spot.name}`,
                weight: wins >= 3 ? 2 : 1,
                meta: { spotId: spot.id, wins }
            });
        }

        return {
            patch,
            events,
            materialize,
            nextResolveAt: patch.stats?.restUntil || timestamp + 30000 + Math.round(rng() * 90000),
            debug: {
                elapsedMs,
                fights,
                wins,
                died,
                dropsRolled: materialize.items.length,
                dropsAwarded: materialize.items.reduce((sum, item) => sum + Number(item.amount || 0), 0),
                spotId: spot.id,
                route: spot.route || null,
                combatActions,
                skillUses,
                musicUses,
                summonUses,
                summonActions,
                potionsUsed,
                targetNpcId: Number(targetNpcId) || null,
                foughtNpcIds
            }
        };
    }
};

module.exports = BackgroundResolver;
