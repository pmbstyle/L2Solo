const ProgressionRates = invoke('GameServer/ProgressionRates');
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');

const MAX_DROPS_PER_RESOLVE = 4;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function randInt(rng, min, max) {
    return Math.floor(rng() * (max - min + 1)) + min;
}

function roleCount(party, role) {
    return Number(party.roleCoverage?.[role] || 0);
}

function memberVitals(state) {
    const level = Number(state.level || 1);
    const vitals = state.vitals || {};
    const maxHp = Number(vitals.maxHp || vitals.hp || 100 + level * 35);
    const maxMp = Number(vitals.maxMp || vitals.mp || 50 + level * 18);

    return {
        hp: Number(vitals.hp || maxHp),
        maxHp,
        mp: Number(vitals.mp || maxMp),
        maxMp
    };
}

function avgLevel(members) {
    const total = members.reduce((sum, state) => sum + Number(state.level || 1), 0);
    return total / Math.max(1, members.length);
}

function estimateFightCount({ party, members, spot, elapsedMs }) {
    const baseWindows = Math.max(1, Math.floor(elapsedMs / 10000));
    const memberFactor = Math.max(1, members.length * 0.75);
    const densityFactor = clamp(Number(spot.density || 1) / 3, 0.7, 2.2);
    const cohesionFactor = clamp(Number(party.cohesion || 0.65), 0.35, 1.15);

    return Math.max(1, Math.min(24, Math.round(baseWindows * memberFactor * densityFactor * cohesionFactor)));
}

function estimateWinRate({ party, members, spot, pressure }) {
    const partyLevel = avgLevel(members);
    const levelDelta = partyLevel - Number(spot.avgLevel || partyLevel);
    const tank = roleCount(party, 'tank') > 0;
    const healer = roleCount(party, 'healer') > 0;
    const buffer = roleCount(party, 'buffer') > 0;
    const support = (tank ? 0.05 : 0) + (healer ? 0.07 : 0) + (buffer ? 0.06 : 0);
    const size = clamp((members.length - 2) * 0.035, 0, 0.12);
    const risk = Number(party.risk || 0.25) * 0.18 + Number(spot.risk || 0) * 0.025;
    const pressureDeath = Number(pressure?.deathChanceMultiplier || 1);

    return clamp(0.63 + levelDelta * 0.035 + support + size - risk * pressureDeath, 0.18, 0.96);
}

function distributeRewards({ members, spot, wins, pressure, rng }) {
    const rewards = spot.rewards;
    const expMultiplier = Number(pressure?.expMultiplier || 1);
    const rates = ProgressionRates.profile();
    const totalAdena = Array.from({ length: wins }).reduce((sum) => (
        sum + Math.round(randInt(rng, rewards.adenaMin, rewards.adenaMax) * rates.adena)
    ), 0);
    const loot = members.map(() => []);
    for (let win = 0; win < Math.min(wins, MAX_DROPS_PER_RESOLVE); win++) {
        const drops = BackgroundDropResolver.rollForFight({
            spot,
            killerLevel: Math.round(avgLevel(members)),
            rng
        });
        if (!drops.length) continue;
        loot[Math.min(members.length - 1, Math.floor(rng() * members.length))].push(...drops);
    }

    return members.map((state, index) => ({
        state,
        exp: Math.round((rewards.exp * wins * expMultiplier * rates.exp) / members.length),
        sp: Math.round((rewards.sp * wins * expMultiplier * rates.sp) / members.length),
        adena: Math.round(totalAdena / members.length),
        items: loot[index]
    }));
}

const BackgroundPartyResolver = {
    resolve({ party, members, spot, pressure = {}, elapsedMs = 60000, rng = Math.random }) {
        if (!party || !members?.length || !spot) {
            return {
                memberResults: [],
                events: [],
                partyPatch: {},
                nextResolveAt: Date.now() + 60000,
                debug: { reason: 'missing_party_members_or_spot' }
            };
        }

        const fights = estimateFightCount({ party, members, spot, elapsedMs });
        const winRate = estimateWinRate({ party, members, spot, pressure });
        let wins = 0;
        for (let i = 0; i < fights; i++) {
            if (rng() <= winRate) wins += 1;
        }

        const losses = fights - wins;
        const hasTank = roleCount(party, 'tank') > 0;
        const hasHealer = roleCount(party, 'healer') > 0;
        const damageScale = clamp(0.18 + losses * 0.08 - (hasTank ? 0.05 : 0) - (hasHealer ? 0.06 : 0), 0.05, 0.75);
        const deathChance = clamp((losses / Math.max(1, fights)) * (hasHealer ? 0.12 : 0.22) * (hasTank ? 0.75 : 1), 0, 0.45);
        const rewards = distributeRewards({ members, spot, wins, pressure, rng });
        const memberResults = [];
        const events = [];
        let deaths = 0;
        let resting = 0;

        rewards.forEach(({ state, exp, sp, adena, items }) => {
            const vitals = memberVitals(state);
            const role = state.party?.role || state.stats?.role || 'dps';
            const mpUse = role === 'healer' ? wins * 5 + losses * 4 : role === 'buffer' ? wins * 3 : wins * 2;
            const hpLoss = Math.round(vitals.maxHp * damageScale * (0.65 + rng() * 0.45));
            let hp = Math.max(1, vitals.hp - hpLoss);
            let mp = Math.max(0, vitals.mp - mpUse);
            let activity = 'grouped';
            let deathCount = state.stats?.deaths || 0;

            if (losses > 0 && rng() < deathChance) {
                hp = 0;
                activity = 'dead';
                deathCount += 1;
                deaths += 1;
                events.push({
                    characterId: state.characterId,
                    type: 'death',
                    summary: `${state.name || 'Bot'} died while grouped near ${spot.name}`,
                    weight: 4,
                    meta: { partyId: party.partyId, spotId: spot.id, fights, wins }
                });
            } else {
                const hpPct = hp / Math.max(1, vitals.maxHp);
                const mpPct = mp / Math.max(1, vitals.maxMp);
                if (hpPct < 0.3 || mpPct < 0.18) {
                    activity = 'resting';
                    resting += 1;
                }
            }

            memberResults.push({
                state,
                result: {
                    patch: {
                        activity,
                        spotId: spot.id,
                        deathCount,
                        vitals: {
                            hp,
                            maxHp: vitals.maxHp,
                            mp,
                            maxMp: vitals.maxMp
                        }
                    },
                    events: [],
                    materialize: { exp, sp, adena, items },
                    nextResolveAt: Date.now() + 45000 + Math.round(rng() * 90000),
                    debug: {
                        partyId: party.partyId,
                        fights,
                        wins,
                        losses,
                        spotId: spot.id,
                        route: spot.route || null,
                        aggregate: true
                    }
                }
            });
        });

        if (wins > 0) {
            events.push({
                characterId: party.leaderId,
                type: 'party_hunt',
                summary: `Party ${party.partyId} won ${wins} fights near ${spot.name}`,
                weight: wins >= 6 ? 3 : 2,
                meta: { partyId: party.partyId, spotId: spot.id, fights, wins, losses }
            });
        }

        const cohesionDelta = wins >= losses ? 0.015 : -0.035;
        const riskDelta = deaths > 0 ? 0.05 : losses > wins ? 0.02 : -0.01;

        return {
            memberResults,
            events,
            partyPatch: {
                cohesion: clamp(Number(party.cohesion || 0.65) + cohesionDelta, 0.1, 1),
                risk: clamp(Number(party.risk || 0.25) + riskDelta, 0.05, 0.95),
                stats: {
                    fightsResolved: Number(party.stats?.fightsResolved || 0) + fights,
                    fightsWon: Number(party.stats?.fightsWon || 0) + wins,
                    deaths: Number(party.stats?.deaths || 0) + deaths,
                    rests: Number(party.stats?.rests || 0) + resting,
                    lastResolveAt: Date.now()
                }
            },
            nextResolveAt: Date.now() + 45000 + Math.round(rng() * 90000),
            debug: { fights, wins, losses, deaths, resting, spotId: spot.id, route: spot.route || null }
        };
    }
};

module.exports = BackgroundPartyResolver;
