const { coldRestRegenPerTick, restRegenPerTick, requiresManaRecovery, estimateRestMs } = require('./ColdRest');
const PveEncounter = require('./ColdPveEncounter');
const ColdSoulCrystal = require('./ColdSoulCrystal');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const ColdSummonProfile = invoke('GameServer/Bot/Population/ColdSummonProfile');
const ColdKillRewards = invoke('GameServer/Bot/Population/ColdKillRewards');
const ColdClassPolicy = invoke('GameServer/Bot/Population/ColdClassPolicy');
const SoloSelfHeal = invoke('GameServer/Bot/AI/SoloSelfHeal');
const PetHealRule = invoke('GameServer/Bot/AI/PetHealRule');
const PartyHealPolicy = invoke('GameServer/Bot/AI/PartyHealPolicy');
const BotCombatUtility = invoke('GameServer/Bot/AI/BotCombatUtility');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const ChargeLifecycle = invoke('GameServer/Skills/ChargeLifecycle');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const RestPotion = invoke('GameServer/Bot/AI/RestPotion');
const BotHuntingGroundPolicy = invoke('GameServer/Bot/AI/BotHuntingGroundPolicy');
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const BotPullEstimate = invoke('GameServer/Bot/AI/BotPullEstimate');
const EncounterReadiness = invoke('GameServer/Bot/AI/BotEncounterReadiness');
const PartyBuffLoadout = invoke('GameServer/Bot/AI/PartyBuffLoadout');
const Karma = invoke('GameServer/Karma');
const NpcHate = invoke('GameServer/Npc/NpcHate');
const HitRules = invoke('GameServer/Combat/HitRules');
const CombatantView = invoke('GameServer/Combat/CombatantView');
// A monster's side of the fight, and the fighter's views, hit roll, action
// times and shot supply: their owners' (combat core, T106).
const ColdMobAction = require('./ColdMobAction');
const { mobHitModifier, coldMobFight, coldMobFightSave, coldMobAction, mobAttackMs, dotDamage, landOnMob, controlLandChance } = ColdMobAction;
const { hitSources, attackerView, defenderView, hitSucceeds, actionDelayMs } = ColdCombatProfile;
const summonAttackDelay = ColdCombatProfile.summonAttackMs, coldShotSupply = ColdCombatProfile.shotSupply;
const SurvivalFloor = require('./SurvivalFloor');
const { SPOT_CELL_SIZE } = invoke('GameServer/World/WorldConstants');
const { RUN_SPEED } = require('./ColdTrip');
const Diagnostics = require('../Economy/EconomyDiagnostics');

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

// The fighter numbers with the bot's buffs and night at timestamp.
function botCombatStats(state, timestamp = Date.now()) {
    return ColdCombatProfile.fightProfile(state, timestamp);
}

// combat_profile: the profile builds and their ms in one fight or one solo
// step (unit), read from the profile's own totals around it; only while
// diagnostics count.
function countedBuilds(unit, kind, resolve, options) {
    if (!Diagnostics.active()) return resolve(options);
    const builds = ColdCombatProfile.buildCount(), ms = ColdCombatProfile.buildMs();
    // The fight's builds count under their own site (combat_profile:build:fight).
    const result = ColdCombatProfile.withBuildSite(unit === 'fight' ? 'fight' : null, () => resolve(options));
    Diagnostics.count('combat_profile', unit, kind);
    Diagnostics.count('combat_profile', `${unit}_build`, kind, ColdCombatProfile.buildCount() - builds);
    Diagnostics.duration(`combat_profile:${unit}`, ColdCombatProfile.buildMs() - ms);
    return result;
}

function combatRoleForState(state) {
    if (BotRoles.isSpoiler(state)) return 'spoiler';
    const persistedRole = state?.party?.role || state?.stats?.role;
    return persistedRole === 'crafter'
        ? BotRoles.combatRoleFor(state)
        : persistedRole || BotRoles.combatRoleFor(state);
}

// A party buff is cast again once it has this share of its duration left, at most this many ms.
const BUFF_RECAST_SHARE = 0.25;
const BUFF_RECAST_MAX_MS = 120000;
// The cold adapter of HitRules.targetModifier for a fighter's hit on a
// monster: the monster's weaknesses (ColdCombatProfile.npcVulnerability) and
// the fighter's race and undead bonuses at the hit's time.
function coldTargetModifier(fighter, mob, semantic = {}, { magic = false, skill = false, at = Date.now() } = {}) {
    const profile = fighter.profile;
    return HitRules.targetModifier({ magic, skill, trait: semantic.trait, weaponKind: profile.equipment?.weaponKind || '',
        race: mob?.race, undead: mob?.undead === true },
    stat => ColdCombatProfile.npcVulnerability(mob, stat),
    stat => ColdCombatProfile.statMultiplier(profile, stat, at, hitSources(fighter, at)));
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

// A used skill costs its MP; its reuse starts when the cast starts (C4).
function spendSkill(fighter, skill, at, mpCost = Number(skill.mp || 0)) {
    fighter.vitals.mp = Math.max(0, fighter.vitals.mp - mpCost);
    fighter.cooldowns[skill.selfId] = at + Math.max(0, Number(skill.reuse || 0));
}

// A used attack skill spends the charges it needs and adds those it grants.
function settleCharges(fighter, semantic, at) {
    consumeCharges(fighter, semantic.requires?.charges);
    if (Number(semantic.chargeOnUse) > 0) addCharges(fighter, semantic.chargeOnUse, semantic.maxCharges, at);
}

// options.pet: the pet's rest view (coldPetView).
function needsRest(state, vitals, options = {}) {
    const hpRatio = Number(vitals?.hp ?? 0) / Math.max(1, Number(vitals?.maxHp ?? vitals?.hp ?? 1));
    const mpRatio = Number(vitals?.mp ?? 0) / Math.max(1, Number(vitals?.maxMp ?? vitals?.mp ?? 1));
    return RestPolicy.needsRest(state, hpRatio, mpRatio, { party: options.party === true, pet: options.pet || null });
}

// A living pet as the rest rule reads it (PetHealRule.restView): may its
// owner, at these vitals, heal it now or once a reuse ends. Null without one.
function coldPetView(profile, summon, vitals, cooldowns = {}, at = Date.now()) {
    if (!profile || !summon?.active || Number(summon.expiresAt || Infinity) <= at) return null;
    const pet = fullPet(profile, summon);
    return PetHealRule.restView(ColdClassPolicy.actorFor(profile, { hp: vitals.hp, mp: vitals.mp, cooldowns, time: at }),
        pet.hp, pet.maxHp);
}

// A state's pet as the rest rule reads it, from its stored kit profile (party rests).
function petViewForState(state, vitals, at = Date.now()) {
    const summon = state?.stats?.coldCombat?.summon;
    if (!summon?.active) return null;
    return coldPetView(ColdCombatProfile.profileFor(state, at), summon, vitals, state.stats.coldCombat.cooldowns, at);
}

// The rest a pet needs on top of its owner's: none when the owner heals it
// once rested (the rest refills its MP; the hot bot wakes and heals); else
// its own regeneration to whole (RestPolicy.petRested), no longer than it lives.
function petRestMs(profile, summon, vitals, at) {
    if (!summon?.active) return 0;
    if (coldPetView(profile, summon, { hp: vitals.maxHp ?? vitals.hp, mp: vitals.maxMp ?? profile?.maxMp ?? vitals.mp }, {}, at)?.healable) return 0;
    const lives = Math.max(0, Number(summon.expiresAt || Infinity) - at);
    const missing = 0.95 * Number(summon.maxHp || 0) - Number(summon.hp || 0), regen = Number(summon.revHp || 0);
    if (!(missing > 0)) return 0;
    return Math.min(lives, regen > 0 ? missing / regen * Formulas.REGEN_TICK_MS : lives);
}

function applyStandingRegen(state, sourceVitals, elapsedMs, timestamp = Date.now()) {
    const combat = botCombatStats(state, timestamp);
    const vitals = {
        hp: Math.max(0, Number(sourceVitals?.hp ?? combat.maxHp)),
        maxHp: combat.maxHp,
        mp: Math.max(0, Number(sourceVitals?.mp ?? combat.maxMp)),
        maxMp: combat.maxMp
    };
    // C4 regeneration continues on the bot's feet (x1.1, its standing passives).
    const standing = coldRestRegenPerTick(state, { profile: combat, standing: true, timestamp });
    const ticks = Math.max(0, Number(elapsedMs) || 0) / Formulas.REGEN_TICK_MS;
    vitals.hp = Math.min(vitals.maxHp, vitals.hp + standing.hp * ticks);
    vitals.mp = Math.min(vitals.maxMp, vitals.mp + standing.mp * ticks);
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
    // Seated, or standing when that refills the rest faster (user 10-29).
    const regen = restRegenPerTick(state, vitals.maxHp - vitals.hp, vitals.maxMp - vitals.mp, { profile: combat, timestamp, ...options });
    const ticks = Math.max(0, Number(elapsedMs) || 0) / Formulas.REGEN_TICK_MS;
    vitals.hp = Math.min(vitals.maxHp, vitals.hp + regen.hp * ticks);
    vitals.mp = Math.min(vitals.maxMp, vitals.mp + regen.mp * ticks);

    const hpReady = vitals.hp / Math.max(1, vitals.maxHp) >= 0.95;
    const requireMana = requiresManaRecovery(state, options);
    const mpReady = !requireMana || vitals.mp / Math.max(1, vitals.maxMp) >= 0.95;
    // The pet rests too (RestPolicy.petRested): one its owner cannot heal waits to be whole.
    const rested = petRegen(state, elapsedMs, combat);
    const summon = rested.stats?.coldCombat?.summon;
    const petView = coldPetView(combat, summon, vitals, rested.stats?.coldCombat?.cooldowns, timestamp);
    const petReady = RestPolicy.petRested(petView);
    const recoveryNeeded = !hpReady || !mpReady || !petReady;
    // The deadline is an estimate, not an additional readiness condition.
    // Regeneration can fill the member slightly before that deadline; keeping
    // the deadline alive in that case would move it forward on every resolve.
    const scheduledRemainingMs = recoveryNeeded && requireMana
        ? Math.max(0, Number(state.stats?.restUntil || 0) - timestamp)
        : 0;
    const remainingMs = recoveryNeeded
        ? Math.max(estimateRestMs(state, vitals, options), scheduledRemainingMs, petReady ? 0 : petRestMs(combat, summon, vitals, timestamp))
        : 0;
    const resting = recoveryNeeded;
    const restUntil = resting ? timestamp + remainingMs : null;

    return {
        patch: {
            activity: resting ? 'resting' : 'hunting',
            vitals,
            stats: { ...(rested.stats || {}), restUntil }
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

// A trip record the background step resolves as travel (no fight); the held
// economy card (ColdEconomyDecision.canReuse) reads the same rule.
function travelRecord(travel) {
    return !!(travel?.to && travel.arrivalAt);
}

function resolveTravel(state, timestamp = Date.now()) {
    const travel = state.stats?.travel;
    if (!travelRecord(travel)) return null;
    const isLegacyGiranMarketTrip = travel.townName === 'Giran'
        && ['market_sale_inventory', 'market_search_for_weapon', 'market_search_for_gear'].includes(travel.reason)
        && !['soe_gatekeeper', 'walk_gatekeeper'].includes(travel.method);
    // Cold bots model the native SoE/gatekeeper sequence as a short transit,
    // not a visible straight-line cross-continent walk.  They remain at the
    // origin while casting/transiting and appear only at the destination.
    const nativeTransit = ['soe_gatekeeper', 'gatekeeper_spot', 'walk_gatekeeper'].includes(travel.method)
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
    // A detour's stand-in pair (BotRoute.trip, HuntingTravel): the held leaf's
    // spot and the ground reached, kept until the next arrival;
    // DecisionSections.occupationPlanned reads it while the bot stands there.
    // Cleared to null, not deleted: the projection merges the patch over the
    // state's stats (BotLifeState.applyResolve).
    if (arrived && (travel.leafSpotId != null || nextStats.standIn != null)) {
        nextStats.standIn = travel.leafSpotId != null ? { leaf: travel.leafSpotId, ground: travel.spotId ?? null } : null;
    }
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
            summary: travel.method === 'walk'
                ? `${state.name || 'Bot'} reached ${travel.regionName || 'the hunting area'} on foot`
                : travel.method === 'walk_gatekeeper'
                ? `${state.name || 'Bot'} walked to ${travel.viaTown || 'town'} without a Scroll of Escape and reached ${travel.townName || 'town'}`
                : arrivalActivity === 'shopping'
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

// A shopping state left behind by an old town loop: no market return to
// finish, no companion supply errand, and not at the Giran market.
function staleShopping(state) {
    return state?.activity === 'shopping'
        && !state.stats?.marketReturn
        && !state.stats?.supplyErrand
        && state.currentRegion !== 'Giran';
}

function resolveDeathRecovery(state, timestamp = Date.now()) {
    const pvpRecovery = Number(state.stats?.coldPvp?.recoverUntil || 0);
    if (pvpRecovery > timestamp) return { patch: {}, events: [],
        materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: pvpRecovery,
        debug: { activity: 'dead', reason: 'pvp_recovery' } };
    const combat = botCombatStats(state, timestamp);
    const respawnDelayMs = pvpRecovery ? 1000 : 90000;

    return {
        patch: {
            activity: 'resting',
            clearDeathExperience: 'restart_to_town',
            vitals: {
                hp: combat.maxHp,
                maxHp: combat.maxHp,
                mp: combat.maxMp,
                maxMp: combat.maxMp
            },
            stats: {
                ...(state.stats || {}),
                lastRespawnAt: timestamp,
                ...(pvpRecovery ? { coldPvp: { ...state.stats.coldPvp, recoverUntil: 0, flagUntil: 0 } } : {}),
                restUntil: timestamp + respawnDelayMs,
                coldCombat: {
                    ...(state.stats?.coldCombat || {}),
                    ...(pvpRecovery ? { cp: combat.maxCp, cpAt: timestamp, effects: [] } : {}),
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

// A skill's power at the caster's HP (HitRules.skillPower: Death Link, Fatal).
function effectiveSkillPower(profile, skill, hp) {
    return HitRules.skillPower(C4SkillRules.resolveCached(skill || {}), Number(skill?.power) || 0, hp, profile.maxHp);
}

// The solo self-heal of a cold fighter in its fight (SoloSelfHeal.inFight):
// the fight's pace from the fighter's first turn of the slice.
function coldSoloHeal(fighter, mobHp, time, at) {
    if (!fighter.pace) {
        fighter.pace = { at: time, hp: fighter.vitals.hp, mobHp, healed: 0 };
        return null;
    }
    const actor = ColdClassPolicy.actorFor(fighter.profile, { hp: fighter.vitals.hp, mp: fighter.vitals.mp,
        cooldowns: fighter.cooldowns, time: at, charges: fighter.charges });
    const skill = SoloSelfHeal.inFight(actor, { mobHp,
        ...SoloSelfHeal.pace(fighter.pace, { at: time, hp: fighter.vitals.hp, mobHp }) });
    return skill ? { skill: skill.coldRecord, target: fighter } : null;
}

// The pet heal a summoner casts now on its living pet below its line: the
// hot chooser (PetHealRule.choose) on the cold actor; its record, or null.
function coldPetHeal(profile, summon, vitals, cooldowns, at) {
    if (!summon?.active || Number(summon.expiresAt || Infinity) <= at || !PetHealRule.wantsHeal(summon.hp, summon.maxHp)) return null;
    return PetHealRule.choose(ColdClassPolicy.actorFor(profile, { hp: vitals.hp, mp: vitals.mp, cooldowns, time: at }))?.coldRecord || null;
}

// Casts a pet heal: the pet's HP in place (a loaded spiritshot boosts it, as
// the hot cast's), the owner's MP and the reuse; the shot is spent. shooter:
// { shot, state, shotActions } (a fighter, or the resolve's gap between
// fights), null without shots. Returns its action time.
function castColdPetHeal(profile, summon, vitals, cooldowns, skill, at, shooter = null) {
    const shot = shooter ? loadColdShot(shooter, skill) : null;
    summon.hp = Math.min(Number(summon.maxHp), Number(summon.hp) + PetHealRule.amount(skill, shot));
    vitals.mp = Math.max(0, vitals.mp - Number(skill.mp || 0));
    cooldowns[skill.selfId] = at + Math.max(0, Number(skill.reuse || 0));
    if (shot) spendColdShot(shooter);
    return actionDelayMs(profile, skill, shot?.spiritshot === true);
}

// The heals a bot casts between fights instead of sitting: its pet's
// (PetHealRule), then its own where they beat sitting (solo only,
// SoloSelfHeal.betweenFights): vitals and cooldowns change in place.
// options.shooter: the shots (castColdPetHeal); options.solo false: the pet
// only. Returns { casts, petCasts, ms }: casts its own heals.
function coldHealBetweenFights(profile, vitals, cooldowns, at, summon = null, options = {}) {
    let casts = 0, petCasts = 0, ms = 0;
    // The pet first, with the heals ready now: one on its reuse waits for
    // the fight, as the hot bot walks on.
    for (let guard = 0; guard < 20; guard++) {
        const skill = coldPetHeal(profile, summon, vitals, cooldowns, at + ms);
        if (!skill) break;
        ms += castColdPetHeal(profile, summon, vitals, cooldowns, skill, at + ms, options.shooter || null);
        petCasts += 1;
    }
    if (options.solo === false) return { casts, petCasts, ms };
    for (;;) {
        const actor = ColdClassPolicy.actorFor(profile, { hp: vitals.hp, mp: vitals.mp, cooldowns, time: at + ms });
        const skill = SoloSelfHeal.betweenFights(actor);
        if (!skill) return { casts, petCasts, ms };
        vitals.hp = Math.min(profile.maxHp, vitals.hp + SoloSelfHeal.healAmount(actor, skill, skill.fetchSemantic?.() || {}, true));
        vitals.mp = Math.max(0, vitals.mp - skill.fetchConsumedMp());
        cooldowns[skill.fetchSelfId()] = at + ms + Math.max(0, Number(skill.fetchReuseTime?.()) || 0);
        ms += actionDelayMs(profile, skill.coldRecord);
        casts += 1;
    }
}

// The healing potions a solo bot drinks between fights to save rest
// (RestPotion, T141): at the gap one, once the last has run out; sitting down
// (options.resting) then one more each time the last runs out, as RestingState
// does, the rest's regeneration counted for each next choice. vitals take a
// bottle's heal at once, as a won fight's tail (settleColdTails). bag: the
// round's inventory; options.shared: the state's own, copied before a debit.
// stats: the bot's; a first round without its coldCombat drinks nothing.
// Returns { bag, drunk (by selfId) or null, count, ms, until }: ms the rest the
// bottles run for at least, until the last one's end.
function coldRestPotions(profile, vitals, stats, bag, at, { resting = false, pet = null, shared = null } = {}) {
    const outcome = { bag, drunk: null, count: 0, ms: 0, until: 0 };
    const combat = stats.coldCombat;
    const waits = Math.max(0, Number(combat?.potionUntil || 0) - at);
    if (!combat || (waits > 0 && !resting)) return outcome;
    const cooldowns = combat.cooldowns || {};
    const seated = ColdClassPolicy.actorFor(profile, { hp: vitals.hp, mp: vitals.mp, cooldowns, time: at });
    const hpPerMs = BotCombatUtility.seatedHpPerMs(seated), mpPerMs = BotCombatUtility.seatedMpPerMs(seated);
    for (let ms = waits; ; ms += HealingPotionStock.HOT_MS) {
        const actor = ColdClassPolicy.actorFor(profile, { hp: Math.min(vitals.maxHp, vitals.hp + hpPerMs * ms),
            mp: Math.min(vitals.maxMp, vitals.mp + mpPerMs * ms), cooldowns, time: at + ms });
        const potion = RestPotion.betweenFights(actor, { stats, inventory: outcome.bag, pet: () => pet });
        if (!potion) return outcome;
        if (outcome.bag === shared) outcome.bag = { ...shared };
        HealingPotionStock.debitColdPotion(outcome.bag, potion);
        vitals.hp = Math.min(vitals.maxHp, vitals.hp + potion.heal);
        (outcome.drunk ||= {})[potion.selfId] = Number(outcome.drunk[potion.selfId] || 0) + 1;
        outcome.count += 1;
        outcome.ms = ms + HealingPotionStock.HOT_MS;
        outcome.until = at + outcome.ms;
        if (!resting) return outcome;
    }
}

// A party's won fight's gap (BackgroundPartyResolver): each living
// summoner heals its pet below its line (PetHealRule), on its shots; the pet
// is saved with its owner. at: the fights' clock (their cooldowns').
// Returns { petCasts, ms }: ms the longest member's casts.
function healPartyPetsBetweenFights(fighters, at) {
    let petCasts = 0, ms = 0;
    for (const fighter of fighters) {
        if (!(fighter.vitals?.hp > 0) || !fighter.summon?.active) continue;
        const healed = coldHealBetweenFights(fighter.profile, fighter.vitals, fighter.cooldowns, at, fighter.summon,
            { solo: false, shooter: fighter.shot ? fighter : null });
        if (!healed.petCasts) continue;
        petCasts += healed.petCasts;
        ms = Math.max(ms, healed.ms);
        fighter.petHeals = Number(fighter.petHeals || 0) + healed.petCasts;
        fighter.skillUses = Number(fighter.skillUses || 0) + healed.petCasts;
        setPersistedSummon(fighter, { ...fighter.summon });
    }
    return { petCasts, ms };
}

function chooseSkill(profile, hp, mp, cooldowns, time, charges = 0, rng, context = {}) {
    const selected=ColdClassPolicy.select(profile,{hp,mp,cooldowns,time,charges,...context});
    return selected?{...selected,power:effectiveSkillPower(profile,selected.skill,hp)}:null;
}

function chooseChargeSkill(profile, mp, cooldowns, time, charges = 0, context = {}) {
    return ColdClassPolicy.select(profile,{hp:profile.maxHp,mp,cooldowns,time,charges,...context,prepare:true});
}

// The raid's minions its members hold: per member with MP for one, its
// likeliest sleep, root or stun to land (ColdMobAction.controlLandChance: the
// land rate by levels and M.Atk, cut by the encounter's trait resists, a raid
// boss's passive 4045 to a tenth), at most the minions.
function coldRaidControlCapacity(fighters = [], mob = {}) {
    const minionCount = Math.max(0, Number(mob.raidMinionCount || 0));
    if (!minionCount) return 0;
    let held = 0;
    for (const fighter of fighters) {
        let best = 0;
        for (const skill of fighter.profile?.skills || []) {
            if (skill.passive || Number(skill.mp || 0) > Number(fighter.vitals?.mp || 0)) continue;
            const semantic = C4SkillRules.resolveCached(skill);
            if (semantic.effectType !== 'debuff' || !/sleep|root|stun/.test(String(semantic.effect || '').toLowerCase())) continue;
            best = Math.max(best, controlLandChance(mob, semantic, skill.spell === true,
                { level: fighter.profile.level, mAtk: fighter.profile.mAtk }) / 100);
        }
        held += best;
    }
    return Math.min(minionCount, held);
}

function coldRaidMinionPressure(mob = {}, mobHp = 0, controlCapacity = 0) {
    const count = Math.max(0, Number(mob.raidMinionCount || 0));
    const minionHp = Math.max(0, Number(mob.raidMinionHp || 0));
    if (!count || !minionHp) return { activeMinions: 0, uncontrolledMinions: 0, pAtk: 0 };
    const bossHp = Math.max(0, Number(mob.raidBossMaxHp || (Number(mob.maxHp || 0) - minionHp)));
    const remainingMinionHp = Math.max(0, Math.min(minionHp, Number(mobHp || 0) - bossHp));
    const activeMinions = remainingMinionHp > 0
        ? Math.max(1, Math.ceil(count * remainingMinionHp / minionHp))
        : 0;
    const uncontrolledMinions = Math.max(0, activeMinions - Math.max(0, Number(controlCapacity || 0)));
    return {
        activeMinions,
        uncontrolledMinions,
        pAtk: Math.round(Math.max(0, Number(mob.raidMinionPAtk || 0)) * uncontrolledMinions / Math.max(1, count))
    };
}

function coldRaidEncounterProfile(pending, spot = {}, targetNpcId = 0) {
    const storedMob = pending?.mob;
    const storedHp = Number(pending?.hp);
    if (!storedMob || storedMob.raidBossMaxHp != null) {
        return { mob: storedMob || null, hp: Number.isFinite(storedHp) ? storedHp : null, upgraded: false };
    }
    const bossId = Number(storedMob.selfId || targetNpcId || 0);
    const current = ColdCombatProfile.npcForSpot(spot, () => 1, {
        preferredNpcId: bossId,
        allowRaid: true,
        aggressiveInterruptionChance: 0
    });
    if (!current || current.avoided || Number(current.selfId || 0) !== bossId
        || current.raidBossMaxHp == null) {
        return { mob: storedMob, hp: Number.isFinite(storedHp) ? storedHp : null, upgraded: false };
    }
    const oldMaxHp = Math.max(1, Number(storedMob.maxHp || 1));
    const hpRatio = Number.isFinite(storedHp) ? clamp(storedHp / oldMaxHp, 0, 1) : 1;
    return {
        mob: { ...storedMob, ...current },
        hp: Number(current.maxHp || oldMaxHp) * hpRatio,
        upgraded: true
    };
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

// options.solo: the provider sings only for itself, so a song must pay its MP
// (soloMusicPays); a party's songs keep the old every-missing-song rule.
function chooseMusicAction(provider, targets, timestamp, options = {}) {
    const skill = ColdCombatProfile.partyMusicSkills(provider.profile)
        .map((candidate) => {
            const semantic = C4SkillRules.resolveCached(candidate);
            const affected = targets.filter((target) => target.vitals.hp > 0
                && withinSkillRadius(provider, target, semantic)
                && !activeMusicEffectForSkill(target.profile, candidate, timestamp));
            return {
                skill: candidate,
                affected,
                cost: ColdCombatProfile.partyMusicMpCost(provider.profile, candidate, timestamp)
            };
        })
        .filter((candidate) => candidate.cost <= provider.vitals.mp && candidate.affected.length > 0
            && (options.solo !== true || soloMusicPays(provider, candidate, timestamp)))
        .sort((a, b) => Number(a.skill.selfId) - Number(b.skill.selfId))[0];
    return skill || null;
}

// The share a song adds to the provider's own normal-attack damage rate, from
// the song's own stats (P.Atk, attack speed, critical rate and damage; a
// critical hit doubles): a song that only defends, heals or helps casters
// adds nothing here.
function soloMusicGain(provider, skill) {
    const stats = C4SkillRules.resolveCached(skill).stats || {};
    const mul = (name) => Math.max(0, Number(stats[name] ?? 1));
    const rate = Math.min(1, Math.max(0, Number(provider.profile.critical) || 0) / 1000);
    const hit = (critical, damage) => 1 + critical * (2 * damage - 1);
    return Math.max(0, mul('pAtkMul') * mul('pAtkSpdMul')
        * hit(Math.min(1, rate * mul('pCritRateMul')), mul('pCritDamageMul')) / hit(rate, 1) - 1);
}

// T100 (docs/game-decisions.md): BotCombatUtility.manaPrice's rule for a
// solo song. Its damage gain over its duration must cover the attacks lost
// sitting for its MP (BotCombatUtility.restMsPerMp, the skills' price: none
// for a bot that never rests for MP); the attack rate cancels out.
function soloMusicPays(provider, candidate, timestamp) {
    const gain = soloMusicGain(provider, candidate.skill);
    if (!(gain > 0)) return false;
    const actor = ColdClassPolicy.actorFor(provider.profile, { hp: provider.vitals.hp, mp: provider.vitals.mp,
        cooldowns: provider.cooldowns, time: timestamp });
    const restMs = BotCombatUtility.restMsPerMp(actor) * candidate.cost;
    return gain * ColdCombatProfile.partyMusicEffect(candidate.skill, timestamp).durationMs >= restMs;
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
    const semantic = C4SkillRules.resolveCached(action.skill);
    const targets = action.affected.length === 1 && action.affected[0] === provider
        ? action.affected
        : [provider, ...action.affected.filter((target) => target !== provider)];
    targets.filter((target) => target.vitals.hp > 0 && withinSkillRadius(provider, target, semantic))
        .forEach((target) => refreshFighterProfile(target, replaceMusicEffect(target.profile.effects, effect), timestamp));
    return action.cost;
}

// self: the caster's own buffs too (target self, no cast condition such as
// Frenzy's HP gate): a solo bot buffs itself (T106); a party casts only its
// buffs for others.
function coldBuffSkill(skill, self = false) {
    if (!skill || skill.passive === true) return false;
    const semantic = C4SkillRules.resolveCached(skill);
    const skillType = String(semantic.skillType || '');
    const durationMs = Math.max(0, Number(semantic.durationMs ?? skill?.buffTime) || 0);
    return semantic.effectType === 'buff'
        && (['friendly', 'ally', 'party'].includes(semantic.target) || self && semantic.target === 'self' && !semantic.condition)
        && semantic.isDance !== true
        && !['hot', 'healHot', 'manaHot'].includes(skillType)
        && !['kiss_of_eva'].includes(String(semantic.effect || '').toLowerCase())
        && durationMs >= 60000;
}

function coldSkillAdapter(record) {
    const semantic = C4SkillRules.resolveCached(record || {});
    return {
        coldRecord: record,
        fetchSelfId: () => Number(record?.selfId || 0),
        fetchLevel: () => Number(record?.level || 1),
        fetchPassive: () => record?.passive === true,
        fetchConsumedMp: () => Math.max(0, Number(record?.mp || 0)),
        fetchBuffTime: () => Math.max(0, Number(semantic.durationMs ?? record?.buffTime) || 0),
        fetchSemantic: () => semantic,
        fetchSkillType: () => semantic.skillType,
        fetchTargetKind: () => semantic.target
    };
}

function coldBuffActor(fighter) {
    const weaponKind = String(fighter.profile?.equipment?.weaponKind || '');
    const weapon = weaponKind ? {
        fetchKind: () => weaponKind,
        fetchName: () => '',
        fetchPAtk: () => Number(fighter.profile?.equipment?.pAtk || 0),
        fetchMAtk: () => Number(fighter.profile?.equipment?.mAtk || 0)
    } : null;
    return {
        fighter,
        classId: fighter.profile.classId,
        level: fighter.profile.level,
        fetchId: () => Number(fighter.state.characterId || 0),
        fetchClassId: () => Number(fighter.profile.classId || 0),
        fetchLevel: () => Number(fighter.profile.level || 1),
        fetchHp: () => Number(fighter.vitals.hp || 0),
        fetchMaxHp: () => Number(fighter.vitals.maxHp || 1),
        isDead: () => Number(fighter.vitals.hp || 0) <= 0,
        backpack: {
            fetchItems: () => [],
            fetchEquippedWeapon: () => weapon,
            fetchTotalWeaponKind: () => weaponKind
        }
    };
}

function coldBuffEffect(skill, timestamp) {
    const record = skill.coldRecord || {};
    const semantic = skill.fetchSemantic();
    const skillId = Number(skill.fetchSelfId() || 0);
    const durationMs = Math.max(60000, Number(semantic.durationMs ?? record.buffTime) || 1200000);
    const key = PartyBuffLoadout.normalize(semantic.effect || `skill_${skillId}`);
    return {
        key,
        id: skillId,
        name: semantic.effect || `Skill ${skillId}`,
        level: Number(skill.fetchLevel() || 1),
        type: 'buff',
        durationMs,
        expiresAt: timestamp + durationMs,
        stackFamily: semantic.stackFamily || PartyBuffLoadout.family(key),
        stackOrder: semantic.stackOrder ?? null,
        stats: { ...(semantic.stats || {}) }
    };
}

function replaceColdBuff(effects, nextEffect) {
    const family = PartyBuffLoadout.family(nextEffect.key);
    return [
        ...(effects || []).filter((effect) => (
            PartyBuffLoadout.family(effect?.key) !== family
            && (!nextEffect.stackFamily || effect?.stackFamily !== nextEffect.stackFamily)
        )),
        nextEffect
    ];
}

function raidPreparationFighters(members, timestamp) {
    return members.map((state) => {
        const fighterState = mutableCombatState(state);
        const profile = botCombatStats(fighterState, timestamp);
        const active = (profile.effects || []).filter((effect) => !effect?.expiresAt || Number(effect.expiresAt) > timestamp);
        const chargeState = coldChargeState(fighterState, timestamp);
        const fighter = {
            state: fighterState,
            profile,
            role: combatRoleForState(fighterState),
            vitals: {
                hp: Math.min(profile.maxHp, Math.max(0, Number(state.vitals?.hp ?? profile.maxHp))),
                maxHp: profile.maxHp,
                mp: Math.min(profile.maxMp, Math.max(0, Number(state.vitals?.mp ?? profile.maxMp))),
                maxMp: profile.maxMp
            },
            cooldowns: { ...(state.stats?.coldCombat?.cooldowns || {}) },
            readyAt: 0,
            charges: chargeState.charges,
            chargeExpiresAt: chargeState.chargeExpiresAt,
            summonUses: 0,
            summonActions: 0,
            summonReadyAt: Number.POSITIVE_INFINITY,
            potionsUsed: 0,
            potionHot: null,
            now: timestamp
        };
        refreshFighterProfile(fighter, active, timestamp);
        return fighter;
    });
}

// The buffs a cold buff actor (coldBuffActor) may cast: its cold buff skills
// (coldBuffSkill; self: its own self buffs too) that its weapon takes, as
// adapters. The plan (coldBuffPlan) and the solo check before it
// (castSoloBuffs) read this one list.
function buffSkills(actor, self) {
    const weaponMask = Number(actor.fighter.profile.weaponMask) || 0;
    return (actor.fighter.profile.skills || [])
        .filter((skill) => coldBuffSkill(skill, self))
        .filter((skill) => {
            const required = Number(C4SkillRules.resolveCached(skill).requires?.weaponsAllowed) || 0;
            return !required || (required & weaponMask) !== 0;
        })
        .map(coldSkillAdapter);
}

function coldBuffPlan(fighters, timestamp, { self = false } = {}) {
    const actors = fighters.map(coldBuffActor);
    const skillCache = new Map();
    const skills = (actor) => {
        if (!skillCache.has(actor)) skillCache.set(actor, buffSkills(actor, self));
        return skillCache.get(actor);
    };
    const chosen = PartyBuffLoadout.build(
        actors.map((actor) => ({ actor })),
        actors,
        {},
        {
            skills,
            recipients: (_members, provider, skill) => {
                const target = skill.fetchSemantic().target;
                if (target === 'self') return [provider];
                if (target === 'party') return actors;
                if (target !== 'ally') return [];
                // Forecast the same clan coverage as admission. A stronger
                // Paagrio cannot replace a weaker chant on foreign members.
                const source = provider.fighter.state;
                const clanId = Number(source.clanId || source.stats?.clanId || 0);
                return actors.filter(actor => actor === provider || clanId > 0
                    && clanId === Number(actor.fighter.state.clanId || actor.fighter.state.stats?.clanId || 0));
            },
            isAura: (skill) => ['party', 'ally', 'self'].includes(skill.fetchSemantic().target),
            effects: (actor) => (actor.fighter.profile.effects || [])
                .filter((effect) => !effect?.expiresAt || Number(effect.expiresAt) > timestamp),
            useful: (actor, skill, _provider, context) => PartyBuffLoadout.useful(actor, skill, context)
        }
    ).chosen;
    return chosen.filter((action) => action.beneficiaries.some((actor) => !buffHeld(actor.fighter.profile.effects, action.skill, timestamp)));
}

// Does effects hold the buff of skill (an adapter) at this level or above,
// with more than its recast share left?
function buffHeld(effects, skill, timestamp) {
    const semantic = skill.fetchSemantic();
    const family = PartyBuffLoadout.family(PartyBuffLoadout.normalize(semantic.effect));
    const level = Number(skill.fetchLevel() || 1);
    const durationMs = Math.max(60000, Number(semantic.durationMs ?? skill.fetchBuffTime()) || 1200000);
    const threshold = Math.min(BUFF_RECAST_MAX_MS, Math.floor(durationMs * BUFF_RECAST_SHARE));
    return (effects || []).some((effect) => (
        (Number(effect?.id || 0) === Number(skill.fetchSelfId())
            || PartyBuffLoadout.family(effect?.key) === family)
        && Number(effect?.level || 0) >= level
        && (!effect?.expiresAt || Number(effect.expiresAt) - timestamp > threshold)
    ));
}

// Whether a buff (an adapter) can be cast now: its MP, and its reuse when
// cooldowns are the caster's (a party pass casts its plan whole: none).
function buffCastable(skill, mp, cooldowns, at) {
    return Number(skill.fetchConsumedMp() || 0) <= mp && !(Number(cooldowns[skill.fetchSelfId()] || 0) > at);
}
// Whether a solo bot's own buff is due: castable now and not held with more
// than its recast share left (buffHeld). castSoloBuffs asks it before the
// fighter is built; the plan's pass (coldBuffPlan, castPartyBuffs) asks the
// same two halves.
function buffDue(skill, effects, mp, cooldowns, at) {
    return buffCastable(skill, mp, cooldowns, at) && !buffHeld(effects, skill, at);
}

// One cast pass of the planned party buffs: the raid preparation and an
// ordinary cold party hunt both call it. Returns the casts and their duration.
function castPartyBuffs(fighters, timestamp, options = {}) {
    let buffCasts = 0;
    let durationMs = 0;
    for (const action of coldBuffPlan(fighters, timestamp, options)) {
        const provider = action.provider.fighter;
        const cost = Math.max(0, Number(action.skill.fetchConsumedMp() || 0));
        // Alone, a buff still on its reuse waits (War Cry: 60 s on, 180 s
        // reuse). A party pass casts its plan whole (its single-target buffs
        // go to each member in one pass).
        if (!buffCastable(action.skill, provider.vitals.mp, options.self ? provider.cooldowns : {}, timestamp + durationMs)) continue;
        const effect = coldBuffEffect(action.skill, timestamp + durationMs);
        action.recipients.forEach((actor) => {
            const target = actor.fighter;
            refreshFighterProfile(target, replaceColdBuff(target.profile.effects, effect), timestamp + durationMs);
        });
        provider.vitals.mp = Math.max(0, provider.vitals.mp - cost);
        provider.cooldowns[action.skill.fetchSelfId()] = timestamp + durationMs
            + Math.max(0, Number(action.skill.coldRecord?.reuse || 0));
        durationMs += actionDelayMs(provider.profile, action.skill.coldRecord);
        buffCasts += 1;
    }
    return { buffCasts, durationMs };
}

// An ordinary cold party hunt (F23): the party casts its buffs between fights
// when the earliest one is about to expire. Cast time is not charged to the
// hunt, it fits inside the gap between two party resolves.
// The plan's skills are the profile's, ColdCombatProfile.skillsFor without the
// build: a party where no member has a cold party buff casts nothing, and the
// fighters are built only when one has.
function castHuntPartyBuffs(members, timestamp) {
    const buffer = members.some((state) => ColdCombatProfile.skillsFor(state)
        .some((skill) => skill && skill.passive !== true && coldBuffSkill(skill)));
    if (!buffer) return { buffCasts: 0, members };
    const fighters = raidPreparationFighters(members, timestamp);
    const { buffCasts } = castPartyBuffs(fighters, timestamp);
    if (buffCasts === 0) return { buffCasts, members };
    return {
        buffCasts,
        members: fighters.map((fighter) => ({
            ...fighter.state,
            vitals: { ...fighter.vitals },
            stats: {
                ...(fighter.state.stats || {}),
                coldCombat: { ...(fighter.state.stats?.coldCombat || {}), cooldowns: fighter.cooldowns }
            }
        }))
    };
}

// A solo bot's own buffs before a fight (T106, docs/game-decisions.md "Solo
// self-buffs"): the party plan (coldBuffPlan) on the bot alone, its own
// buffs included, paying the MP and the cast time. The fighter is built only
// when one of the plan's buffs (buffSkills, useful to the bot by the plan's
// PartyBuffLoadout.useful) is missing or about to expire, castable now; the
// check reads `profile` (the round's: its skills and weapon), without the
// build. Null when none is due; buffCasts 0 when the plan casts none of them.
function castSoloBuffs(state, timestamp, profile) {
    const effects = state.stats?.coldCombat?.effects, cooldowns = state.stats?.coldCombat?.cooldowns || {};
    const mp = Number(state.vitals?.mp) || 0;
    const actor = coldBuffActor({ profile, state, vitals: { hp: 1, maxHp: 1 } });
    const due = buffSkills(actor, true).some((skill) => buffDue(skill, effects, mp, cooldowns, timestamp)
        && PartyBuffLoadout.useful(actor, skill, {}));
    if (!due) return null;
    const fighters = raidPreparationFighters([state], timestamp);
    const { buffCasts, durationMs } = castPartyBuffs(fighters, timestamp, { self: true });
    return { buffCasts, durationMs, fighter: fighters[0] };
}

// The solo round's patch after castSoloBuffs: the MP spent, the buffs and
// reuses on its saved fight snapshot (seeded as a fight seeds it).
function applySoloBuffs(patch, { buffCasts, fighter }, timestamp) {
    if (!(buffCasts > 0)) return;
    patch.vitals.mp = fighter.vitals.mp;
    patch.stats.coldCombat = {
        ...(patch.stats.coldCombat || ColdCombatProfile.seedSnapshot(fighter.state, timestamp)),
        effects: fighter.profile.effects || [],
        cooldowns: fighter.cooldowns
    };
}

function prepareRaidParty(members, timestamp = Date.now()) {
    const fighters = raidPreparationFighters(members, timestamp);
    const buffPass = castPartyBuffs(fighters, timestamp);
    const buffCasts = buffPass.buffCasts;
    let musicCasts = 0;
    let summonCasts = 0;
    let chargeCasts = 0;
    let durationMs = buffPass.durationMs;

    for (const fighter of fighters) {
        let action = chooseMusicAction(fighter, fighters, timestamp + durationMs);
        while (action && fighter.vitals.mp >= action.cost && musicCasts < 32) {
            applyMusicAction(fighter, action, timestamp + durationMs);
            fighter.vitals.mp = Math.max(0, fighter.vitals.mp - action.cost);
            fighter.cooldowns[action.skill.selfId] = timestamp + durationMs + Math.max(0, Number(action.skill.reuse || 0));
            durationMs += actionDelayMs(fighter.profile, action.skill);
            musicCasts += 1;
            action = chooseMusicAction(fighter, fighters, timestamp + durationMs);
        }
        const beforeSummon = Number(fighter.summonUses || 0);
        ensureColdSummon(fighter, timestamp + durationMs, fighter.cooldowns);
        if (Number(fighter.summonUses || 0) > beforeSummon) {
            summonCasts += 1;
            durationMs = Math.max(durationMs, Number(fighter.readyAt || 0));
        }
        for (let attempts = 0; attempts < 8; attempts += 1) {
            const charge = chooseChargeSkill(fighter.profile, fighter.vitals.mp, fighter.cooldowns,
                timestamp + durationMs, fighter.charges, { party: true, summon: fighter.summon });
            if (!charge || Number(charge.mp || 0) > fighter.vitals.mp) break;
            const semantic = C4SkillRules.resolve(charge);
            addCharges(fighter, 1, semantic.maxCharges, timestamp + durationMs);
            fighter.vitals.mp = Math.max(0, fighter.vitals.mp - Number(charge.mp || 0));
            fighter.cooldowns[charge.selfId] = timestamp + durationMs + Math.max(0, Number(charge.reuse || 0));
            durationMs += actionDelayMs(fighter.profile, charge);
            chargeCasts += 1;
        }
    }

    const remainingBuffs = coldBuffPlan(fighters, timestamp + durationMs).length;
    const remainingMusic = fighters.reduce((count, fighter) => (
        count + (chooseMusicAction(fighter, fighters, timestamp + durationMs) ? 1 : 0)
    ), 0);
    const ready = remainingBuffs === 0 && remainingMusic === 0;
    const restUntil = ready ? null : timestamp + Math.max(...fighters.map((fighter) => (
        estimateRestMs(fighter.state, fighter.vitals, { party: true, requireMana: true })
    )));
    const casts = buffCasts + musicCasts + summonCasts + chargeCasts;
    // ARCH-NOTE: Native checkpoints require integer milliseconds. Keep the exact
    // cast duration; ceil only the persisted deadline so preparation never ends early.
    const nextResolveAt = restUntil || Math.ceil(timestamp + Math.max(3000, durationMs));
    const memberResults = fighters.map((fighter) => ({
        state: fighter.state,
        result: {
            patch: {
                activity: ready ? 'grouped' : 'resting',
                ...(fighter.summonUses > 0 ? { inventory: fighter.state.inventory } : {}),
                vitals: { ...fighter.vitals },
                stats: {
                    ...(fighter.state.stats || {}),
                    restUntil,
                    coldCombat: {
                        ...(fighter.state.stats?.coldCombat || {}),
                        classId: fighter.profile.classId,
                        skills: fighter.profile.skills,
                        effects: fighter.profile.effects || [],
                        cooldowns: fighter.cooldowns,
                        charges: fighter.charges || 0,
                        chargeExpiresAt: fighter.chargeExpiresAt || null,
                        summon: fighter.summon || null
                    }
                }
            },
            events: [],
            memoryEvents: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] },
            nextResolveAt,
            debug: { reason: ready ? 'raid_prepared' : 'raid_preparing', buffCasts, musicCasts, summonCasts, chargeCasts }
        }
    }));
    return {
        ready,
        needsRest: !ready,
        casts,
        buffCasts,
        musicCasts,
        summonCasts,
        chargeCasts,
        remainingBuffs,
        remainingMusic,
        durationMs,
        restUntil,
        memberResults,
        nextResolveAt
    };
}

// owned: what of the state its caller already owns (a solo round's carry,
// resolveFight: the inventory copy its fights spend from, the effects list
// its last fight left), kept as it is; the rest is copied.
function mutableCombatState(state = {}, owned = null) {
    const effects = state.stats?.coldCombat?.effects || [];
    return {
        ...state,
        inventory: owned?.inventory && state.inventory === owned.inventory ? state.inventory
            : Object.fromEntries(Object.entries(state.inventory || {}).map(([key, item]) => [key, { ...item }])),
        stats: {
            ...(state.stats || {}),
            coldCombat: { ...(state.stats?.coldCombat || {}),
                effects: owned?.held && effects === owned.held.effects ? effects : effects.map(effect => ({ ...effect,
                    ...(effect.hot ? { hot: { ...effect.hot } } : {}) })) }
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

// After a won fight the background time jumps past the tails still running
// on a survivor: its potion HoT and a monster's damage over time tick on in
// their order, as hot (the poison outlives the kill and can kill). Returns
// the DoT damage taken.
function settleColdTails(fighter) {
    let taken = 0;
    while (fighter.vitals.hp > 0 && fighter.dots?.length) {
        let next = Infinity;
        for (const dot of fighter.dots) if (dot.left > 0 && dot.next < next) next = dot.next;
        if (next === Infinity) break;
        applyColdPotionTicks(fighter, next);
        const damage = dotDamage(fighter, next);
        fighter.vitals.hp = Math.max(0, fighter.vitals.hp - damage);
        taken += damage;
    }
    if (fighter.vitals.hp > 0) applyColdPotionTicks(fighter, Number.MAX_SAFE_INTEGER);
    return taken;
}

// The time a cold bottle runs to: the next one waits for it, as activePotionHot
// makes a hot bot wait, across the round's gaps and fights.
const coldPotionRuns = (fighter) => Number(fighter?.potionUntil ?? fighter?.state?.stats?.coldCombat?.potionUntil) || 0;

function startColdPotion(fighter, time) {
    if (!fighter || fighter.potionsUsed > 0 || fighter.potionHot || coldPotionRuns(fighter) > fighter.now) return null;
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
    if (effect.hot) fighter.potionUntil = fighter.now + HealingPotionStock.HOT_MS;
    fighter.potionsUsed = Number(fighter.potionsUsed || 0) + 1;
    // The fight drinks from its own inventory copy (mutableCombatState); the
    // resolve then debits these bottles from the stored stock, as it debits
    // shotActions (BotLifeState.prepareResolve).
    fighter.drunkPotions = { ...(fighter.drunkPotions || {}),
        [potion.selfId]: Number(fighter.drunkPotions?.[potion.selfId] || 0) + 1 };
    return potion;
}

function summonNpcStats(fighter, details) {
    return ColdSummonProfile(fighter.profile, details);
}

function persistedSummon(fighter, timestamp) {
    const saved = fighter.state.stats?.coldCombat?.summon;
    if (!saved?.active || Number(saved.expiresAt || 0) <= timestamp) return null;
    return ColdSummonProfile.savedSummon(fighter.profile, saved);
}

// A saved pet with its numbers (a hot-to-cold snapshot has none yet).
function fullPet(profile, saved) {
    return ColdSummonProfile.fullSummon(profile, saved);
}

// The fighter's living pet as the mob's target (coldMobAction's { profile,
// state }), one per summon; null without one. Its readyAt: the end of a
// stun or a sleep the mob laid on it (fight time).
function petTarget(fighter) {
    const summon = fighter.summon;
    if (!summon?.active || !(Number(summon.hp) > 0)) return null;
    if (fighter.petTarget?.profile !== summon) {
        fighter.petTarget = { profile: summon, state: { characterId: `pet:${fighter.state?.characterId ?? ''}` }, readyAt: 0 };
    }
    return fighter.petTarget;
}

// One mob action on a solo fighter's side (a party member left alone too):
// its living pet takes it first, as in C4 (user 10-29, solo fights; a
// party's mob strikes by its aggro), then the fighter. Returns { action,
// pet } (pet: the summon took it; a stun or a sleep holds its next strike;
// dead, it is gone and a new one is a new cast, its MP and reuse,
// ensureColdSummon). The fighter's own HP is the caller's to lower.
function strikeSide(fighter, mob, mobFight, options) {
    const pet = petTarget(fighter);
    const action = coldMobAction(mob, mobFight, pet || fighter, options);
    if (!pet) return { action, pet: false };
    if (pet.readyAt > fighter.summonReadyAt) fighter.summonReadyAt = pet.readyAt;
    fighter.summon.hp = Math.max(0, Number(fighter.summon.hp) - Math.max(0, action.damage));
    if (fighter.summon.hp <= 0) {
        setPersistedSummon(fighter, null);
        fighter.summon = null;
        fighter.summonReadyAt = Number.POSITIVE_INFINITY;
        fighter.summonDeaths = Number(fighter.summonDeaths || 0) + 1;
    }
    return { action, pet: true };
}

// A saved pet's HP after elapsedMs out of a fight (its template's revHp per
// regen tick); the state unchanged without a wounded pet. profile: its owner's.
function petRegen(state, elapsedMs, profile) {
    const saved = state.stats?.coldCombat?.summon;
    if (!saved?.active || !(Number(saved.hp) > 0)) return state;
    const summon = fullPet(profile, saved);
    if (!(Number(summon.hp) < Number(summon.maxHp))) return state;
    const hp = Math.min(Number(summon.maxHp), Number(summon.hp) + Number(summon.revHp || 0) * Math.max(0, elapsedMs) / Formulas.REGEN_TICK_MS);
    return { ...state, stats: { ...state.stats, coldCombat: { ...state.stats.coldCombat, summon: { ...summon, hp } } } };
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

function startColdSummon(fighter, timestamp, cooldowns, skills = ColdCombatProfile.summonSkills(fighter.profile)) {
    const skill = skills.find((candidate) => (
        Number(cooldowns[candidate.selfId] || 0) <= timestamp
        && Number(candidate.mp || 0) <= fighter.vitals.mp
    ));
    if (!skill) return false;

    const details = ColdCombatProfile.summonDetails(skill);
    fighter.vitals.mp = Math.max(0, fighter.vitals.mp - Number(skill.mp || 0));
    const totalLifeTime = Math.max(30000, Number(details.totalLifeTime || 1200000));
    const stats = summonNpcStats(fighter, details);
    const summon = {
        ...stats,
        hp: stats.maxHp,
        active: true,
        skillId: Number(skill.selfId),
        expiresAt: timestamp + totalLifeTime
    };
    // Cold actors are bots: preserve the hot C4SkillEffects bot exemption
    // from summon crystal costs. Authored skill ownership, MP and reuse still apply.
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

// The fighter's pet while it is the saved one and not expired: it stays as
// it is, with the HP its fight left it (strikeSide lowers it, the save gets
// it at the fight's end).
function heldSummon(fighter, timestamp) {
    const summon = fighter.summon, saved = fighter.state.stats?.coldCombat?.summon;
    return summon?.active === true && saved?.active === true && Number(summon.skillId) === Number(saved.skillId)
        && Number(summon.expiresAt) === Number(saved.expiresAt) && Number(saved.expiresAt) > timestamp;
}

function ensureColdSummon(fighter, timestamp, cooldowns) {
    if (heldSummon(fighter, timestamp)) return false;
    const existing = persistedSummon(fighter, timestamp);
    if (existing) {
        fighter.summon = existing;
        fighter.summonReadyAt = Number(fighter.readyAt || 0) + summonAttackDelay(existing);
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
    // A hot servitor hits as a monster does (SummonControl -> Attack.prepareNpcMeleeHit).
    return HitRules.melee(attackerView(summon), defenderView(mob), {}, rng).damage;
}

// Damage of one attack action in a cold fight (PvE or PvP): a spell with its
// magic critical, or a weapon hit (hit roll, critical, spread from the fight
// rng); a monster target (`vsMob`) adds its weaknesses; a skill that spends
// charges hits harder with each charge; a loaded `shot` (loadColdShot) boosts
// it as in hot: a soulshot doubles P.Atk, a spiritshot M.Atk, blessed x4. A
// miss deals 0.
function attackDamage(fighter, selected, target, rng, { vsMob = false, at = 0, shot = null } = {}) {
    const profile = fighter.profile;
    const semantic = selected?.skill ? C4SkillRules.resolve(selected.skill) : {};
    const attacker = attackerView(profile, at, fighter), defender = defenderView(target, at);
    const bow = profile.equipment?.weaponKind === 'Weapon.Bow';
    let damage = 0;
    if (selected?.magic) {
        // A nuke or a drain fails whole by the level-fail roll (hot C4SkillEffects.execute).
        if (HitRules.rollsMagicLevel(semantic, true) && !HitRules.magicLevelLands(semantic, profile.level, target.level, rng)) return 0;
        damage = HitRules.magicSkill(attacker, defender, { power: Math.max(1, selected.power),
            spiritshot: shot?.spiritshot === true, blessedSpiritshot: shot?.blessedSpiritshot === true,
            modifier: vsMob ? coldTargetModifier(fighter, target, semantic, { magic: true, at }) : 1 }, rng).damage;
    } else if (selected?.skill) {
        // A physical skill never misses (the hot Attack rolls the hit only for
        // a weapon hit); a blow lands by its own chance (HitRules.blowLandChance).
        // The cold fight has no positions: the fighter strikes the mob's face.
        const blow = semantic.skillType === C4SkillRules.BLOW;
        if (blow && !HitRules.blowLands(semantic, { dex: profile.dex, front: true,
            rateMul: ColdCombatProfile.statMultiplier(profile, 'blowRateMul', at, hitSources(fighter, at)) }, rng)) return 0;
        damage = HitRules.physicalSkill(attacker, defender, { power: selected.power || 0,
            blow, soulshot: shot?.soulshot === true, bow,
            skillCritRate: HitRules.physicalSkillCritRate(semantic, profile.str),
            modifier: vsMob ? coldTargetModifier(fighter, target, semantic, { skill: true, at }) : 1 }, rng).damage;
    } else if (hitSucceeds(profile.accur, target.evasion, rng)) {
        damage = HitRules.melee(attacker, defender, { soulshot: shot?.soulshot === true, bow, spreadRng: rng,
            modifier: vsMob ? coldTargetModifier(fighter, target, semantic, { at }) : 1 }, rng).damage;
    }
    if (Number(semantic.requires?.charges) > 0) damage *= 0.8 + (0.201 * fighter.charges);
    return damage;
}

// The shot a cold action loads (ColdCombatProfile.actionShot), from the
// fight's supply refilled when its loaded charges ran out; null: no bonus,
// nothing spent.
function loadColdShot(fighter, skill) {
    let shot = fighter.shot;
    if (!shot) return null;
    if (shot.left <= 0) shot = fighter.shot = coldShotSupply(fighter.state, shot.timestamp);
    return ColdCombatProfile.actionShot(shot, skill);
}

// A cast or a skill spends its loaded shot at use, a normal attack only when
// the hit lands (Attack.js). The fight's own inventory copy (mutableCombatState)
// is debited so the next fight of the resolve sees the rest; the resolve then
// debits shotActions x perAction from the stored stock (BotLifeState).
function spendColdShot(fighter) {
    const shot = fighter.shot;
    shot.left -= 1;
    const item = fighter.state.inventory[shot.key];
    item.amount = Number(item.amount) - shot.perAction;
    fighter.shotActions += 1;
}

// One cold bot action, shared by the solo and the party fight: servitor,
// charge expiry, potion, heal, song, charge preparation, then a skill or a
// normal attack on the mob. `allies` are the heal and song targets (only the
// bot itself when solo), `party` switches the class policy to party mode and
// heal help events go to `help` when given. Returns null when the action was
// not an attack, otherwise { skill, damage } for the caller's kill
// bookkeeping. A killing blow lets a living necromancer among the allies
// raise a servitor from the corpse.
function coldBotTurn(fighter, { allies, mob, mobFight = null, mobHp, at, time, rng, party = false, help = null }) {
    fighter.now = at;
    // Alone (no other living ally, a party of one too) the bot fights solo:
    // its class mode, MP price and songs (T100) are a solo bot's, as a hot bot
    // alone in its party (BotClassPolicy.modeFor, T126).
    const solo = !allies.some((ally) => ally !== fighter && ally.vitals.hp > 0);
    if (ensureColdSummon(fighter, at, fighter.cooldowns)) return null;
    expireCharges(fighter, at);
    if (startColdPotion(fighter, time)) {
        fighter.readyAt += 250;
        return null;
    }
    // Alone, the bot heals itself by the solo rule (SoloSelfHeal, T107); in a party by the author's.
    const heal = solo ? coldSoloHeal(fighter, mobHp, time, at)
        : chooseHeal(fighter.profile, allies, fighter.vitals.mp, fighter.cooldowns, at, fighter);
    if (heal) {
        const shot = loadColdShot(fighter, heal.skill);
        const hpBefore = fighter.vitals.hp;
        const events = applyAllyHeal(fighter, allies, heal, shot);
        if (fighter.pace) fighter.pace.healed += Math.max(0, fighter.vitals.hp - hpBefore);
        if (help) for (const event of events) help.set(`${event.sourceId}:${event.targetId}:${event.type}`, event);
        spendSkill(fighter, heal.skill, at);
        fighter.skillUses += 1;
        fighter.heals += 1;
        fighter.readyAt += actionDelayMs(fighter.profile, heal.skill, shot?.spiritshot === true);
        if (shot) spendColdShot(fighter);
        return null;
    }
    // A summoner keeps its pet alive, solo or in a party, as the hot one does (PetHealRule).
    const petHeal = coldPetHeal(fighter.profile, fighter.summon, fighter.vitals, fighter.cooldowns, at);
    if (petHeal) {
        fighter.readyAt += castColdPetHeal(fighter.profile, fighter.summon, fighter.vitals, fighter.cooldowns, petHeal, at, fighter);
        fighter.skillUses += 1;
        fighter.petHeals = Number(fighter.petHeals || 0) + 1;
        return null;
    }
    const music = chooseMusicAction(fighter, allies, at, { solo });
    if (music) {
        const shot = loadColdShot(fighter, music.skill);
        applyMusicAction(fighter, music, at);
        spendSkill(fighter, music.skill, at, music.cost);
        fighter.skillUses += 1;
        fighter.musicUses += 1;
        fighter.readyAt += actionDelayMs(fighter.profile, music.skill, shot?.spiritshot === true);
        if (shot) spendColdShot(fighter);
        return null;
    }
    const chargeSkill = chooseChargeSkill(fighter.profile, fighter.vitals.mp, fighter.cooldowns, at, fighter.charges,
        { hp: fighter.vitals.hp, mob, mobHp, party: party && !solo, summon: fighter.summon });
    if (chargeSkill) {
        const shot = loadColdShot(fighter, chargeSkill);
        const semantic = C4SkillRules.resolve(chargeSkill);
        addCharges(fighter, 1, semantic.maxCharges, at);
        spendSkill(fighter, chargeSkill, at);
        fighter.skillUses += 1;
        fighter.readyAt += actionDelayMs(fighter.profile, chargeSkill, shot?.spiritshot === true);
        if (shot) spendColdShot(fighter);
        return null;
    }

    if (ColdSoulCrystal.tryCast(fighter, mob, mobHp, at)) return null;
    const profile = fighter.profile;
    const selected = chooseSkill(profile, fighter.vitals.hp, fighter.vitals.mp, fighter.cooldowns, at, fighter.charges, rng,
        { mob, mobHp, party: party && !solo, summon: fighter.summon });
    const skill = selected?.skill || null;
    // A bow shot costs its MP (C4WeaponSA.expectedBowMp), as a player's does;
    // below it no shot leaves (hot BowResources.consume): the bot stands until
    // its standing regeneration pays the shot (ColdRest), then shoots.
    const bowMp = skill ? 0 : Number(profile.equipment?.bowMp) || 0;
    if (bowMp > fighter.vitals.mp) {
        const perMs = coldRestRegenPerTick(fighter.state, { profile, standing: true, timestamp: at }).mp / Formulas.REGEN_TICK_MS;
        fighter.readyAt += perMs > 0 ? Math.ceil((bowMp - fighter.vitals.mp) / perMs) : actionDelayMs(profile, null);
        if (perMs > 0) fighter.vitals.mp = bowMp;
        countHitRule('bow_mp_wait');
        return null;
    }
    const shot = loadColdShot(fighter, skill);
    let damage = attackDamage(fighter, selected, mob, rng, { vsMob: true, at, shot });
    // An area skill hits every mob of a pull, each for the full hit (F20).
    const struck = skill && Number(mob.pull) > 1 && C4SkillRules.hitsArea(C4SkillRules.resolveCached(skill)) ? Number(mob.pull) : 1;
    if (damage > 0) damage = afterBotHit(fighter, { skill, shot, damage, struck }, mob, mobFight, mobHp, { time, at, rng });
    // A missed normal attack deals 0 and keeps its soulshot.
    if (shot && (skill || damage > 0)) spendColdShot(fighter);
    fighter.vitals.mp -= bowMp;
    if (skill) {
        settleCharges(fighter, C4SkillRules.resolve(skill), at);
        spendSkill(fighter, skill, at);
        fighter.skillUses += 1;
    }
    fighter.readyAt += actionDelayMs(profile, skill, shot?.spiritshot === true);
    if (mobHp - Math.max(0, damage) <= 0) {
        const necromancer = allies.find((ally) => (
            ally.vitals.hp > 0
            && BotRoles.isNecromancer(ally.profile?.classId)
            && !ally.summon
        ));
        if (necromancer) startColdCorpseSummon(necromancer, at, necromancer.cooldowns);
    }
    return { skill, damage, struck };
}

// What a bot's landed hit on a cold monster does beyond its damage, as the
// hot hit does (T124): a lethal strike leaves the struck mob at 1 HP
// (HitRules.lethalStrike; never on a raid boss); a drain heals the caster
// (Formulas.calcDrainHeal, Vampiric Claw) and a normal hit, not a bow's,
// steals life (absorbDam: a weapon SA, Vampiric Rage; HitRules.absorbedHp),
// each of the HP the struck mob had; the monster sends back its reflectDam
// share of each hit (HitRules.reflectedDamage); a damage+effect or drain
// skill's effect may land (ColdMobAction.landOnMob). The mobs of a pull share
// one HP pool: the struck one holds what is left over whole mobs. Returns the
// damage after a lethal strike.
function afterBotHit(fighter, { skill, shot, damage, struck }, mob, mobFight, mobHp, { time, at, rng }) {
    const profile = fighter.profile, vitals = fighter.vitals;
    const pull = Math.max(1, Number(mob.pull) || 1), oneMaxHp = mob.maxHp / pull;
    const oneHp = mobHp - Math.max(0, Math.ceil(mobHp / oneMaxHp) - 1) * oneMaxHp;
    const semantic = skill ? C4SkillRules.resolveCached(skill) : null;
    if (semantic?.lethal) {
        const strike = HitRules.lethalStrike(semantic, { level: profile.level },
            { level: mob.level, hp: oneHp, maxHp: oneMaxHp, guarded: mob.boss === true || mob.raidBossMaxHp != null }, skill.level, rng);
        if (strike) {
            damage = Math.max(damage, oneHp - strike.hp);
            countHitRule('lethal');
        }
    }
    const hpDamage = Math.min(damage, oneHp);
    if (semantic?.skillType === C4SkillRules.DRAIN) {
        vitals.hp = Math.min(vitals.maxHp, vitals.hp + struck * Formulas.calcDrainHeal({ damage, targetHp: oneHp,
            absorbPart: semantic.absorbPart, absorbAbs: semantic.absorbAbs }));
        countHitRule('drain');
    } else if (!skill && profile.equipment?.weaponKind !== 'Weapon.Bow') {
        const stolen = HitRules.absorbedHp(ColdCombatProfile.hitStatAdd(fighter, 'absorbDam', at), hpDamage, vitals.hp, vitals.maxHp);
        vitals.hp += stolen;
        if (stolen > 0) countHitRule('life_steal');
    }
    // A mob the hit killed sends nothing back (hot: no reflect from the dead).
    const reflected = mobHp > damage * struck ? struck * HitRules.reflectedDamage(mob.reflectDam, damage) : 0;
    if (reflected > 0) {
        vitals.hp = Math.max(0, vitals.hp - reflected);
        countHitRule('reflect');
    }
    if (skill && mobFight && landOnMob(mob, mobFight, skill, { level: profile.level, mAtk: profile.mAtk, soulshot: shot?.soulshot === true,
        spiritshot: shot?.spiritshot === true, blessedSpiritshot: shot?.blessedSpiritshot === true,
        characterId: fighter.state?.characterId ?? null }, time, rng, struck)) countHitRule('effect_landed');
    return damage;
}

// cold_fight:<rule>: how often the cold fight meets a hot rule it rolls
// (T124: lethal, drain, life_steal, reflect, effect_landed, bow_mp_wait); only while diagnostics count.
function countHitRule(rule) {
    if (Diagnostics.active()) Diagnostics.count('cold_fight', 'rule', rule);
}

// roundProfiles: the solo round's matchup profiles (resolveSolo), so its
// fights read one set of species verdicts (they are kept per profile array);
// without them the fight builds its own. round: the solo round's carry
// (resolveSolo; {} at its start), so its fights share one setup: the
// inventory copy they spend from (with the shot supply drawn from it), the
// fight profile while it holds (ColdCombatProfile.heldFightProfile) and its
// hits' stat sources; each fight leaves its own there.
function resolveFight({ state, spot, pressure, targetNpcId = 0, rng, timestamp = Date.now(), fightLimitMs = 12000, maxActions = 48,
    roundProfiles = null, round = null }) {
    const fightState = mutableCombatState(state, round);
    let bot;
    if (round) {
        round.held = ColdCombatProfile.heldFightProfile(fightState, timestamp, round.held || null, botCombatStats);
        bot = round.held.profile;
    } else {
        bot = botCombatStats(fightState, timestamp);
    }
    const encounterKey = PveEncounter.key([state], spot, targetNpcId);
    const pending = PveEncounter.read(state.stats?.pveEncounter, encounterKey, timestamp);
    const shot = round?.inventory && fightState.inventory === round.inventory && round.shot !== undefined ? round.shot
        : coldShotSupply(fightState, timestamp);
    const matchupProfiles = pending ? null : roundProfiles || TargetMatchup.coldProfiles(bot, fightState, timestamp, { shot });
    // A continued fight's mob is the fight's own copy: its self buffs
    // (ColdMobAction.buffColdMob) reach the save only with the slice's mobFight.
    const picked = (pending?.mob && { ...pending.mob }) || ColdCombatProfile.npcForSpot(spot, rng, { preferredNpcId: targetNpcId,
        ...soloPickOptions(state), pull: true, matchupProfiles }) || {
        level: Number(spot.avgLevel || bot.level), maxHp: Math.max(1, Number(spot.mob?.hp || 1)),
        pAtk: Math.max(1, Number(spot.mob?.damage || 1)), pAtkRnd: 0, pDef: 1, mDef: 1,
        accur: 1, evasion: 0, critical: 0, atkSpd: 253, mAtk: 1, castSpd: 333
    };
    if (picked.avoided) return { avoided: true, reason: picked.reason };
    // Readiness keeps the margin the spawn-group verdict gave the rolled pull
    // (a size of the group's mix the hunter survives); helpers, aggressive
    // neighbours and minions beyond it come regardless (design 13.5).
    // The share of the bot's damage by area skills: a pull it wears down
    // together keeps its mobs standing together (BotPullEstimate.pullView).
    let areaShare = 0;
    if (!pending && !picked.aggressiveInterruption) {
        const readiness = EncounterReadiness.evaluate({
            hp: state.vitals?.hp ?? bot.maxHp, maxHp: bot.maxHp,
            mp: state.vitals?.mp ?? bot.maxMp, maxMp: bot.maxMp, level: bot.level,
            manaDependent: RestPolicy.sitsForMana(state)
        }, picked);
        // A full-health route verdict cannot admit the next mob after a win
        // depleted the owner. Keep the same damage margin with the HP/MP that
        // remain now; pending fights and aggressive interruptions still run.
        // The pet is the one beside the bot now (TargetMatchup.servitorProfile:
        // alive with the HP it has left, or one to raise), not the round's.
        const remaining = matchupProfiles.flatMap(profile => profile.servitor === true ? []
            : profile.soloDamageReceiver === false ? [profile] : [{
                ...profile,
                maxHp: Math.min(profile.maxHp, state.vitals?.hp ?? profile.maxHp),
                maxMp: Math.min(profile.maxMp, state.vitals?.mp ?? profile.maxMp)
            }]);
        const pet = TargetMatchup.servitorProfile(bot, state, timestamp);
        if (pet) remaining.push(pet);
        // One mob carries no pull: channels count area skills by target.pull.
        const usual = BotPullEstimate.pullView({ ...picked, pull: 1 }, Number(picked.usualPull) || 1);
        const survival = TargetMatchup.soloSurvival(remaining, usual);
        areaShare = Number(survival.areaShare) || 0;
        if (!readiness.ready || !survival.eligible) {
            return { avoided: true, needsRest: true, reason: 'solo_recovery_needed' };
        }
    }
    const vitals = {
        hp: clamp(Number(state.vitals?.hp ?? bot.maxHp), 0, bot.maxHp),
        mp: clamp(Number(state.vitals?.mp ?? bot.maxMp), 0, bot.maxMp),
        maxHp: bot.maxHp,
        maxMp: bot.maxMp
    };
    const chargeState = coldChargeState(state, timestamp);
    const soloFighter = {
        state: fightState,
        profile: bot,
        role: BotRoles.combatRoleFor(fightState),
        vitals,
        cooldowns: { ...(state.stats?.coldCombat?.cooldowns || {}) },
        readyAt: Number(pending?.botReadyAt || 0),
        soulCrystalMark: pending?.soulCrystalMark || null,
        shot,
        shotActions: 0,
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
        // A monster's damage over time still running from the last slice (ColdMobAction.addDot).
        dots: (pending?.botDots || []).map((dot) => ({ ...dot })),
        statSources: round?.statSources || null,
        now: timestamp
    };
    const allies = [soloFighter];
    let mobReadyAt = Number(pending?.mobReadyAt || 0);
    let time = 0;
    // A pull is counted once, when its fight starts; a continued fight keeps its saved view.
    // A won fight reports the kills it paid (`killsPaid`) for the spot share.
    if (!pending && picked.aggressiveInterruption && Number(picked.pull) > 1) {
        areaShare = Number(TargetMatchup.soloSurvival(matchupProfiles, BotPullEstimate.pullView(picked, picked.pull)).areaShare) || 0;
    }
    const mob = pending ? picked : BotPullEstimate.pullView(picked, picked.pull, areaShare);
    // The bot that pulls a melee monster strikes while it closes in; one that
    // came at the bot first (an aggressive interruption) strikes at once.
    if (!pending && !picked.aggressiveInterruption) mobReadyAt = ColdCombatProfile.openingMs(bot, mob);
    const mobFight = coldMobFight(mob, pending?.mobFight);
    const pullMobs = pending ? 0 : Number(picked.pull || 1);
    let areaPullHits = 0;
    let mobHp = pending?.hp ?? mob.maxHp;
    let actions = 0;
    let overhitContext = null;
    // The mob's damage to the bot before any heal (the spot table's damage taken per kill).
    let taken = 0, spellTaken = 0, petTaken = 0;

    // A resolve contains only a handful of fights, and a fight itself is
    // bounded by time and actions. This is deliberately cheaper than a live
    // Actor while retaining its hit, critical, damage and speed formulas.
    while (vitals.hp > 0 && mobHp > 0 && time < fightLimitMs && actions < maxActions) {
        const summonReadyAt = soloFighter.summon?.active
            ? Number(soloFighter.summonReadyAt)
            : Number.POSITIVE_INFINITY;
        const summonActs = summonReadyAt <= soloFighter.readyAt && summonReadyAt <= mobReadyAt;
        const botActs = !summonActs && soloFighter.readyAt <= mobReadyAt;
        time = summonActs ? summonReadyAt : botActs ? soloFighter.readyAt : mobReadyAt;
        if (time >= fightLimitMs) {
            time = fightLimitMs;
            break;
        }
        applyColdPotionTicks(soloFighter, time);
        applyPartyHotTicks(soloFighter, timestamp + time);
        // Damage over time on both sides (ColdMobAction.dotDamage): a monster's
        // poison or bleed on the bot, the bot's on the monster.
        const dotTaken = dotDamage(soloFighter, time);
        vitals.hp -= dotTaken;
        taken += dotTaken;
        mobHp -= dotDamage(mobFight, time);
        if (vitals.hp <= 0 || mobHp <= 0) break;
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
            soloFighter.summonActions += 1;
            soloFighter.summonReadyAt = time + summonAttackDelay(soloFighter.summon);
            if (mobHp <= 0) break;
        }
        else if (botActs) {
            const hit = coldBotTurn(soloFighter, { allies, mob, mobFight, mobHp, at: timestamp + time, time, rng });
            // A stun that landed holds the monster's next action.
            mobReadyAt = Math.max(mobReadyAt, mobFight.heldUntil);
            if (!hit) continue;
            const targetHpBeforeHit = mobHp;
            // Each mob of a pull an area skill strikes takes the full hit (F20):
            // exact while all k stand, a little generous once some have fallen.
            const struck = hit.struck;
            if (struck > 1) areaPullHits += 1;
            mobHp -= Math.max(0, hit.damage) * struck;
            if (mobHp <= 0) {
                overhitContext = invoke('GameServer/Progression/OverhitReward').contextForHit({
                    attacker: { characterId: state.characterId },
                    skill: hit.skill,
                    targetHpBeforeHit,
                    targetMaxHp: mob.maxHp / Number(mob.pull || 1),
                    finalDamage: hit.damage,
                    encounterId: mob.selfId || targetNpcId,
                    timestamp: timestamp + time
                });
                break;
            }
        } else {
            const { action, pet } = strikeSide(soloFighter, mob, mobFight, { time, at: timestamp + time, rng, mobHp });
            if (pet) {
                petTaken += Math.max(0, action.damage);
            } else {
                vitals.hp -= Math.max(0, action.damage);
                taken += Math.max(0, action.damage);
                if (action.spell) spellTaken += Math.max(0, action.damage);
            }
            mobReadyAt += action.delayMs;
        }
    }

    const won = mobHp <= 0;
    if (round) Object.assign(round, { inventory: fightState.inventory, shot: soloFighter.shot, statSources: soloFighter.statSources });
    // Background time jumps past the quiet tail of a completed potion HoT.
    // Apply that tail only after the damage sequence and only to survivors;
    // a won fight's DoT tail too (an unfinished one carries its dots on).
    if (won) taken += settleColdTails(soloFighter);
    else if (vitals.hp > 0) applyColdPotionTicks(soloFighter, Number.MAX_SAFE_INTEGER);

    const died = vitals.hp <= 0;
    if (!won) {
        return {
            won: false,
            encounter: !died ? PveEncounter.save(pending, encounterKey, mob, mobHp, timestamp, {
                soulCrystalMark: soloFighter.soulCrystalMark || null,
                botReadyAt: Math.max(0, soloFighter.readyAt - time), mobReadyAt: Math.max(0, mobReadyAt - time),
                mobFight: coldMobFightSave(mobFight, time),
                ...(soloFighter.dots.length ? { botDots: soloFighter.dots.map((dot) => ({ ...dot, next: dot.next - time })) } : {})
            }) : null,
            died,
            hp: Math.max(0, Math.round(vitals.hp)),
            maxHp: Math.max(1, Math.round(vitals.maxHp)),
            mp: Math.max(0, Math.round(vitals.mp)),
            maxMp: Math.max(1, Math.round(vitals.maxMp)),
            exp: 0,
            sp: 0,
            adena: 0,
            loot: [],
            cooldowns: soloFighter.cooldowns,
            potionUntil: soloFighter.potionUntil,
            charges: died ? 0 : soloFighter.charges,
            chargeExpiresAt: died ? null : soloFighter.chargeExpiresAt,
            effects: soloFighter.profile.effects,
            inventory: fightState.inventory,
            summon: soloFighter.summon || null,
            debug: { actions, durationMs: time, skillUses: soloFighter.skillUses, shotActions: soloFighter.shotActions, heals: soloFighter.heals,
                musicUses: soloFighter.musicUses, summonUses: soloFighter.summonUses, summonActions: soloFighter.summonActions, petTaken, petHeals: soloFighter.petHeals || 0, summonDeaths: soloFighter.summonDeaths || 0,
                potionsUsed: soloFighter.potionsUsed, drunkPotions: soloFighter.drunkPotions || null,
                mobSelfId: mob.selfId || null, timedOut: !died, pullMobs, areaPullHits, damageTaken: taken, spellTaken }
        };
    }

    ColdSoulCrystal.outcome(soloFighter, mob, rng, { at: timestamp + time });
    // Every mob of the pull is a kill; the last hit decides the overhit.
    const pulled = Number(mob.pull || 1);
    const rewards = ColdKillRewards.roll({
        spot,
        kills: Array.from({ length: pulled }, (_, index) => ({ npcSelfId: mob.selfId,
            overhitContext: index === pulled - 1 ? overhitContext : null })),
        killerLevel: Number(state.level || bot.level),
        rng,
        spoiler: BotRoles.isSpoiler(state) ? ColdKillRewards.spoilerFor(state, soloFighter.profile) : null
    });
    const kill = rewards.progression.at(-1);
    const gained = ColdKillRewards.scaledProgression(pulled === 1 ? kill : {
        exp: rewards.progression.reduce((sum, item) => sum + item.exp, 0),
        sp: rewards.progression.reduce((sum, item) => sum + item.sp, 0)
    }, {
        expMultiplier: Number(pressure?.expMultiplier || 1),
        rates: ProgressionRates.profile(),
        profile: soloFighter.profile,
        timestamp
    });

    // A DoT that outlived the kill may still kill the winner.
    return {
        won: true,
        died,
        hp: died ? 0 : Math.max(1, Math.round(vitals.hp)),
        maxHp: Math.max(1, Math.round(vitals.maxHp)),
        mp: Math.max(0, Math.round(vitals.mp)),
        maxMp: Math.max(1, Math.round(vitals.maxMp)),
        exp: gained.exp,
        sp: gained.sp,
        adena: rewards.adena,
        loot: rewards.loot.flatMap(({ drops, spoil }) => [...drops, ...spoil]),
        cooldowns: soloFighter.cooldowns,
        potionUntil: soloFighter.potionUntil,
        // The fight's profile, for the heals between fights (resolveSolo); not stored.
        profile: bot,
        charges: died ? 0 : soloFighter.charges,
        chargeExpiresAt: died ? null : soloFighter.chargeExpiresAt,
        effects: soloFighter.profile.effects,
        inventory: soloFighter.state.inventory,
        soulCrystals: soloFighter.soulCrystals || [],
        summon: soloFighter.summon || null,
        debug: { actions, durationMs: time, skillUses: soloFighter.skillUses, shotActions: soloFighter.shotActions, heals: soloFighter.heals,
            musicUses: soloFighter.musicUses, summonUses: soloFighter.summonUses, summonActions: soloFighter.summonActions, petTaken, petHeals: soloFighter.petHeals || 0, summonDeaths: soloFighter.summonDeaths || 0,
            potionsUsed: soloFighter.potionsUsed, drunkPotions: soloFighter.drunkPotions || null,
            mobSelfId: mob.selfId || null, timedOut: false, overhit: kill.overhit, pullMobs, areaPullHits, killsPaid: pulled,
            // The killing action ends after the kill: its swing or cast (resolveSolo's floor per kill).
            killMs: Math.max(time, soloFighter.readyAt),
            damageTaken: taken, spellTaken }
    };
}

function chooseHeal(profile, allies, mp, cooldowns, time, caster) {
    const injured = allies.filter((ally) => ally.vitals.hp > 0 && ally.vitals.hp / Math.max(1, ally.vitals.maxHp) < PartyHealPolicy.HEAL_BELOW)
        .sort((a, b) => (a.vitals.hp / a.vitals.maxHp) - (b.vitals.hp / b.vitals.maxHp))[0];
    if (!injured) return null;
    const skill = (profile.skills || []).filter((candidate) => {
        if (candidate.passive || Number(candidate.mp || 0) > mp || Number(cooldowns[candidate.selfId] || 0) > time) return false;
        const semantic = C4SkillRules.resolveCached(candidate);
        return [C4SkillRules.HEAL, C4SkillRules.HEAL_PERCENT, C4SkillRules.HEAL_HOT, C4SkillRules.HOT].includes(semantic.skillType)
            && ['self', 'party', 'ally', 'friendly'].includes(semantic.target)
            && (semantic.target !== 'ally' || caster === injured || Number(caster?.state.clanId) > 0
                && Number(caster.state.clanId) === Number(injured.state.clanId))
            && (!semantic.hot || !(injured.profile.effects || []).some(e => e.key === semantic.effect && Number(e.expiresAt) > time))
            && (semantic.target !== 'self' || caster?.vitals.hp > 0 && caster.vitals.hp < caster.vitals.maxHp * 0.7);
    }).sort((a, b) => {
        const score = skill => {
            const semantic = C4SkillRules.resolveCached(skill);
            return invoke('GameServer/Bot/AI/PartyHealPolicy').score({
                missingHp: injured.vitals.maxHp - injured.vitals.hp, maxHp: injured.vitals.maxHp,
                power: semantic.hot?.heal ?? (semantic.skillType === C4SkillRules.HEAL_PERCENT
                    ? injured.vitals.maxHp * Number(skill.power || 0) / 100 : Formulas.calcHealAmount(skill.power)),
                cost: Number(skill.mp || 0), castMs: Number(skill.hitTime || 0),
                periodic: !!semantic.hot, ticks: semantic.hot?.count,
                recipients: ['party', 'ally'].includes(semantic.target) ? allies.filter(f => f.vitals.hp > 0 && f.vitals.hp < f.vitals.maxHp * 0.7).length : 1
            });
        };
        return score(b) - score(a);
    })[0];
    return skill ? { skill, target: C4SkillRules.resolveCached(skill).target === 'self' ? caster : injured } : null;
}

// A loaded spiritshot (`shot`) strengthens the heals hot strengthens.
function applyAllyHeal(caster, allies, heal, shot = null) {
    const semantic = C4SkillRules.resolve(heal.skill);
    const boost = shot?.spiritshot && C4SkillRules.shotBoostsHeal(semantic.skillType)
        ? { spiritshot: true, blessedSpiritshot: shot.blessedSpiritshot } : {};
    const targets = semantic.target === 'self' ? [caster] : semantic.target === 'party' ? allies
        : semantic.target === 'ally' ? allies.filter(f => f === caster || Number(caster.state.clanId) > 0
            && Number(caster.state.clanId) === Number(f.state.clanId)) : [heal.target];
    const helped = [];
    for (const ally of targets.filter(f => f.vitals.hp > 0)) {
        if (semantic.hot) {
            const at = Number(caster.now || Date.now());
            const effect = { id: heal.skill.selfId, level: heal.skill.level, key: semantic.effect,
                type: 'buff', casterId: caster.state.characterId, createdAt: at,
                expiresAt: at + semantic.hot.count * semantic.hot.intervalMs,
                hot: { ...semantic.hot, nextAt: at + semantic.hot.intervalMs } };
            ally.profile.effects = replaceMusicEffect(ally.profile.effects, effect);
            continue;
        }
        const before = ally.vitals.hp;
        const amount = semantic.skillType === C4SkillRules.HEAL_PERCENT
            ? ally.vitals.maxHp * Number(heal.skill.power || 0) / 100 : Formulas.calcHealAmount(heal.skill.power, boost);
        ally.vitals.hp = Math.min(ally.vitals.maxHp, before + Math.max(0, amount));
        if (ally !== caster && invoke('GameServer/Social/CombatHelpPolicy').meaningfulHeal(before, ally.vitals.hp, ally.vitals.maxHp)) {
            helped.push({ sourceId: ally.state.characterId, targetId: caster.state.characterId, type: 'healed' });
        }
    }
    return helped;
}

function applyPartyHotTicks(fighter, at) {
    if (fighter.vitals.hp <= 0) return;
    for (const effect of fighter.profile.effects || []) {
        const hot = effect.hot;
        if (!hot || !Number.isFinite(hot.nextAt) || !(hot.intervalMs > 0)) continue;
        const ticks = Math.max(0, Math.min(hot.count, Math.floor((Math.min(at, effect.expiresAt) - hot.nextAt) / hot.intervalMs) + 1));
        fighter.vitals.hp = Math.min(fighter.vitals.maxHp, fighter.vitals.hp + ticks * Number(hot.heal || 0));
        hot.count -= ticks;
        hot.nextAt += ticks * hot.intervalMs;
    }
}

function resolvePartyFight({ members, spot, targetNpcId = 0, rng = Math.random, timestamp = Date.now(), encounter = null,
    partyId = '', encounterKey: sharedEncounterKey = null, sharedEncounter = false }) {
    const encounterKey = sharedEncounterKey || PveEncounter.key(members, spot, targetNpcId, partyId);
    const pending = PveEncounter.read(encounter, encounterKey, timestamp, {
        maxSlices: sharedEncounter ? 1000 : PveEncounter.MAX_SLICES
    });
    const fighters = members.map((state) => {
        const fighterState = mutableCombatState(state);
        const profile = botCombatStats(fighterState, timestamp);
        const chargeState = coldChargeState(fighterState, timestamp);
        return {
            state: fighterState,
            profile,
            role: combatRoleForState(fighterState),
            vitals: {
                hp: Math.min(profile.maxHp, Math.max(0, Number(state.vitals?.hp ?? profile.maxHp))),
                maxHp: profile.maxHp,
                mp: Math.min(profile.maxMp, Math.max(0, Number(state.vitals?.mp ?? profile.maxMp))),
                maxMp: profile.maxMp
            },
            cooldowns: { ...(state.stats?.coldCombat?.cooldowns || {}) },
            readyAt: Number(pending?.readyAt?.[state.characterId] || 0),
            hate: Number(pending?.hate?.[state.characterId] || 0),
            soulCrystalMark: pending?.soulCrystalMarks?.[state.characterId] || null,
            actions: 0,
            shot: coldShotSupply(fighterState, timestamp),
            shotActions: 0,
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
    const matchupProfiles = pending ? [] : fighters.filter(f => f.vitals.hp > 0)
        .flatMap(f => TargetMatchup.coldProfiles(f.profile, f.state, timestamp, { shot: f.shot }));
    const persistedRaid = sharedEncounter
        ? coldRaidEncounterProfile(pending, spot, targetNpcId)
        : { mob: pending?.mob || null, hp: Number(pending?.hp), upgraded: false };
    // The saved mob is copied as the solo fight's (resolveFight).
    const mob = (persistedRaid.mob && { ...persistedRaid.mob }) || ColdCombatProfile.npcForSpot(spot, rng, {
        preferredNpcId: targetNpcId, matchupProfiles, allowRaid: sharedEncounter
    }) || {
        level: Number(spot.avgLevel || 1), maxHp: Math.max(1, Number(spot.mob?.hp || 1)),
        pAtk: Math.max(1, Number(spot.mob?.damage || 1)), pAtkRnd: 0, pDef: 1, mDef: 1,
        accur: 1, evasion: 0, critical: 0, atkSpd: 253
    };
    if (mob.avoided) return { avoided: true, reason: mob.reason, members: fighters, won: false };
    const mobFight = coldMobFight(mob, pending?.mobFight);
    let mobHp = persistedRaid.mob
        ? (persistedRaid.hp ?? mob.maxHp)
        : (pending?.hp ?? mob.maxHp);
    let mobReadyAt = Number(pending?.mobReadyAt || 0);
    let time = 0;
    let actions = 0;
    let overhitContext = null;
    const fightLimitMs = 15000;
    const raidControlCapacity = coldRaidControlCapacity(fighters, mob);
    const Help = invoke('GameServer/Social/CombatHelpPolicy');
    const help = new Map();
    let lastVictim = null;
    let lastKiller = null;
    const rescued = helper => {
        if (lastVictim && helper !== lastVictim.fighter && time - lastVictim.at < Help.THREAT_MS
            && Help.injured(lastVictim.fighter.vitals.hp, lastVictim.fighter.vitals.maxHp)) {
            const sourceId = lastVictim.fighter.state.characterId, targetId = helper.state.characterId;
            help.set(`${sourceId}:${targetId}:helped_in_combat`, { sourceId, targetId, type: 'helped_in_combat' });
        }
    };

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
        if (time >= fightLimitMs) { time = fightLimitMs; break; }
        fighters.forEach((fighter) => { applyColdPotionTicks(fighter, time); applyPartyHotTicks(fighter, timestamp + time); });
        // Damage over time (ColdMobAction.dotDamage); a party member's own
        // poison ends with the slice (only the monster's effects are saved).
        for (const fighter of fighters) {
            if (fighter.vitals.hp > 0) fighter.vitals.hp = Math.max(0, fighter.vitals.hp - dotDamage(fighter, time));
        }
        mobHp -= dotDamage(mobFight, time);
        if (mobHp <= 0) {
            // A DoT's kill is its caster's last hit (the soul crystal reads it).
            lastKiller = fighters.find((fighter) => fighter.vitals.hp > 0 && fighter.state.characterId === mobFight.dotBy) || null;
            break;
        }
        if (!fighters.some((fighter) => fighter.vitals.hp > 0)) break;
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
            if (mobHp <= 0) { lastKiller = nextSummon; rescued(nextSummon); break; }
        }
        else if (botActs) {
            next.actions += 1;
            const hit = coldBotTurn(next, { allies: fighters, mob, mobFight, mobHp, at: timestamp + time, time, rng, party: true, help });
            mobReadyAt = Math.max(mobReadyAt, mobFight.heldUntil);
            if (!hit) continue;
            // A miss leaves the hate table alone, as a missed hot swing never reaches ReceivedHit.
            if (hit.damage > 0) next.hate = NpcHate.add(next.hate, NpcHate.fromDamage(hit.damage));
            const targetHpBeforeHit = mobHp;
            mobHp -= Math.max(0, hit.damage);
            if (mobHp <= 0) {
                overhitContext = invoke('GameServer/Progression/OverhitReward').contextForHit({
                    attacker: { characterId: next.state.characterId },
                    skill: hit.skill,
                    targetHpBeforeHit,
                    targetMaxHp: mob.maxHp,
                    finalDamage: hit.damage,
                    encounterId: mob.selfId || targetNpcId,
                    timestamp: timestamp + time
                });
                lastKiller = next; rescued(next);
                break;
            }
        } else {
            // A living tank holds the mob, as the hot tank takes it back with
            // Aggression (FollowingState); otherwise the most hated member.
            const targets = fighters.filter((fighter) => fighter.vitals.hp > 0);
            const tank = targets.find((fighter) => fighter.role === 'tank');
            let target = tank || NpcHate.mostHated(targets);
            if (!target && targets.length) {
                target = targets[Math.floor(rng() * targets.length)];
                target.hate = NpcHate.ENGAGE_HATE;
            }
            const raidPressure = coldRaidMinionPressure(mob, mobHp, raidControlCapacity);
            const bossPAtk = Number(mob.raidBossPAtk || mob.pAtk);
            let delayMs = mobAttackMs(mob);
            if (target) {
                // The member its aggro holds takes it, a summoner too: a pet
                // tanks only for a member left alone, who fights solo (the
                // hot SummonerTactics, BotClassPolicy.modeFor; coldBotTurn).
                const options = { time, at: timestamp + time, rng, mobHp, pAtk: bossPAtk };
                const { action, pet } = targets.length === 1 ? strikeSide(target, mob, mobFight, options)
                    : { action: coldMobAction(mob, mobFight, target, options), pet: false };
                delayMs = action.delayMs;
                const before = target.vitals.hp;
                if (!pet) target.vitals.hp = Math.max(0, before - action.damage);
                if (target.vitals.hp < before) lastVictim = { fighter: target, at: time };
            }
            if (raidPressure.pAtk > 0) {
                const addTargets = fighters.filter((fighter) => fighter.vitals.hp > 0 && fighter !== tank);
                const addTarget = addTargets[Math.floor(rng() * addTargets.length)] || target;
                if (addTarget && hitSucceeds(mob.accur, addTarget.profile.evasion, rng)) {
                    const damage = HitRules.melee(CombatantView.view({ ...attackerView(mob), pAtk: raidPressure.pAtk }),
                        defenderView(addTarget.profile, timestamp + time, addTarget), { bow: mob.weaponKind === 'Weapon.Bow', spreadRng: rng,
                            modifier: mobHitModifier(mob, addTarget, timestamp + time) }, rng).damage;
                    const before = addTarget.vitals.hp;
                    addTarget.vitals.hp = Math.max(0, before - damage);
                    if (addTarget.vitals.hp < before) lastVictim = { fighter: addTarget, at: time };
                }
            }
            mobReadyAt += delayMs;
        }
        if (sharedEncounter && fighters.filter(f => f.vitals.hp <= 0).some((fighter, index) =>
            invoke('GameServer/Bot/Population/RaidCasualtyPolicy').disposition(fighter.state, { previousDamageCasualties: index,
                remainingHpRatio: mobHp / Math.max(1, mob.maxHp) }) !== 'continue')) break;
    }

    // Survivors' tails (settleColdTails): a won fight's DoTs tick out; an
    // unfinished one drops its members' (only the monster's effects are saved).
    fighters.filter((fighter) => fighter.vitals.hp > 0)
        .forEach((fighter) => mobHp <= 0 ? settleColdTails(fighter) : applyColdPotionTicks(fighter, Number.MAX_SAFE_INTEGER));

    const crystalRule = invoke('GameServer/Items/SoulCrystalProgression').catalog.npcs[mob.selfId];
    if (mobHp <= 0 && lastKiller && crystalRule) {
        const alive = fighters.filter(f => f.vitals.hp > 0);
        let recipients = crystalRule.absorbType === 'LAST_HIT' ? [lastKiller] : alive;
        if (crystalRule.absorbType === 'PARTY_ONE_RANDOM' && recipients.length) recipients = [recipients[Math.floor(rng() * recipients.length)]];
        const roll = rng();
        for (const fighter of recipients) ColdSoulCrystal.outcome(fighter, mob, roll, { boss: crystalRule.maxStage > 10, requiredMark: lastKiller.soulCrystalMark, at: timestamp + time });
    }
    return {
        won: mobHp <= 0,
        timedOut: mobHp > 0 && fighters.some((fighter) => fighter.vitals.hp > 0),
        encounter: mobHp > 0 && (sharedEncounter || fighters.every(fighter => fighter.vitals.hp > 0))
            ? PveEncounter.save(pending, encounterKey, mob, mobHp, timestamp, {
                mobReadyAt: Math.max(0, mobReadyAt - time),
                mobFight: coldMobFightSave(mobFight, time),
                soulCrystalMarks: Object.fromEntries(fighters.filter(f => f.soulCrystalMark).map(f => [f.state.characterId,f.soulCrystalMark])),
                readyAt: Object.fromEntries(fighters.map(f => [f.state.characterId, Math.max(0, f.readyAt - time)])),
                hate: Object.fromEntries(fighters.filter(f => f.vitals.hp > 0 && f.hate > 0).map(f => [f.state.characterId, f.hate]))
            }) : null,
        members: fighters,
        help: [...help.values()],
        debug: {
            actions,
            durationMs: time,
            skillUses: fighters.reduce((sum, fighter) => sum + fighter.skillUses, 0),
            musicUses: fighters.reduce((sum, fighter) => sum + fighter.musicUses, 0),
            summonUses: fighters.reduce((sum, fighter) => sum + Number(fighter.summonUses || 0), 0),
            summonActions: fighters.reduce((sum, fighter) => sum + Number(fighter.summonActions || 0), 0),
            potionsUsed: fighters.reduce((sum, fighter) => sum + Number(fighter.potionsUsed || 0), 0),
            mobSelfId: mob.selfId || null,
            remainingHp: Math.max(0, mobHp),
            raidControlCapacity,
            raidProfileUpgraded: persistedRaid.upgraded,
            raidMinionPressure: coldRaidMinionPressure(mob, mobHp, raidControlCapacity),
            overhitContext
        }
    };
}

// The safety options of a solo fight's pick (resolveFight): judged for the
// bot alone and, while it recovers from deaths, up to the lower target level.
function soloPickOptions(state) {
    return { soloSafety: true,
        maxTargetLevel: SpotRiskPolicy.recoveryFor(state)?.levelPenalty > 0 ? LevelingRoutes.targetLevelForState(state) : null };
}

// Each spawn group of the spot and the share of its spawns the bot may fight
// alone (BotTargetMatchup.speciesPulls under the pick's options; 0 for one it
// may not hunt), once per round: a solo hunter takes only the pulls it
// survives (user 10-29), so a spot's other mobs neither feed its kills nor
// widen its round. Null for a spot without spawn groups or with none the
// verdict knows (the fight then takes the spot's own mob: resolveFight).
// profiles: the round's (roundProfiles), else built here.
function admittedShares(state, spot, timestamp, profiles = roundProfiles(state, timestamp)) {
    if (!spot?.npcEntries?.length) return null;
    const options = soloPickOptions(state);
    let known = false;
    const shares = new Map(spot.npcEntries.map(entry => {
        const verdict = TargetMatchup.speciesPulls(profiles, entry, options);
        known ||= !!verdict;
        return [entry, verdict?.share ?? 0];
    }));
    return known ? shares : null;
}

// The matchup profiles of a solo round, at the round's start: its fights and
// its admitted spawns judge by them (a summon raised mid-round counts from
// the next round; each fight's readiness still reads the HP and MP left).
function roundProfiles(state, timestamp, profile = botCombatStats(state, timestamp)) {
    return TargetMatchup.coldProfiles(profile, state, timestamp);
}

// The spot's monsters a solo bot may fight: its density times the admitted
// share of its spawns (admittedShares; all of them without one).
function admittedDensity(spot, shares) {
    const density = Number(spot.density) || 1;
    if (!shares) return density;
    let total = 0, admitted = 0;
    for (const [entry, share] of shares) {
        const count = Math.max(1, Number(entry.count) || 1);
        total += count;
        admitted += count * share;
    }
    return total > 0 ? density * admitted / total : density;
}

// T106 (docs/game-decisions.md "Solo fights per hour"): the walk from a kill
// to the next mob, at runSpd: the mean distance to the nearest of the density
// monsters a bot may fight (admittedDensity) spread over the area its spawns
// cover (SpotService spawnArea; without one the SPOT_CELL_SIZE square of the
// spot, SpotService.cellAt), 1 / (2 sqrt(density / area)). The spot table
// generator reads the same rule.
// reach: the bot walks only until the mob is in its range
// (ColdCombatProfile.attackReach: a bow or a spell strikes from afar).
function soloWalkMs(density, runSpd, area = SPOT_CELL_SIZE * SPOT_CELL_SIZE, reach = 0) {
    const spacing = Math.max(0, Math.sqrt(Math.max(1, Number(area) || SPOT_CELL_SIZE * SPOT_CELL_SIZE))
        / (2 * Math.sqrt(Math.max(1, Number(density) || 1))) - Math.max(0, Number(reach) || 0));
    return Math.round(spacing / Math.max(1, Number(runSpd) || 1) * 1000);
}

// E69: a cold solo bot kills at most its share of what the spot's spawns give
// back during the round: the mobs per hour (SpotService, from the respawns)
// of the spawns it may fight (shares: admittedShares; all without) times the
// round's hours, split among the bots on the spot. Null when the spot has no
// production table (raids, rooms, older profiles) or its production is 0: a
// respawn of 0 means no respawn data, not an empty spot.
function soloShareMobs(spot, elapsedMs, hunters, shares = null) {
    let rows = 0, production = 0, admitted = 0;
    for (const entry of spot?.npcEntries || []) {
        if (!Number.isFinite(entry.production)) continue;
        rows += 1;
        production += entry.production;
        admitted += entry.production * (shares ? shares.get(entry) ?? 0 : 1);
    }
    if (!rows || spot.raidBoss === true || production <= 0) return null;
    return admitted * elapsedMs / 3600000 / Math.max(1, Number(hunters) || 1);
}

// The wait before the next solo hunt cycle, from a roll in [0, 1).
function huntCycleDelayMs(roll) {
    return 30000 + Math.round(roll * 90000);
}

const BackgroundResolver = {
    soloWalkMs,
    soloShareMobs,
    admittedShares,
    roundProfiles,
    admittedDensity,
    travelRecord,
    huntCycleDelayMs,
    combat: { chooseSkill, chooseChargeSkill, coldChargeState, expireCharges, addCharges, consumeCharges,
        spendSkill, settleCharges, attackDamage,
        chooseHeal, applyAllyHeal, applyPartyHotTicks, actionDelayMs, hitSucceeds, coldRaidControlCapacity, coldRaidMinionPressure,
        coldRaidEncounterProfile, coldMobFight, coldMobFightSave, coldMobAction, strikeSide },
    resolveDeathRecovery,
    resolveRest,
    resolvePartyFight: options => countedBuilds('fight', 'party', resolvePartyFight, options),
    needsRest,
    staleShopping,
    estimateRestMs,
    // Between-fight heals (the pet's, then the bot's own): tests and the offline hunt model (T128).
    coldHealBetweenFights,
    healPartyPetsBetweenFights,
    petViewForState,
    // A solo bot's own buffs before a fight: the offline hunt model prices their casting time (T128).
    castSoloBuffs,
    applyStandingRegen,
    prepareRaidParty,
    castHuntPartyBuffs,
    effectiveSkillPower,
    // The offline hunt tables (scripts/hunt-tables) measure a rotation against a dummy target.
    resolveFight,
    // spotHunters: the bots on the spot, from the caller's occupancy (E69).
    resolveSolo({ state, spot, pressure = {}, targetNpcId = 0, elapsedMs = 60000, spotHunters = 1, rng = Math.random, timestamp = Date.now() }) {
        if (!state) {
            return {
                patch: {},
                events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: timestamp + 60000,
                debug: { reason: 'missing_state_or_spot' }
            };
        }

        if (state.activity === 'traveling' && Karma.closesTowns(state.stats?.karma)
            && !['hunting', 'grouped'].includes(state.stats?.travel?.arrivalActivity)
            && state.stats?.travel?.townName !== Karma.TOWN_NAME) {
            return { patch: { activity: 'hunting', stats: { ...state.stats, travel: null } },
                events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: timestamp + 1000, debug: { reason: 'karma_blocks_town' } };
        }
        if (state.activity === 'traveling') {
            const travelResult = resolveTravel(state, timestamp);
            if (travelResult) return travelResult;
        }

        if (require('./RaidSupplyPolicy').held(state, timestamp) && state.activity !== 'dead' && Number(state.vitals?.hp) > 0) {
            return { patch: { activity: ['shopping', 'merchant'].includes(state.activity) ? 'shopping' : 'party_wait' }, events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + 30000,
                debug: { reason: 'raid_supply_preparing', fights: 0, wins: 0 } };
        }

        if (state.stats?.supplyErrand) {
            const expiresAt = Number(state.stats.supplyErrand.expiresAt || 0);
            // A native accepted obligation has no lateness deadline. Its
            // terminal event releases this workflow; downtime cannot abandon it.
            if (!(state.stats.supplyErrand.meetingToken && state.stats.tradeMeeting) && expiresAt > 0 && timestamp >= expiresAt) {
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

        // The floor is a between-fights read too: a pending fight goes on first.
        const floor = state.stats?.pveEncounter ? null : SurvivalFloor.forState(state, timestamp);
        if (floor?.action === 'rest') {
            const resting = resolveRest(state, 0, timestamp, { requireMana: true });
            resting.debug.reason = 'survival_no_mp';
            return resting;
        }
        if (floor?.action === 'unload') {
            return { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: timestamp + 30000, debug: { reason: `survival_${floor.reason}`, fights: 0, wins: 0 } };
        }

        if (invoke('GameServer/Bot/Population/ClanPartyDuty').waiting(state)) return invoke('GameServer/Bot/Population/ClanPartyDuty').hold(state, timestamp);

        if (invoke('GameServer/Bot/Population/RaidSoloBoundary').blocked(state, spot, targetNpcId)) {
            const cleared = invoke('GameServer/Bot/Population/RaidSoloBoundary').clear(state);
            return {
                patch: { activity: 'hunting', spotId: cleared.spotId, stats: cleared.stats },
                events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: timestamp + 30000,
                debug: { reason: 'solo_raid_forbidden', fights: 0, wins: 0 }
            };
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

        // The worker may already have selected a safe destination while the
        // persisted bot is still physically inside its previous room. Never
        // resolve destination fights at the old coordinates: travel must be
        // committed first. When both ids match, prefer the full spot profile
        // so the exceptional-solo equipment check keeps its level bounds.
        const currentGround = state.spotId && String(state.spotId) === String(spot.id)
            ? spot
            : {
                id: state.spotId || null,
                name: state.currentRegion || null,
                area: state.area || state.stats?.area || null
            };
        const currentHuntingGround = BotHuntingGroundPolicy.evaluate(currentGround, state);
        const destinationHuntingGround = BotHuntingGroundPolicy.evaluate(spot, state);
        const huntingGround = !currentHuntingGround.allowed
            ? currentHuntingGround
            : destinationHuntingGround;
        if (!huntingGround.allowed) {
            return {
                patch: {
                    activity: 'hunting',
                    stats: { ...(state.stats || {}), lastReason: huntingGround.reason }
                },
                events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: timestamp + 30000,
                debug: { reason: huntingGround.reason, spotId: spot.id, fights: 0, wins: 0 }
            };
        }

        const roundProfile = botCombatStats(state, timestamp);
        const profiles = roundProfiles(state, timestamp, roundProfile);
        const admitted = admittedShares(state, spot, timestamp, profiles);
        // T106: the round's kills are limited by the walk to each next mob and
        // by the share below; fights, gap heals, buffs and walks run by their
        // own time within the elapsed time. The fights a round may hold at
        // most (CPU bound): a mob engaged before, one per walk that starts
        // within the elapsed time. A profile without a template run speed
        // walks at the cold trip's.
        const walkMs = soloWalkMs(admittedDensity(spot, admitted), roundProfile.runSpd || RUN_SPEED, spot.spawnArea || undefined,
            ColdCombatProfile.attackReach(roundProfile));
        // A ranged bot on a dense spot may not walk: the round's action budget
        // still bounds its fights.
        const fights = Math.ceil(elapsedMs / Math.max(1, walkMs)) + 1;
        // The share's fraction left from the last round on this spot carries
        // over; a pull above it is owed (a negative carry).
        const share = soloShareMobs(spot, elapsedMs, spotHunters, admitted);
        const shareCarry = share !== null && String(state.stats?.coldShare?.spotId) === String(spot.id)
            ? Number(state.stats.coldShare.carry) || 0 : 0;
        const shareMobs = share === null ? Infinity : share + shareCarry;
        // A fight longer than the round goes on in the next (pveEncounter).
        const combatBudgetMs = elapsedMs;
        const actionBudget = fights * 48;
        const events = [];
        const materialize = { exp: 0, sp: 0, adena: 0, items: [] };
        const continuing = PveEncounter.read(state.stats?.pveEncounter, PveEncounter.key([state], spot, targetNpcId), timestamp);
        const patch = {
            vitals: continuing ? { ...state.vitals } : applyStandingRegen(state, state.vitals, elapsedMs, timestamp),
            activity: 'hunting',
            // A prior recovery deadline must not reschedule a new hunt in the
            // past. A fight that needs recovery below assigns a fresh deadline.
            // The pet heals between fights as the owner does (petRegen).
            stats: { ...((continuing ? state : petRegen(state, elapsedMs, roundProfile)).stats || {}), restUntil: null, pveEncounter: continuing },
            spotId: spot.id
        };

        let wins = 0;
        let died = false;
        let combatActions = 0;
        let shotActions = 0;
        let skillUses = 0;
        let heals = 0;
        // Of the heals, those cast between fights (SoloSelfHeal.betweenFights).
        let gapHeals = 0;
        // The pet's heals (PetHealRule), in fights and between them: apart from the bot's own.
        let petHeals = 0;
        let musicUses = 0;
        let summonUses = 0;
        let summonActions = 0;
        let potionsUsed = 0;
        const drunkPotions = {};
        let combatMs = 0;
        let damageTaken = 0, spellTaken = 0;
        // The pet's share (user 10-29: it tanks a solo fight): the damage it took, its deaths.
        let petTaken = 0, summonDeaths = 0;
        const foughtNpcIds = [];
        // The mobs killed by species (the spot table's measured kill mix).
        const killedNpcs = {};
        const soulCrystals = [];
        let attemptedFights = 0;
        let completedFights = 0;
        let pulls = 0;
        let pullMobs = 0;
        let areaPullHits = 0;
        let mobsKilled = 0;
        let shareCut = 0;
        let walkedMs = 0, buffCasts = 0, buffsTried = false;
        // The fights' shared setup (resolveFight's round).
        const round = {};
        // The bottles that save rest (coldRestPotions) go into the round's
        // counts; returns the ms they run for.
        const drinkToRest = (profile, resting, pet) => {
            const drank = coldRestPotions(profile, patch.vitals, patch.stats, patch.inventory || state.inventory,
                timestamp + combatMs, { resting, pet, shared: state.inventory });
            if (!drank.count) return 0;
            patch.inventory = drank.bag;
            patch.stats.coldCombat = { ...patch.stats.coldCombat, potionUntil: drank.until };
            potionsUsed += drank.count;
            for (const [selfId, count] of Object.entries(drank.drunk)) {
                drunkPotions[selfId] = Number(drunkPotions[selfId] || 0) + count;
            }
            if (Diagnostics.active()) Diagnostics.count('cold_fight', 'potion', 'rest', drank.count);
            return drank.ms;
        };

        for (let i = 0; i < fights; i++) {
            // The first fight starts in any round (its readiness may send the bot to rest).
            if (i > 0 && (combatMs >= combatBudgetMs || combatActions >= actionBudget)) break;
            // A mob already engaged is finished; a new one needs a whole mob of the share.
            const engaged = i === 0 && !!continuing;
            if (mobsKilled + 1 > shareMobs && !engaged) {
                // The fights the walk would still allow.
                shareCut = Math.max(1, Math.ceil((combatBudgetMs - combatMs) / Math.max(1, walkMs)));
                break;
            }
            if (!engaged) {
                // Its own buffs first (a round builds the fighter for them once at most).
                const buffed = buffsTried ? null : castSoloBuffs({ ...state, vitals: patch.vitals,
                    inventory: patch.inventory || state.inventory,
                    stats: { ...(state.stats || {}), ...(patch.stats || {}) } }, timestamp + combatMs, roundProfile);
                if (buffed) {
                    buffsTried = buffed.buffCasts === 0;
                    applySoloBuffs(patch, buffed, timestamp + combatMs);
                    combatMs += buffed.durationMs;
                    buffCasts += buffed.buffCasts;
                }
                // Then the walk to the mob. A walk past the round's end
                // engages the mob still (the opening action, at least 1 ms of
                // fight): its fight goes on in the next round.
                combatMs += walkMs;
                walkedMs += walkMs;
            }
            const fightState = {
                ...state,
                vitals: patch.vitals,
                inventory: patch.inventory || state.inventory,
                stats: { ...(state.stats || {}), ...(patch.stats || {}) }
            };
            const result = countedBuilds('fight', 'solo', resolveFight, { state: fightState, spot, pressure, targetNpcId, rng,
                timestamp: timestamp + combatMs, fightLimitMs: Math.max(1, combatBudgetMs - combatMs),
                maxActions: actionBudget - combatActions, roundProfiles: profiles, round });
            if (result.avoided) {
                patch.stats.lastReason = result.reason;
                if (result.needsRest) {
                    patch.activity = 'resting';
                    const drinkMs = drinkToRest(roundProfile, true, coldPetView(roundProfile, patch.stats.coldCombat?.summon, patch.vitals,
                        patch.stats.coldCombat?.cooldowns, timestamp + combatMs));
                    patch.stats.restUntil = timestamp + Math.max(estimateRestMs(fightState, patch.vitals), drinkMs);
                    events.push({ type: 'rest', weight: 2,
                        summary: `${state.name || 'Bot'} sat down before another fight near ${spot.name}`,
                        meta: { spotId: spot.id, reason: result.reason } });
                }
                break;
            }
            attemptedFights += 1;
            if (result.won || result.died) completedFights += 1;
            patch.stats.pveEncounter = result.encounter || null;
            patch.vitals.hp = result.hp;
            patch.vitals.maxHp = result.maxHp;
            patch.vitals.mp = result.mp;
            patch.vitals.maxMp = result.maxMp;
            patch.inventory = result.inventory || patch.inventory || state.inventory;
            soulCrystals.push(...(result.soulCrystals || []));
            patch.stats = {
                ...(patch.stats || state.stats || {}),
                // patch.stats starts as the state's stats, so its coldCombat
                // carries every field of the state's (or of the seed the
                // first fight seeded it with): only a bot without one builds.
                coldCombat: {
                    ...(patch.stats?.coldCombat || ColdCombatProfile.seedSnapshot(fightState, timestamp)),
                    effects: result.effects || patch.stats?.coldCombat?.effects || [],
                    cooldowns: result.cooldowns || {},
                    ...(result.potionUntil ? { potionUntil: result.potionUntil } : {}),
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
            shotActions += Number(result.debug?.shotActions || 0);
            // A kill costs at least its killing action (T126), walk or not:
            // the swing or cast that killed ends after the kill.
            combatMs += Math.max(Number(result.debug?.durationMs || 0), Number(result.debug?.killMs || 0));
            skillUses += Number(result.debug?.skillUses || 0);
            heals += Number(result.debug?.heals || 0);
            petHeals += Number(result.debug?.petHeals || 0);
            musicUses += Number(result.debug?.musicUses || 0);
            summonUses += Number(result.debug?.summonUses || 0);
            summonActions += Number(result.debug?.summonActions || 0);
            potionsUsed += Number(result.debug?.potionsUsed || 0);
            damageTaken += Number(result.debug?.damageTaken || 0);
            spellTaken += Number(result.debug?.spellTaken || 0);
            petTaken += Number(result.debug?.petTaken || 0);
            summonDeaths += Number(result.debug?.summonDeaths || 0);
            if (result.debug?.pullMobs > 0) {
                pulls += 1;
                pullMobs += result.debug.pullMobs;
            }
            areaPullHits += Number(result.debug?.areaPullHits || 0);
            for (const [selfId, count] of Object.entries(result.debug?.drunkPotions || {})) {
                drunkPotions[selfId] = Number(drunkPotions[selfId] || 0) + Number(count);
            }

            if (result.won) {
                wins += 1;
                // The share pays the kills the fight paid, also for a pull begun last round.
                const paid = Math.max(1, Number(result.debug?.killsPaid) || 1);
                mobsKilled += paid;
                if (Number(result.debug?.mobSelfId) > 0) {
                    foughtNpcIds.push(Number(result.debug.mobSelfId));
                    killedNpcs[result.debug.mobSelfId] = (killedNpcs[result.debug.mobSelfId] || 0) + paid;
                }
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
            // A won fight's gap: the pet's heals, then the self-heals that
            // beat sitting (SoloSelfHeal, T107); the shots of the round.
            if (result.won && result.profile) {
                // The round's inventory: the fight spent from its own copy (resolveFight), not fightState's.
                const shooter = round.shot ? { shot: round.shot, state: { ...fightState, inventory: round.inventory || patch.inventory },
                    shotActions: 0 } : null;
                const healed = coldHealBetweenFights(result.profile, patch.vitals, patch.stats.coldCombat.cooldowns,
                    timestamp + combatMs, patch.stats.coldCombat.summon, { shooter });
                if (shooter) { round.shot = shooter.shot; shotActions += shooter.shotActions; }
                combatMs += healed.ms;
                heals += healed.casts;
                gapHeals += healed.casts;
                petHeals += healed.petCasts;
                skillUses += healed.casts + healed.petCasts;
            }

            const hpPct = patch.vitals.hp / Math.max(1, patch.vitals.maxHp || patch.vitals.hp);
            const mpPct = patch.vitals.mp / Math.max(1, patch.vitals.maxMp || patch.vitals.mp || 1);
            const summonLeft = patch.stats.coldCombat?.summon;
            const petView = coldPetView(result.profile, summonLeft, patch.vitals, patch.stats.coldCombat?.cooldowns, timestamp + combatMs);
            // A rest is a between-fights choice, as HuntingState's (its guard
            // !encounterActionInFlight): a fight the round cut goes on in the
            // next round, whatever the bot's HP and MP; only a kill, a death
            // or the slice bound below ends it. The rest is decided at the HP
            // the fight left: a bottle's heal runs on while the hot bot sits down.
            const resting = !patch.stats.pveEncounter && needsRest(fightState, patch.vitals, { pet: petView });
            const drinkMs = result.won || resting ? drinkToRest(result.profile || roundProfile, resting, petView) : 0;
            if (resting) {
                // cold_fight:pet:rest: a rest its pet sent it to (the live read).
                if (Diagnostics.active() && !RestPolicy.petRested(petView)) Diagnostics.count('cold_fight', 'pet', 'rest');
                patch.activity = 'resting';
                patch.stats = {
                    ...(patch.stats || state.stats || {}),
                    restUntil: timestamp + Math.max(estimateRestMs(fightState, patch.vitals), drinkMs,
                        RestPolicy.petRested(petView) ? 0 : petRestMs(result.profile, summonLeft, patch.vitals, timestamp + combatMs))
                };
                events.push({
                    type: 'rest',
                    summary: `${state.name || 'Bot'} sat down to recover near ${spot.name}`,
                    weight: 2,
                    meta: { spotId: spot.id, hpPct, mpPct }
                });
                break;
            }
            if (result.debug?.timedOut) {
                if (patch.stats.pveEncounter?.slices >= PveEncounter.MAX_SLICES) {
                    patch.stats.pveEncounter = null;
                    patch.stats.lastReason = 'pve_encounter_stalled';
                    completedFights += 1;
                }
                break;
            }
        }

        if (share !== null) {
            const left = shareMobs - mobsKilled;
            // Whole mobs left unused stay for the other hunters.
            patch.stats.coldShare = { spotId: spot.id, carry: Math.round((left < 0 ? left : left % 1) * 1000) / 1000 };
        }
        // cold_fight:pet: the round's pet damage, deaths and heals for the live read; only while diagnostics count.
        if (Diagnostics.active()) {
            if (petTaken > 0) Diagnostics.count('cold_fight', 'pet', 'taken', Math.round(petTaken));
            if (summonDeaths > 0) Diagnostics.count('cold_fight', 'pet', 'deaths', summonDeaths);
            if (petHeals > 0) Diagnostics.count('cold_fight', 'pet', 'heals', petHeals);
        }

        // The round's sample is recorded once its lifecycle is applied
        // (BotLifeState.prepareResolve): net exp, until the next round.
        const lootValue = invoke('GameServer/Bot/AI/BotHuntEfficiency').lootValue(materialize.items);
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
            soulCrystals,
            nextResolveAt: patch.stats?.restUntil || timestamp + huntCycleDelayMs(rng()),
            debug: {
                elapsedMs,
                combatMs,
                fights: completedFights,
                attemptedFights,
                pendingFight: !!patch.stats.pveEncounter,
                wins,
                died,
                lootValue,
                dropsRolled: materialize.items.length,
                dropsAwarded: materialize.items.reduce((sum, item) => sum + Number(item.amount || 0), 0),
                spotId: spot.id,
                route: spot.route || null,
                combatActions,
                shotActions,
                skillUses,
                heals,
                gapHeals,
                petHeals,
                musicUses,
                summonUses,
                summonActions,
                potionsUsed,
                drunkPotions,
                damageTaken,
                spellTaken,
                petTaken,
                summonDeaths,
                pulls,
                pullMobs,
                areaPullHits,
                shareCut,
                walkedMs,
                buffCasts,
                targetNpcId: Number(targetNpcId) || null,
                targetOnSpot: ColdCombatProfile.spotSpawns(spot, targetNpcId) ? 1 : 0,
                foughtNpcIds,
                mobsKilled,
                killedNpcs
            }
        };
    }
};

// Keep pause accounting outside the resolver's many lifecycle early returns.
// Even a missing spot or changed activity must clear a consumed pause.
const resolveSolo = BackgroundResolver.resolveSolo;
BackgroundResolver.resolveSolo = (options = {}) => {
    const timestamp = options.timestamp ?? Date.now();
    const competition = invoke('GameServer/Bot/Population/ColdCompetitionWait').consume(options.state, options.elapsedMs ?? 60000, timestamp);
    const competitionReason = options.state?.stats?.coldCompetition?.action === 'contest' ? 'competition_contest' : 'competition_yield';
    if (competition.waiting) return { patch: { stats: { ...options.state?.stats, pveEncounter: null } }, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        nextResolveAt: competition.until, debug: { reason: competitionReason, fights: 0, wins: 0 } };
    const result = options.state?.stats?.coldCompetition?.wait && competition.state && competition.elapsedMs === 0
        ? { patch: { stats: competition.state.stats }, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
            nextResolveAt: timestamp + 1000, debug: { reason: competitionReason, fights: 0, wins: 0 } }
        : countedBuilds('step', 'solo', resolveSolo, {
            ...options, state: competition.state, elapsedMs: competition.elapsedMs, timestamp
        });
    if (options.state?.stats?.pveEncounter && !Object.hasOwn(result.debug || {}, 'pendingFight')) {
        result.patch = { ...result.patch, stats: { ...(result.patch?.stats || options.state.stats), pveEncounter: null } };
    }
    if (options.state?.stats?.coldCompetition?.wait) {
        result.patch = { ...result.patch, stats: { ...(result.patch?.stats || competition.state.stats),
            coldCompetition: { ...competition.state.stats.coldCompetition, wait: null } } };
    }
    return result;
};
module.exports = BackgroundResolver;
BackgroundResolver.coldRestRegenPerTick = coldRestRegenPerTick;
