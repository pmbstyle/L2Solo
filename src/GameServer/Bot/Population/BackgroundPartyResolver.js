const ProgressionRates = invoke('GameServer/ProgressionRates');
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const PartyAffinity = invoke('GameServer/Bot/Population/BackgroundPartyAffinity');
const PartyLootAllocator = invoke('GameServer/Bot/Population/PartyLootAllocator');

const MAX_DROPS_PER_RESOLVE = 4;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function randInt(rng, min, max) {
    return Math.floor(rng() * (max - min + 1)) + min;
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
    const baseWindows = Math.max(1, Math.floor(elapsedMs / 12000));
    const densityFactor = clamp(Number(spot.density || 1) / 3, 0.7, 2.2);
    const cohesionFactor = clamp(Number(party.cohesion || 0.65), 0.35, 1.15);

    // Party actions are individually simulated, so party size must not
    // multiply work.  Keep the same short active window as solo combat.
    return Math.max(1, Math.min(4, Math.round(baseWindows * densityFactor * cohesionFactor)));
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
    resolve({ party, members, spot, pressure = {}, elapsedMs = 60000, rng = Math.random, timestamp = Date.now() }) {
        if (!party || !members?.length || !spot) {
            return {
                memberResults: [],
                events: [],
                partyPatch: {},
                nextResolveAt: Date.now() + 60000,
                debug: { reason: 'missing_party_members_or_spot' }
            };
        }

        // A party shares its hunting cadence.  If even one member is resting,
        // pause the whole group: otherwise the resolver keeps granting fights
        // and draining the exhausted member on every cold tick.
        if (members.some((state) => state.activity === 'resting')) {
            const partyRestUntil = Math.max(
                Number(party.stats?.restUntil || 0),
                ...members.map((state) => Number(state.stats?.restUntil || 0))
            );
            const memberResults = members.map((state) => ({
                state,
                result: BackgroundResolver.resolveRest({
                    ...state,
                    activity: 'resting',
                    // A party sits down together.  Members already ready do
                    // not wake and consume solo capacity while the healer is
                    // still recovering.
                    stats: { ...(state.stats || {}), restUntil: partyRestUntil || null }
                }, elapsedMs, timestamp)
            }));
            const resting = memberResults.filter(({ result }) => result.patch.activity === 'resting').length;
            const nextRestUntil = resting
                ? Math.max(...memberResults.map(({ result }) => Number(result.patch.stats?.restUntil || 0)))
                : null;
            const synchronizedMemberResults = resting
                ? memberResults.map(({ state, result }) => ({
                    state,
                    result: {
                        ...result,
                        patch: {
                            ...result.patch,
                            activity: 'resting',
                            stats: { ...(result.patch.stats || {}), restUntil: nextRestUntil }
                        },
                        nextResolveAt: nextRestUntil
                    }
                }))
                : memberResults;

            return {
                memberResults: synchronizedMemberResults,
                events: [],
                partyPatch: {
                    cohesion: Number(party.cohesion || 0.65),
                    risk: Number(party.risk || 0.25),
                    stats: {
                        ...(party.stats || {}),
                        rests: Number(party.stats?.rests || 0) + 1,
                        restUntil: nextRestUntil,
                        lastResolveAt: timestamp
                    }
                },
                nextResolveAt: resting ? nextRestUntil : timestamp + 45000,
                debug: {
                    activity: resting > 0 ? 'resting' : 'recovered',
                    fights: 0,
                    wins: 0,
                    losses: 0,
                    deaths: 0,
                    resting,
                    dropsRolled: 0,
                    dropsAwarded: 0,
                    spotId: spot.id,
                    route: spot.route || null
                }
            };
        }

        const fights = estimateFightCount({ party, members, spot, elapsedMs });
        let wins = 0;
        let losses = 0;
        let combatActions = 0;
        let skillUses = 0;
        let heals = 0;
        let combatMembers = members.map((state) => ({ ...state }));
        for (let i = 0; i < fights; i++) {
            const encounter = BackgroundResolver.resolvePartyFight({ members: combatMembers, spot, rng, timestamp });
            combatActions += Number(encounter.debug?.actions || 0);
            skillUses += encounter.members.reduce((sum, member) => sum + Number(member.skillUses || 0), 0);
            heals += encounter.members.reduce((sum, member) => sum + Number(member.heals || 0), 0);
            combatMembers = encounter.members.map((member) => ({
                ...member.state,
                vitals: { ...member.vitals },
                stats: {
                    ...(member.state.stats || {}),
                    coldCombat: { ...(member.state.stats?.coldCombat || member.profile), cooldowns: member.cooldowns }
                }
            }));
            if (encounter.won) wins += 1;
            else losses += 1;
            if (!encounter.won || combatMembers.some((member) => Number(member.vitals?.hp || 0) <= 0)) break;
        }

        const rewards = distributeRewards({ members, spot, wins, pressure, rng });
        const memberResults = [];
        const events = [];
        let deaths = 0;
        let resting = 0;

        rewards.forEach(({ state, exp, sp, adena, items }, index) => {
            const resolved = combatMembers[index] || state;
            const vitals = resolved.vitals || memberVitals(state);
            const hp = Math.max(0, Number(vitals.hp || 0));
            const mp = Math.max(0, Number(vitals.mp || 0));
            let activity = 'grouped';
            let deathCount = state.stats?.deaths || 0;

            if (hp <= 0) {
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
                        },
                        stats: {
                            ...(resolved.stats || {}),
                            partyHistory: PartyAffinity.recordRun(state, members)
                        }
                    },
                    events: [],
                    materialize: { exp, sp, adena, items },
                    nextResolveAt: timestamp + 45000 + Math.round(rng() * 90000),
                    debug: {
                        partyId: party.partyId,
                        fights,
                        wins,
                        losses,
                        dropsRolled: items.length,
                        dropsAwarded: items.reduce((sum, item) => sum + Number(item.amount || 0), 0),
                        spotId: spot.id,
                        route: spot.route || null,
                        aggregate: true
                    }
                }
            });
        });

        const lootDistribution = PartyLootAllocator.transferGearDrops(memberResults);
        let distributedMemberResults = lootDistribution.memberResults;
        let partyRestUntil = null;

        // The combat result can make one party member exhausted.  Convert the
        // whole group to one recovery event immediately, rather than letting
        // its next ordinary hunt tick discover the rest state 45-135 seconds
        // later and then poll all members every 30 seconds.
        if (resting > 0) {
            const restResults = distributedMemberResults.map(({ state, result }) => ({
                state,
                result: result.patch.activity === 'dead'
                    ? result
                    : (() => {
                        const rest = BackgroundResolver.resolveRest({
                            ...state,
                            activity: 'resting',
                            vitals: result.patch.vitals,
                            stats: { ...(state.stats || {}), ...(result.patch.stats || {}) }
                        }, 0, timestamp);
                        // The fights have already completed before the party
                        // decides to rest. Keep their rewards (and any gear
                        // redistribution) while replacing only the next
                        // lifecycle state with recovery.
                        return {
                            ...result,
                            patch: {
                                ...result.patch,
                                ...rest.patch,
                                stats: { ...(result.patch.stats || {}), ...(rest.patch.stats || {}) }
                            },
                            events: [...(result.events || []), ...(rest.events || [])],
                            nextResolveAt: rest.nextResolveAt,
                            debug: { ...(result.debug || {}), rest: rest.debug }
                        };
                    })()
            }));
            partyRestUntil = Math.max(...restResults
                .filter(({ result }) => result.patch.activity !== 'dead')
                .map(({ result }) => Number(result.patch.stats?.restUntil || 0)));
            distributedMemberResults = restResults.map(({ state, result }) => ({
                state,
                result: result.patch.activity === 'dead'
                    ? { ...result, nextResolveAt: partyRestUntil }
                    : {
                        ...result,
                        patch: {
                            ...result.patch,
                            activity: 'resting',
                            stats: { ...(result.patch.stats || {}), restUntil: partyRestUntil }
                        },
                        nextResolveAt: partyRestUntil
                    }
            }));
        }

        if (wins > 0) {
            events.push({
                characterId: party.leaderId,
                type: 'party_hunt',
                summary: `Party ${party.partyId} won ${wins} fights near ${spot.name}`,
                weight: wins >= 6 ? 3 : 2,
                meta: { partyId: party.partyId, spotId: spot.id, fights, wins, losses }
            });
        }
        lootDistribution.transfers.forEach((transfer) => {
            events.push({
                characterId: transfer.to.characterId,
                type: 'party_gear_share',
                summary: `${transfer.from.name || 'A party member'} gave ${transfer.item.name || `Item ${transfer.item.selfId}`} to ${transfer.to.name || 'a party member'} who needed it`,
                weight: 2,
                meta: {
                    partyId: party.partyId,
                    fromCharacterId: transfer.from.characterId,
                    itemId: transfer.item.selfId
                }
            });
        });
        const cohesionDelta = wins >= losses ? 0.015 : -0.035;
        const riskDelta = deaths > 0 ? 0.05 : losses > wins ? 0.02 : -0.01;

        return {
            memberResults: distributedMemberResults,
            events,
            partyPatch: {
                cohesion: clamp(Number(party.cohesion || 0.65) + cohesionDelta, 0.1, 1),
                risk: clamp(Number(party.risk || 0.25) + riskDelta, 0.05, 0.95),
                stats: {
                    fightsResolved: Number(party.stats?.fightsResolved || 0) + fights,
                    fightsWon: Number(party.stats?.fightsWon || 0) + wins,
                    deaths: Number(party.stats?.deaths || 0) + deaths,
                    rests: Number(party.stats?.rests || 0) + resting,
                    restUntil: partyRestUntil,
                    lastResolveAt: timestamp
                }
            },
            nextResolveAt: partyRestUntil || timestamp + 45000 + Math.round(rng() * 90000),
            debug: {
                fights,
                wins,
                losses,
                deaths,
                resting,
                dropsRolled: rewards.reduce((sum, reward) => sum + reward.items.length, 0),
                dropsAwarded: rewards.reduce((sum, reward) => sum + reward.items.reduce((itemSum, item) => itemSum + Number(item.amount || 0), 0), 0),
                spotId: spot.id,
                route: spot.route || null,
                combatActions,
                skillUses,
                heals
            }
        };
    }
};

module.exports = BackgroundPartyResolver;
