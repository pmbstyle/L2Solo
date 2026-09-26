const PveEncounter = require('./ColdPveEncounter');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const PartyAffinity = invoke('GameServer/Bot/Population/BackgroundPartyAffinity');
const PartyLootAllocator = invoke('GameServer/Bot/Population/PartyLootAllocator');
const PartyRewardMath = invoke('GameServer/Actor/PartyRewardMath');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const ClanRaidPolicy = invoke('GameServer/Clan/ClanRaidPolicy');
const ColdRaidEncounter = require('./ColdRaidEncounter');

const MAX_DROPS_PER_RESOLVE = 4;
const RAID_RESOLVE_INTERVAL_MS = 15000;

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
        hp: Number(vitals.hp ?? maxHp),
        maxHp,
        mp: Number(vitals.mp ?? maxMp),
        maxMp
    };
}

function estimateFightCount({ party, members, spot, elapsedMs }) {
    const baseWindows = Math.max(1, Math.floor(elapsedMs / 12000));
    const densityFactor = clamp(Number(spot.density || 1) / 3, 0.7, 2.2);
    const cohesionFactor = clamp(Number(party.cohesion || 0.65), 0.35, 1.15);

    // Party actions are individually simulated, so party size must not
    // multiply work.  Keep the same short active window as solo combat.
    return Math.max(1, Math.min(4, Math.round(baseWindows * densityFactor * cohesionFactor)));
}

function distributeRewards({ members, spot, wins, defeatedNpcIds = [], overhitContexts = [], pressure, rng, timestamp }) {
    const expMultiplier = Number(pressure?.expMultiplier || 1);
    const rates = ProgressionRates.profile();
    const memberProgression = members.map((state) => ({
        exp: 0,
        sp: 0,
        profile: ColdCombatProfile.profileFor(state, timestamp)
    }));
    Array.from({ length: wins }).forEach((_, winIndex) => {
        const progression = BackgroundDropResolver.progressionForFight({
            spot, npcSelfId: defeatedNpcIds[winIndex], rng
        });
        const adjustedExp = invoke('GameServer/Progression/OverhitReward')
            .resolveContext(overhitContexts[winIndex], progression.exp).adjustedExp;
        PartyRewardMath.sharesForLevels(
            members.map((state) => Number(state.level || 1)),
            adjustedExp,
            progression.sp
        ).forEach((share) => {
            memberProgression[share.index].exp += Math.round(share.exp * expMultiplier * rates.exp
                * ColdCombatProfile.statMultiplier(memberProgression[share.index].profile, 'expMul', timestamp));
            memberProgression[share.index].sp += Math.round(share.sp * expMultiplier * rates.sp);
        });
    });
    const partyKillerLevel = Math.max(...members.map((state) => Number(state.level || 1)));
    const rewardRolls = Array.from({ length: wins }).map((_, index) => (
        BackgroundDropResolver.rollRewardsForFight({
            spot,
            killerLevel: partyKillerLevel,
            npcSelfId: defeatedNpcIds[index],
            rng
        })
    ));
    const totalAdena = rewardRolls.reduce((sum, rolled) => (
        sum + (rolled === null
            ? Math.round(randInt(rng, spot.rewards.adenaMin, spot.rewards.adenaMax) * rates.adena)
            : rolled.adena)
    ), 0);
    const adenaPerMember = Math.floor(totalAdena / members.length);
    const adenaRemainder = totalAdena - (adenaPerMember * members.length);
    const loot = members.map(() => []);
    const spoilerIndex = members.findIndex((state) => BotRoles.isSpoiler(state));
    for (let win = 0; win < Math.min(wins, MAX_DROPS_PER_RESOLVE); win++) {
        const drops = rewardRolls[win]?.items || [];
        if (drops.length) {
            loot[Math.min(members.length - 1, Math.floor(rng() * members.length))].push(...drops);
        }
        if (spoilerIndex >= 0) {
            loot[spoilerIndex].push(...BackgroundDropResolver.rollSpoilForFight({
                spot,
                killerLevel: partyKillerLevel,
                npcSelfId: defeatedNpcIds[win],
                rng
            }));
        }
    }

    return members.map((state, index) => ({
        state,
        exp: memberProgression[index].exp,
        sp: memberProgression[index].sp,
        adena: adenaPerMember + (index < adenaRemainder ? 1 : 0),
        items: loot[index]
    }));
}

const BackgroundPartyResolver = {
    resolve({ party, members, spot, pressure = {}, targetNpcId = 0, elapsedMs = 60000, rng = Math.random, timestamp = Date.now(),
        episodeId = null, assessRelationship = null }) {
        if (!party || !members?.length || !spot) {
            return {
                memberResults: [],
                events: [],
                partyPatch: {},
                nextResolveAt: timestamp + 60000,
                debug: { reason: 'missing_party_members_or_spot' }
            };
        }
        const raidObjective = spot.raidBoss === true
            && party.stats?.objective?.sourceKind === 'raid'
            && Number(party.stats.objective.raidBossTemplateId || party.stats.objective.npcId)
                === Number(spot.raidBossTemplateId);
        const raidCombatActive = raidObjective
            && party.stats?.raidEncounter?.status === 'active'
            && !!party.stats.raidEncounter.encounter;

        let raidSnapshot = raidObjective
            ? ColdRaidEncounter.begin(party, spot, targetNpcId, timestamp) : null;
        // A hot victory has already issued its rewards. Complete it before
        // availability, resurrection, assembly, or preparation can reopen it.
        const completed = party.stats?.raidEncounter?.status === 'defeated'
            ? party.stats.raidEncounter : raidSnapshot;
        if (raidObjective && completed?.status === 'defeated') {
            return {
                memberResults: members.map(state => ({ state, result: {
                    patch: {}, events: [], memoryEvents: [],
                    materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + 30000
                } })), events: [], nextResolveAt: null,
                partyPatch: { status: 'dissolved', nextResolveAt: null, stats: {
                    raidEncounter: completed, pveEncounter: null, restUntil: null,
                    partyBreakReason: 'raid_defeated', dissolvedAt: timestamp, lastResolveAt: timestamp
                } },
                debug: { reason: 'raid_already_defeated', fights: 0, wins: 0,
                    raidBossTemplateId: completed.bossTemplateId }
            };
        }

        if (raidObjective && spot.raidWorldAvailable === false) {
            return { memberResults: members.map(state => ({ state, result: { patch: {}, events: [],
                materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + 1000 } })),
                events: [], nextResolveAt: null, partyPatch: { status: 'dissolved',
                    stats: { ...party.stats, partyBreakReason: 'raid_unavailable', dissolvedAt: timestamp } },
                debug: { reason: 'raid_unavailable', fights: 0, wins: 0 } };
        }
        const revival = !raidCombatActive && require('./ColdPartyRevival').resolve({ party, members, timestamp, episodeId, assessRelationship });
        if (revival) return revival;
        // A cold PvP casualty holds the roster through the ordinary recovery
        // delay. Neither standing regeneration nor the next PvE fight revives it.
        if (!raidCombatActive && members.some(s => s.vitals.hp <= 0)) {
            const memberResults = members.map(state => ({ state, result: state.vitals.hp <= 0
                ? BackgroundResolver.resolveDeathRecovery(state, timestamp)
                : { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + 1000 } }));
            const nextResolveAt = Math.max(...memberResults.map(r => r.result.nextResolveAt));
            for (const { state, result } of memberResults) {
                if ((result.patch.vitals?.hp ?? state.vitals.hp) > 0) {
                    result.patch = { ...result.patch, activity: 'resting',
                        stats: { ...(result.patch.stats || state.stats), restUntil: nextResolveAt } };
                }
                result.nextResolveAt = nextResolveAt;
            }
            return { memberResults, events: [], nextResolveAt,
                partyPatch: { stats: { ...party.stats, restUntil: nextResolveAt, lastResolveAt: timestamp } },
                debug: { reason: 'party_pvp_recovery', fights: 0, wins: 0 } };
        }
        // A party shares its hunting cadence.  If even one member is resting,
        // pause the whole group: otherwise the resolver keeps granting fights
        // and draining the exhausted member on every cold tick.
        if (members.some((state) => state.activity === 'resting') && !raidCombatActive) {
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
                }, elapsedMs, timestamp, { party: true })
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
                        // A ready member is still waiting for the group. Do
                        // not claim it returned to hunting until the shared
                        // party recovery actually completes.
                        events: (result.events || []).filter((event) => event.type !== 'recovered'),
                        nextResolveAt: nextRestUntil
                    }
                }))
                : memberResults.map(({ state, result }) => ({
                    state,
                    result: {
                        ...result,
                        patch: { ...result.patch, activity: 'grouped' },
                        nextResolveAt: timestamp + (raidObjective ? RAID_RESOLVE_INTERVAL_MS : 45000)
                    }
                }));

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
                nextResolveAt: resting ? nextRestUntil : timestamp + (raidObjective ? RAID_RESOLVE_INTERVAL_MS : 45000),
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

        const raid = raidObjective;
        const raidComposition = raid ? ClanRaidPolicy.composition(members) : null;
        const understaffed = party.stats?.objective?.clanGoalKey
            && members.length < Math.max(2, Number(party.stats.objective.minPartySize) || 3);
        const raidRosterIncomplete = raid && !raidComposition.ready;
        const assemblyMembers = raidCombatActive
            ? members.map((member) => ({ ...member, activity: 'grouped' }))
            : members;
        if (understaffed || raidRosterIncomplete || !require('./PartyHuntingAssembly').ready(party, assemblyMembers, spot)) {
            // No route may mean admission is temporarily unavailable. Do not
            // turn that into remote combat or rewrite a member's physical spot.
            const nextResolveAt = timestamp + 30000;
            return {
                memberResults: members.map(state => ({ state, result: {
                    patch: {}, events: [], memoryEvents: [],
                    materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt
                } })),
                events: [], nextResolveAt,
                partyPatch: { stats: { lastResolveAt: timestamp,
                    assemblyWait: require('./PartyAssemblyRecovery').record(party, timestamp) } },
                debug: {
                    reason: understaffed ? 'clan_party_understaffed'
                        : raidRosterIncomplete ? raidComposition.reason : 'party_assembling',
                    fights: 0,
                    wins: 0,
                    spotId: spot.id
                }
            };
        }

        if (raid && !raidCombatActive) {
            const preparation = BackgroundResolver.prepareRaidParty(members, timestamp);
            const previous = party.stats?.raidPreparation || {};
            const firstPreparation = previous.status !== 'ready';
            // Preparation is a real phase, not free work hidden inside the
            // opening combat slice. Any cast, recovery need, or first ready
            // assessment commits before the boss can act.
            if (preparation.casts > 0 || preparation.needsRest || firstPreparation) {
                const status = preparation.ready ? 'ready' : 'preparing';
                return {
                    memberResults: preparation.memberResults,
                    events: [],
                    partyPatch: { stats: {
                        raidPreparation: {
                            status,
                            startedAt: Number(previous.startedAt || timestamp),
                            updatedAt: timestamp,
                            readyAt: preparation.ready ? timestamp : null,
                            passes: Number(previous.passes || 0) + 1,
                            buffCasts: Number(previous.buffCasts || 0) + preparation.buffCasts,
                            musicCasts: Number(previous.musicCasts || 0) + preparation.musicCasts,
                            summonCasts: Number(previous.summonCasts || 0) + preparation.summonCasts,
                            chargeCasts: Number(previous.chargeCasts || 0) + preparation.chargeCasts,
                            remainingBuffs: preparation.remainingBuffs,
                            remainingMusic: preparation.remainingMusic
                        },
                        raidEncounter: raidSnapshot,
                        assemblyWait: null,
                        restUntil: preparation.restUntil,
                        lastResolveAt: timestamp
                    } },
                    nextResolveAt: preparation.nextResolveAt,
                    debug: {
                        reason: preparation.ready ? 'raid_prepared' : 'raid_preparing',
                        fights: 0,
                        wins: 0,
                        raidBossTemplateId: raidSnapshot.bossTemplateId,
                        buffCasts: preparation.buffCasts,
                        musicUses: preparation.musicCasts,
                        summonUses: preparation.summonCasts,
                        chargeCasts: preparation.chargeCasts
                    }
                };
            }
        }

        const alreadyFailed = raid && members.filter(member => member.vitals.hp <= 0).some((member, index) =>
            require('./RaidCasualtyPolicy').disposition(member, { previousDamageCasualties: index,
                remainingHpRatio: Number(raidSnapshot?.hp) / Math.max(1, Number(raidSnapshot?.maxHp || 1)) }) !== 'continue');
        const fightBudget = raid ? Number(!alreadyFailed) : estimateFightCount({ party, members, spot, elapsedMs });
        let fights = 0;
        let attemptedFights = 0;
        let pending = raid
            ? raidSnapshot?.encounter || null
            : PveEncounter.read(party.stats?.pveEncounter, PveEncounter.key(members, spot, targetNpcId, party.partyId), timestamp);
        let wins = 0;
        const overhitContexts = [];
        let losses = 0;
        let combatActions = 0;
        let skillUses = 0;
        let heals = 0;
        let musicUses = 0;
        let summonUses = 0;
        let summonActions = 0;
        let potionsUsed = 0;
        const defeatedNpcIds = [];
        let avoidedReason = null;
        const combatHelp = new Map();
        let combatMembers = members.map((state) => ({
            ...state,
            vitals: pending ? { ...state.vitals } : BackgroundResolver.applyStandingRegen(state, state.vitals, elapsedMs, timestamp)
        }));
        for (let i = 0; i < fightBudget; i++) {
            const encounter = BackgroundResolver.resolvePartyFight({
                members: combatMembers,
                spot,
                targetNpcId,
                rng,
                timestamp,
                encounter: pending,
                partyId: party.partyId,
                encounterKey: raidSnapshot?.key || null,
                sharedEncounter: raid
            });
            if (encounter.avoided) {
                avoidedReason = encounter.reason;
                break;
            }
            attemptedFights += 1;
            pending = encounter.encounter || null;
            if (raid) raidSnapshot = ColdRaidEncounter.record(party, raidSnapshot, encounter, timestamp);
            if (encounter.won || !pending) fights += 1;
            for (const help of encounter.help || []) combatHelp.set(`${help.sourceId}:${help.targetId}:${help.type}`, help);
            combatActions += Number(encounter.debug?.actions || 0);
            skillUses += encounter.members.reduce((sum, member) => sum + Number(member.skillUses || 0), 0);
            heals += encounter.members.reduce((sum, member) => sum + Number(member.heals || 0), 0);
            musicUses += encounter.members.reduce((sum, member) => sum + Number(member.musicUses || 0), 0);
            summonUses += Number(encounter.debug?.summonUses || 0);
            summonActions += Number(encounter.debug?.summonActions || 0);
            potionsUsed += Number(encounter.debug?.potionsUsed || 0);
            combatMembers = encounter.members.map((member) => ({
                ...member.state,
                vitals: { ...member.vitals },
                stats: {
                    ...(member.state.stats || {}),
                    coldCombat: {
                        ...(member.state.stats?.coldCombat || member.profile),
                        effects: member.profile.effects || member.state.stats?.coldCombat?.effects || [],
                        cooldowns: member.cooldowns,
                        charges: member.charges || 0,
                        chargeExpiresAt: member.chargeExpiresAt || null
                    }
                }
            }));
            if (encounter.won) {
                wins += 1;
                if (Number(encounter.debug?.mobSelfId) > 0) defeatedNpcIds.push(Number(encounter.debug.mobSelfId));
                overhitContexts.push(encounter.debug?.overhitContext || null);
            }
            else if (!pending) losses += 1;
            if (!encounter.won || combatMembers.some((member) => Number(member.vitals?.hp || 0) <= 0)) break;
        }

        const rewards = distributeRewards({ members, spot, wins, defeatedNpcIds, overhitContexts, pressure, rng, timestamp });
        const memberResults = [];
        const events = [];
        let deaths = 0;
        let resting = 0;

        // Large parties can have more than 64 directed pairs. Unrecorded pairs
        // remain eligible next resolve; committed pairs are skipped by cooldown.
        const helpEvents = invoke('GameServer/Social/ColdCombatHelpMemory').eventsFor([...combatHelp.values()],
            episodeId, timestamp, assessRelationship, id => members.find(m => Number(m.characterId) === id));
        const huntEvents = wins > 0 && losses === 0 && combatMembers.every(member => Number(member.vitals?.hp) > 0)
            ? invoke('GameServer/Social/SharedHuntMemory').eventsForGroup(members.map(member => Number(member.characterId)),
                episodeId, timestamp, assessRelationship, id => members.find(m => Number(m.characterId) === id)) : [];
        const memoryEvents = [...helpEvents, ...huntEvents].slice(0, 64);

        rewards.forEach(({ state, exp, sp, adena, items }, index) => {
            const resolved = combatMembers[index] || state;
            const vitals = resolved.vitals || memberVitals(state);
            const hp = Math.max(0, Number(vitals.hp || 0));
            const mp = Math.max(0, Number(vitals.mp || 0));
            let activity = 'grouped';
            let deathCount = state.stats?.deaths || 0;

            if (hp <= 0) {
                activity = 'dead';
                const newlyDead = Number(state.vitals?.hp) > 0;
                deathCount += Number(newlyDead);
                deaths += Number(newlyDead);
                if (newlyDead) events.push({
                    characterId: state.characterId,
                    type: 'death',
                    summary: `${state.name || 'Bot'} died while grouped near ${spot.name}`,
                    weight: 4,
                    meta: { partyId: party.partyId, spotId: spot.id, fights, wins }
                });
            } else {
                if (!raid && BackgroundResolver.needsRest(state, vitals, {
                    party: true,
                    hpThreshold: 0.3,
                    mpThreshold: 0.18
                })) {
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
                            ...(raid ? { restUntil: null } : {}),
                            ...(avoidedReason ? { lastReason: avoidedReason } : {}),
                            coldCombat: hp <= 0 ? {
                                ...(resolved.stats?.coldCombat || {}),
                                charges: 0,
                                chargeExpiresAt: null,
                                summon: null
                            } : resolved.stats?.coldCombat,
                            partyHistory: PartyAffinity.recordRun(state, members)
                        }
                    },
                    events: [],
                    memoryEvents: memoryEvents.filter(event => event.sourceId === Number(state.characterId)),
                    materialize: { exp, sp, adena, items },
                    // One cold raid slice represents fifteen seconds of real
                    // combat. Keep an active boss on that cadence so a remote
                    // raid does not spend most of its lifetime sleeping
                    // between otherwise continuous combat rounds.
                    nextResolveAt: timestamp + (raid ? RAID_RESOLVE_INTERVAL_MS : 45000 + Math.round(rng() * 90000)),
                    debug: {
                        partyId: party.partyId,
                        fights,
                        wins,
                        losses,
                        dropsRolled: items.length,
                        dropsAwarded: items.reduce((sum, item) => sum + Number(item.amount || 0), 0),
                        spotId: spot.id,
                        route: spot.route || null,
                        aggregate: true,
                        targetNpcId: Number(targetNpcId) || null,
                        defeatedNpcIds: [...defeatedNpcIds],
                        // A party resolve represents one shared encounter.  Its
                        // leader may be replaced or leave while the resulting
                        // state updates are persisted, so use the stable local
                        // result order to nominate exactly one aggregate owner.
                        populationTelemetryOwner: index === 0,
                        // The worker delivers member results, not the outer
                        // aggregate. Carry combat totals on this owner only.
                        ...(index === 0 ? { combatActions, skillUses, heals } : {})
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
                        }, 0, timestamp, { party: true });
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
        const casualties = combatMembers.filter(member => Number(member.vitals?.hp) <= 0);
        const remainingHpRatio = Number(raidSnapshot?.hp || 0) / Math.max(1, Number(raidSnapshot?.maxHp || 1));
        const raidFailed = raid && raidSnapshot?.status !== 'defeated' && casualties.some((member, index) =>
            require('./RaidCasualtyPolicy').disposition(member, { previousDamageCasualties: index, remainingHpRatio }) !== 'continue');
        const raidDefeated = raid && raidSnapshot?.status === 'defeated';
        if (!raid && pending && (resting > 0 || deaths > 0 || pending.slices >= PveEncounter.MAX_SLICES)) {
            pending = null;
            fights += 1;
            losses += 1;
        } else if (raidFailed) {
            // A death ends this clan's attempt. Persist the actual remaining
            // HP for retry policy, then reset the shared boss to full health
            // before another clan or retry can begin.
            raidSnapshot = ColdRaidEncounter.fail(party, raidSnapshot, timestamp, 'party_death');
            pending = null;
            fights += 1;
            losses += 1;
            events.push({
                characterId: party.leaderId,
                type: 'raid_failed',
                summary: `Party ${party.partyId} failed its raid near ${spot.name}`,
                weight: 4,
                meta: {
                    partyId: party.partyId,
                    spotId: spot.id,
                    raidBossTemplateId: Number(spot.raidBossTemplateId),
                    remainingHpRatio: raidSnapshot?.remainingHpRatio,
                    reason: 'party_death'
                }
            });
        }
        // Member telemetry must describe actual completed encounters, including withdrawals.
        for (const entry of distributedMemberResults) {
            entry.result.debug.fights = fights;
            entry.result.debug.losses = losses;
            entry.result.debug.pendingFight = !!pending;
            if (raid) {
                entry.result.debug.raidBossTemplateId = Number(spot.raidBossTemplateId);
                entry.result.debug.raidDefeated = raidSnapshot?.status === 'defeated';
                entry.result.debug.raidFailed = raidSnapshot?.status === 'failed';
                entry.result.debug.raidRemainingHpRatio = raidSnapshot?.remainingHpRatio ?? null;
                entry.result.debug.raidWinnerPartyId = raidSnapshot?.winnerPartyId || null;
            }
        }
        const cohesionDelta = !fights ? 0 : wins >= losses ? 0.015 : -0.035;
        const riskDelta = !fights ? 0 : deaths > 0 ? 0.05 : losses > wins ? 0.02 : -0.01;

        return {
            memberResults: distributedMemberResults,
            events,
            partyPatch: {
                ...(raidFailed || raidDefeated ? { status: 'dissolved', nextResolveAt: null } : {}),
                cohesion: clamp(Number(party.cohesion || 0.65) + cohesionDelta, 0.1, 1),
                risk: clamp(Number(party.risk || 0.25) + riskDelta, 0.05, 0.95),
                stats: {
                    pveEncounter: raid ? null : pending,
                    ...(raid ? { raidEncounter: raidSnapshot } : {}),
                    assemblyWait: null,
                    fightsResolved: Number(party.stats?.fightsResolved || 0) + fights,
                    fightsWon: Number(party.stats?.fightsWon || 0) + wins,
                    lastProgressAt: wins > 0 ? timestamp : Number(party.stats?.lastProgressAt || 0),
                    deaths: Number(party.stats?.deaths || 0) + deaths,
                    rests: Number(party.stats?.rests || 0) + resting,
                    restUntil: partyRestUntil,
                    lastResolveAt: timestamp,
                    ...(raidFailed ? {
                        dissolvedAt: timestamp,
                        partyBreakReason: 'raid_failed'
                    } : raidDefeated ? {
                        dissolvedAt: timestamp,
                        partyBreakReason: 'raid_defeated'
                    } : {})
                }
            },
            nextResolveAt: raidFailed || raidDefeated
                ? null
                : partyRestUntil || timestamp + (raid ? RAID_RESOLVE_INTERVAL_MS : 45000 + Math.round(rng() * 90000)),
            debug: {
                fights,
                attemptedFights,
                pendingFight: !!pending,
                wins,
                losses,
                deaths,
                raidFailed,
                raidRemainingHpRatio: raidSnapshot?.remainingHpRatio ?? null,
                resting,
                dropsRolled: rewards.reduce((sum, reward) => sum + reward.items.length, 0),
                dropsAwarded: rewards.reduce((sum, reward) => sum + reward.items.reduce((itemSum, item) => itemSum + Number(item.amount || 0), 0), 0),
                spotId: spot.id,
                route: spot.route || null,
                combatActions,
                skillUses,
                heals,
                musicUses,
                summonUses,
                summonActions,
                potionsUsed,
                targetNpcId: Number(targetNpcId) || null,
                raidBossTemplateId: raid ? Number(spot.raidBossTemplateId) : null,
                raidDefeated: raidSnapshot?.status === 'defeated',
                raidWinnerPartyId: raidSnapshot?.winnerPartyId || null,
                defeatedNpcIds
            }
        };
    }
};

const resolveParty = BackgroundPartyResolver.resolve;
BackgroundPartyResolver.resolve = (options = {}) => {
    const timestamp = options.timestamp ?? Date.now();
    const competition = require('./ColdCompetitionWait').consumeParty(options.party, options.members || [], options.elapsedMs ?? 60000, timestamp);
    const hadWait = [options.party, ...(options.members || [])].some(state => state?.stats?.coldCompetition?.wait);
    const paused = competition.waiting || (hadWait && competition.elapsedMs === 0);
    const members = competition.members || options.members || [];
    const result = paused ? {
        memberResults: members.map(state => ({ state, result: { patch: {}, events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: competition.until || timestamp + 1000 } })),
        events: [], partyPatch: {}, nextResolveAt: competition.until || timestamp + 1000,
        debug: { reason: options.party?.stats?.coldCompetition?.action === 'yield' ? 'competition_yield' : 'competition_contest', fights: 0, wins: 0 }
    } : resolveParty({ ...options, party: competition.party, members, elapsedMs: competition.elapsedMs, timestamp });
    if (options.party?.stats?.pveEncounter && !Object.hasOwn(result.debug || {}, 'pendingFight')) {
        result.partyPatch = { ...result.partyPatch, stats: { ...(result.partyPatch?.stats || options.party.stats), pveEncounter: null } };
    }
    if (competition.waiting) return result;
    if (competition.party !== options.party) result.partyPatch = { ...result.partyPatch,
        stats: { ...(result.partyPatch?.stats || competition.party.stats), coldCompetition: competition.party.stats.coldCompetition } };
    const cleared = new Map(members.filter((state, index) => state !== options.members?.[index]).map(state => [state.characterId, state]));
    result.memberResults = (result.memberResults || []).map(entry => {
        const state = cleared.get(entry.state.characterId);
        return !state ? entry : { ...entry, result: { ...entry.result, patch: { ...entry.result.patch,
            stats: { ...(entry.result.patch?.stats || state.stats), coldCompetition: state.stats.coldCompetition } } } };
    });
    return result;
};
const resolveWithCompetition = BackgroundPartyResolver.resolve;
BackgroundPartyResolver.resolve = (options = {}) => require('./PartySpotRiskPolicy').record(
    options.party, resolveWithCompetition(options), options.timestamp ?? Date.now());
module.exports = BackgroundPartyResolver;
