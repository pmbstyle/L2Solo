const ProgressionRates = invoke('GameServer/ProgressionRates');
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');

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

function estimateRestMs(state, vitals) {
    const maxHp = Number(vitals.maxHp || vitals.hp || 1);
    const maxMp = Number(vitals.maxMp || vitals.mp || 1);
    const missingHp = Math.max(0, maxHp - Number(vitals.hp || 0));
    const missingMp = Math.max(0, maxMp - Number(vitals.mp || 0));
    const regen = coldRestRegenPerTick(state);
    const hpSeconds = missingHp / Math.max(0.01, regen.hp / 3);
    const mpSeconds = missingMp / Math.max(0.01, regen.mp / 3);

    return Math.round(Math.max(hpSeconds, mpSeconds, 8) * 1000);
}

function resolveRest(state, elapsedMs, timestamp) {
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
    const mpReady = vitals.mp / Math.max(1, vitals.maxMp) >= 0.95;
    const scheduledRemainingMs = Math.max(0, Number(state.stats?.restUntil || 0) - timestamp);
    const remainingMs = Math.max(estimateRestMs(state, vitals), scheduledRemainingMs);
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
        debug: { activity: resting ? 'resting' : 'recovered', regen, remainingMs }
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
        || ['component_craft', 'component_craft_return', 'equipment_craft', 'equipment_craft_return', 'return_after_market'].includes(travel.reason);
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
                restUntil: timestamp + respawnDelayMs
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

function chooseSkill(profile, mp, cooldowns, time) {
    return ColdCombatProfile.offensiveSkills(profile)
        .filter((skill) => Number(skill.mp || 0) <= mp && Number(cooldowns[skill.selfId] || 0) <= time)
        .map((skill) => {
            const magic = skill.spell === true;
            const rawDamage = magic
                ? Formulas.calcMagicDamage(profile.mAtk, Math.max(1, Number(skill.power) || 1), 1)
                : Formulas.calcPhysicalDamage(profile.pAtk, profile.equipment.pAtkRnd, 1, Number(skill.power) || 0);
            return { skill, magic, score: rawDamage / actionDelayMs(profile, skill) };
        })
        .sort((a, b) => b.score - a.score)[0] || null;
}

function resolveFight({ state, spot, pressure, rng, timestamp = Date.now() }) {
    const bot = botCombatStats(state, timestamp);
    const mob = ColdCombatProfile.npcForSpot(spot, rng) || {
        level: Number(spot.avgLevel || bot.level), maxHp: Math.max(1, Number(spot.mob?.hp || 1)),
        pAtk: Math.max(1, Number(spot.mob?.damage || 1)), pAtkRnd: 0, pDef: 1, mDef: 1,
        accur: 1, evasion: 0, critical: 0, atkSpd: 253, mAtk: 1, castSpd: 333
    };
    const vitals = {
        hp: Number(state.vitals?.hp || bot.maxHp),
        mp: Number(state.vitals?.mp || bot.maxMp),
        maxHp: bot.maxHp,
        maxMp: bot.maxMp
    };
    let botReadyAt = 0;
    let mobReadyAt = 0;
    let time = 0;
    let mobHp = mob.maxHp;
    let actions = 0;
    let skillUses = 0;
    const cooldowns = { ...(state.stats?.coldCombat?.cooldowns || {}) };
    const fightLimitMs = 12000;

    // A resolve contains only a handful of fights, and a fight itself is
    // bounded by time and actions. This is deliberately cheaper than a live
    // Actor while retaining its hit, critical, damage and speed formulas.
    while (vitals.hp > 0 && mobHp > 0 && time < fightLimitMs && actions < 48) {
        const botActs = botReadyAt <= mobReadyAt;
        time = botActs ? botReadyAt : mobReadyAt;
        if (time >= fightLimitMs) break;
        actions += 1;

        if (botActs) {
            const selected = chooseSkill(bot, vitals.mp, cooldowns, timestamp + time);
            const skill = selected?.skill || null;
            const magic = selected?.magic === true;
            let damage = 0;
            if (magic) {
                const magicCritical = rng() < clamp(bot.critical / 1000, 0, 0.25);
                damage = Formulas.calcMagicDamage(bot.mAtk, Math.max(1, Number(skill.power) || 1), mob.mDef, { magicCritical });
            } else if (hitSucceeds(bot.accur, mob.evasion, rng)) {
                const critical = Formulas.rollCritical(bot.critical, rng);
                damage = Formulas.calcPhysicalDamage(bot.pAtk, bot.equipment.pAtkRnd, mob.pDef, Number(skill?.power) || 0, { critical });
            }
            mobHp -= Math.max(0, damage);
            if (skill) {
                vitals.mp = Math.max(0, vitals.mp - Number(skill.mp || 0));
                cooldowns[skill.selfId] = timestamp + time + Math.max(0, Number(skill.reuse || 0));
                skillUses += 1;
            }
            botReadyAt += actionDelayMs(bot, skill);
        } else if (hitSucceeds(mob.accur, bot.evasion, rng)) {
            const critical = Formulas.rollCritical(mob.critical, rng);
            const damage = Formulas.calcMeleeDamage(mob.pAtk, mob.pAtkRnd, bot.pDef, { critical });
            vitals.hp -= Math.max(0, damage);
            mobReadyAt += Math.max(250, Formulas.calcMeleeAtkTime(mob.atkSpd));
        } else {
            mobReadyAt += Math.max(250, Formulas.calcMeleeAtkTime(mob.atkSpd));
        }
    }

    const died = vitals.hp <= 0;
    const won = mobHp <= 0;
    if (!won) {
        return {
            won: false,
            died,
            hp: Math.max(0, Math.round(vitals.hp)),
            mp: Math.max(0, Math.round(vitals.mp)),
            exp: 0,
            sp: 0,
            adena: 0,
            loot: [],
            cooldowns,
            debug: { actions, skillUses, mobSelfId: mob.selfId || null, timedOut: !died }
        };
    }

    const rewards = spot.rewards;
    const expMultiplier = pressure?.expMultiplier || 1;
    const rates = ProgressionRates.profile();
    const adena = Math.round(randInt(rng, rewards.adenaMin, rewards.adenaMax) * rates.adena);
    const loot = BackgroundDropResolver.rollForFight({
        spot,
        killerLevel: Number(state.level || bot.level),
        rng
    });

    return {
        won: true,
        died: false,
        hp: Math.max(1, Math.round(vitals.hp)),
        mp: Math.max(0, Math.round(vitals.mp)),
        exp: Math.round(rewards.exp * expMultiplier * rates.exp),
        sp: Math.round(rewards.sp * expMultiplier * rates.sp),
        adena,
        loot,
        cooldowns,
        debug: { actions, skillUses, mobSelfId: mob.selfId || null, timedOut: false }
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

function resolvePartyFight({ members, spot, rng = Math.random, timestamp = Date.now() }) {
    const mob = ColdCombatProfile.npcForSpot(spot, rng) || {
        level: Number(spot.avgLevel || 1), maxHp: Math.max(1, Number(spot.mob?.hp || 1)),
        pAtk: Math.max(1, Number(spot.mob?.damage || 1)), pAtkRnd: 0, pDef: 1, mDef: 1,
        accur: 1, evasion: 0, critical: 0, atkSpd: 253
    };
    const fighters = members.map((state) => {
        const profile = botCombatStats(state, timestamp);
        return {
            state,
            profile,
            role: state.party?.role || state.stats?.role || 'dps',
            vitals: {
                hp: Math.min(profile.maxHp, Math.max(0, Number(state.vitals?.hp || profile.maxHp))),
                maxHp: profile.maxHp,
                mp: Math.min(profile.maxMp, Math.max(0, Number(state.vitals?.mp || profile.maxMp))),
                maxMp: profile.maxMp
            },
            cooldowns: { ...(state.stats?.coldCombat?.cooldowns || {}) },
            readyAt: 0,
            actions: 0,
            skillUses: 0,
            heals: 0
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
        const botActs = next && next.readyAt <= mobReadyAt;
        time = botActs ? next.readyAt : mobReadyAt;
        if (time >= fightLimitMs) break;
        actions += 1;

        if (botActs) {
            next.actions += 1;
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

            const selected = chooseSkill(next.profile, next.vitals.mp, next.cooldowns, timestamp + time);
            const skill = selected?.skill || null;
            let damage = 0;
            if (selected?.magic) {
                const magicCritical = rng() < clamp(next.profile.critical / 1000, 0, 0.25);
                damage = Formulas.calcMagicDamage(next.profile.mAtk, Math.max(1, Number(skill.power) || 1), mob.mDef, { magicCritical });
            } else if (hitSucceeds(next.profile.accur, mob.evasion, rng)) {
                damage = Formulas.calcPhysicalDamage(next.profile.pAtk, next.profile.equipment.pAtkRnd, mob.pDef, Number(skill?.power) || 0, {
                    critical: Formulas.rollCritical(next.profile.critical, rng)
                });
            }
            mobHp -= Math.max(0, damage);
            if (skill) {
                next.vitals.mp = Math.max(0, next.vitals.mp - Number(skill.mp || 0));
                next.cooldowns[skill.selfId] = timestamp + time + Math.max(0, Number(skill.reuse || 0));
                next.skillUses += 1;
            }
            next.readyAt += actionDelayMs(next.profile, skill);
        } else {
            const targets = fighters.filter((fighter) => fighter.vitals.hp > 0);
            const tank = targets.find((fighter) => fighter.role === 'tank');
            const target = tank || targets[Math.floor(rng() * targets.length)];
            if (target && hitSucceeds(mob.accur, target.profile.evasion, rng)) {
                const damage = Formulas.calcMeleeDamage(mob.pAtk, mob.pAtkRnd, target.profile.pDef, {
                    critical: Formulas.rollCritical(mob.critical, rng)
                });
                target.vitals.hp = Math.max(0, target.vitals.hp - damage);
            }
            mobReadyAt += Math.max(250, Formulas.calcMeleeAtkTime(mob.atkSpd));
        }
    }

    return {
        won: mobHp <= 0,
        timedOut: mobHp > 0 && fighters.some((fighter) => fighter.vitals.hp > 0),
        members: fighters,
        debug: { actions, mobSelfId: mob.selfId || null }
    };
}

const BackgroundResolver = {
    resolveRest,
    resolvePartyFight,
    resolveSolo({ state, spot, pressure = {}, elapsedMs = 60000, rng = Math.random, timestamp = Date.now() }) {
        if (!state) {
            return {
                patch: {},
                events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: Date.now() + 60000,
                debug: { reason: 'missing_state_or_spot' }
            };
        }

        if (state.activity === 'traveling') {
            const travelResult = resolveTravel(state, timestamp);
            if (travelResult) return travelResult;
        }

        if (staleShopping(state) && spot) {
            return {
                patch: {
                    activity: 'hunting',
                    spotId: spot.id,
                    currentRegion: state.homeRegion || state.currentRegion,
                    loc: { ...spot.center },
                    stats: { ...(state.stats || {}), legacyShoppingRecoveredAt: Date.now() }
                },
                events: [{
                    type: 'shopping_recovered',
                    summary: `${state.name || 'Bot'} left a stale town-shopping state and returned to hunting`,
                    weight: 1
                }],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: Date.now() + 30000,
                debug: { activity: 'shopping_recovered' }
            };
        }

        if (state.activity === 'shopping') {
            return {
                patch: { activity: 'shopping' },
                events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: Date.now() + 120000,
                debug: { activity: 'shopping' }
            };
        }

        if (state.activity === 'merchant') {
            return {
                patch: { activity: 'merchant' },
                events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: Date.now() + 60000,
                debug: { activity: 'merchant' }
            };
        }

        if (state.activity === 'crafting') {
            return {
                patch: { activity: 'crafting' },
                events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: Date.now() + 60000,
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
                nextResolveAt: Date.now() + 60000,
                debug: { reason: 'missing_spot' }
            };
        }

        const maxFights = Math.max(1, Math.floor(elapsedMs / 12000));
        const fights = Math.min(maxFights, Math.max(1, Math.ceil((spot.density || 1) / 3)));
        const events = [];
        const materialize = { exp: 0, sp: 0, adena: 0, items: [] };
        const patch = {
            vitals: { ...(state.vitals || {}) },
            activity: 'hunting',
            spotId: spot.id
        };

        let wins = 0;
        let died = false;
        let combatActions = 0;
        let skillUses = 0;

        for (let i = 0; i < fights; i++) {
            const fightState = { ...state, vitals: patch.vitals };
            const result = resolveFight({ state: fightState, spot, pressure, rng, timestamp });
            patch.vitals.hp = result.hp;
            patch.vitals.mp = result.mp;
            patch.stats = {
                ...(patch.stats || state.stats || {}),
                coldCombat: {
                    ...(state.stats?.coldCombat || ColdCombatProfile.profileFor(fightState, timestamp)),
                    cooldowns: result.cooldowns || {}
                }
            };
            materialize.exp += result.exp;
            materialize.sp += result.sp;
            materialize.adena += result.adena;
            materialize.items.push(...result.loot);
            combatActions += Number(result.debug?.actions || 0);
            skillUses += Number(result.debug?.skillUses || 0);

            if (result.won) wins += 1;
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
            if (hpPct < 0.35 || mpPct < 0.2) {
                patch.activity = 'resting';
                patch.stats = {
                    ...(state.stats || {}),
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
                skillUses
            }
        };
    }
};

module.exports = BackgroundResolver;
