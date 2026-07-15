const ProgressionRates = invoke('GameServer/ProgressionRates');

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

function estimateRestMs(vitals, stats) {
    const missingHp = Math.max(0, stats.maxHp - Number(vitals.hp || 0));
    const missingMp = Math.max(0, stats.maxMp - Number(vitals.mp || 0));
    const hpRegenPerSecond = Math.max(2, stats.maxHp * 0.035);
    const mpRegenPerSecond = Math.max(1, stats.maxMp * 0.028);
    const hpSeconds = missingHp / hpRegenPerSecond;
    const mpSeconds = missingMp / mpRegenPerSecond;

    return Math.round(Math.max(hpSeconds, mpSeconds, 8) * 1000);
}

function resolveTravel(state, timestamp = Date.now()) {
    const travel = state.stats?.travel;
    if (!travel?.to || !travel?.arrivalAt) return null;
    const startedAt = Number(travel.startedAt || timestamp);
    const arrivalAt = Number(travel.arrivalAt);
    const progress = Math.max(0, Math.min(1, (timestamp - startedAt) / Math.max(1, arrivalAt - startedAt)));
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
            type: travel.arrivalEvent || 'arrived_town',
            summary: arrivalActivity === 'shopping'
                ? `${state.name || 'Bot'} arrived in ${travel.townName || 'town'} to shop`
                : `${state.name || 'Bot'} returned to ${travel.regionName || 'the hunting area'}`,
            weight: 2,
            meta: { townName: travel.townName || null, reason: travel.reason || null }
        }] : [],
        materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        nextResolveAt: timestamp + (arrived && arrivalActivity === 'shopping' ? 120000 : 30000),
        debug: { activity: 'traveling', arrived, progress, townName: travel.townName || null, arrivalActivity }
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
    const loot = rng() < 0.08 ? [{
        selfId: 57,
        name: 'Adena',
        amount: Math.max(1, Math.round(adena * 0.15))
    }] : [];

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
    resolveSolo({ state, spot, pressure = {}, elapsedMs = 60000, rng = Math.random }) {
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
            const travelResult = resolveTravel(state);
            if (travelResult) return travelResult;
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
                patch.restUntil = Date.now() + estimateRestMs(patch.vitals, botCombatStats(fightState, roleProfile(fightState)));
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
            nextResolveAt: Date.now() + 30000 + Math.round(rng() * 90000),
            debug: {
                elapsedMs,
                fights,
                wins,
                died,
                spotId: spot.id,
                route: spot.route || null
            }
        };
    }
};

module.exports = BackgroundResolver;
