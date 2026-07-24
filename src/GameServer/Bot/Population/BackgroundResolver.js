const ProgressionRates = invoke('GameServer/ProgressionRates');
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');

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

function roleProfile(state = {}) {
    const role = state.party?.role || state.stats?.role || 'dps';
    const base = {
        role,
        damageMultiplier: 1,
        defenseMultiplier: 1,
        manaPerFight: 2,
        deathMultiplier: 1
    };

    if (role === 'tank') {
        base.damageMultiplier = 0.85;
        base.defenseMultiplier = 1.35;
        base.deathMultiplier = 0.65;
    } else if (role === 'healer') {
        base.damageMultiplier = 0.72;
        base.defenseMultiplier = 0.95;
        base.manaPerFight = 7;
        base.deathMultiplier = 0.75;
    } else if (role === 'buffer') {
        base.damageMultiplier = 0.85;
        base.defenseMultiplier = 1.05;
        base.manaPerFight = 5;
    } else if (role === 'archer' || role === 'mage') {
        base.damageMultiplier = 1.18;
        base.defenseMultiplier = 0.85;
        base.manaPerFight = role === 'mage' ? 9 : 3;
    } else if (role === 'dagger') {
        base.damageMultiplier = 1.12;
        base.defenseMultiplier = 0.9;
        base.manaPerFight = 4;
    }

    return base;
}

function botCombatStats(state, role) {
    const level = midpointBand(state.levelBand);
    const vitals = state.vitals || {};
    const maxHp = Number(vitals.maxHp || vitals.hp || 100 + level * 35);
    const maxMp = Number(vitals.maxMp || vitals.mp || 50 + level * 18);

    return {
        level,
        maxHp,
        maxMp,
        damage: Math.max(4, Math.round((8 + level * 4.3) * role.damageMultiplier)),
        defense: Math.max(1, (1 + level * 0.06) * role.defenseMultiplier),
        manaPerFight: role.manaPerFight
    };
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
    const combat = botCombatStats(state, roleProfile(state));
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
    const combat = botCombatStats(state, roleProfile(state));
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

function resolveFight({ state, spot, pressure, rng }) {
    const role = roleProfile(state);
    const bot = botCombatStats(state, role);
    const vitals = {
        hp: Number(state.vitals?.hp || bot.maxHp),
        mp: Number(state.vitals?.mp || bot.maxMp),
        maxHp: bot.maxHp,
        maxMp: bot.maxMp
    };
    const mobHp = Math.max(1, spot.mob.hp);
    const mobDamage = Math.max(1, Math.round(spot.mob.damage / bot.defense));
    const botHitsToKill = Math.ceil(mobHp / bot.damage);
    const mobHitsToKill = Math.ceil(vitals.hp / mobDamage);
    const pressureDeath = pressure?.deathChanceMultiplier || 1;

    if (mobHitsToKill < botHitsToKill) {
        const deathChance = clamp(0.35 * role.deathMultiplier * pressureDeath, 0.05, 0.95);
        if (rng() < deathChance) {
            return {
                won: false,
                died: true,
                hp: 0,
                mp: Math.max(0, vitals.mp - bot.manaPerFight),
                exp: 0,
                sp: 0,
                adena: 0,
                loot: []
            };
        }

        return {
            won: false,
            died: false,
            hp: Math.max(1, Math.round(vitals.maxHp * 0.18)),
            mp: Math.max(0, vitals.mp - bot.manaPerFight),
            exp: 0,
            sp: 0,
            adena: 0,
            loot: []
        };
    }

    const hitsTaken = Math.max(0, botHitsToKill - 1);
    const remainingHp = Math.max(1, vitals.hp - hitsTaken * mobDamage);
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
        hp: remainingHp,
        mp: Math.max(0, vitals.mp - bot.manaPerFight),
        exp: Math.round(rewards.exp * expMultiplier * rates.exp),
        sp: Math.round(rewards.sp * expMultiplier * rates.sp),
        adena,
        loot
    };
}

const BackgroundResolver = {
    resolveRest,
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

        for (let i = 0; i < fights; i++) {
            const fightState = { ...state, vitals: patch.vitals };
            const result = resolveFight({ state: fightState, spot, pressure, rng });
            patch.vitals.hp = result.hp;
            patch.vitals.mp = result.mp;
            materialize.exp += result.exp;
            materialize.sp += result.sp;
            materialize.adena += result.adena;
            materialize.items.push(...result.loot);

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
                route: spot.route || null
            }
        };
    }
};

module.exports = BackgroundResolver;
