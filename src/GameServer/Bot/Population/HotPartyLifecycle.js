const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Placement = invoke('GameServer/Bot/Population/ActivationPlacement');
const World = invoke('GameServer/World/World');
const RaidEntityIndex = invoke('GameServer/World/RaidEntityIndex');
const Database = invoke('Database');
const pending = new Set();
const raidFailures = new Set();
const RAID_FAILURE_RETREAT_MS = 15000;
const id = session => Number(session?.actor?.fetchId?.());

function raidObjective(party) {
    return Parties.raidBossKey(party) ? party.stats.objective : null;
}

function raidBossForParty(party) {
    const bossKey = Parties.raidBossKey(party);
    return bossKey ? RaidEntityIndex.bossByTemplateId(World, bossKey) : null;
}

function syncColdRaidHp(party) {
    const snapshot = party?.stats?.raidEncounter;
    const boss = raidBossForParty(party);
    if (!boss || snapshot?.status !== 'active' || !(Number(snapshot.hp) > 0)) return false;
    if (snapshot.raidInstanceId && snapshot.raidInstanceId !== invoke('GameServer/RaidBoss/RaidEncounterScope').instanceId(boss)) return false;
    boss.setHp?.(Math.min(Number(boss.fetchHp?.() || snapshot.hp), Number(snapshot.hp)));
    return true;
}

function captureHotRaidHp(party, timestamp = Date.now()) {
    const bossTemplateId = Parties.raidBossKey(party);
    if (!bossTemplateId) return party;
    const Roster = require('../../Clan/ClanRaidRoster');
    if (Roster.markerFor(party) && !Roster.held(party)) {
        if (!Roster.nativeHotStarted(party)) return party;
        party = { ...party, stats: { ...party.stats, raidAdmission: { ...party.stats.raidAdmission, startedAt: timestamp } } };
    }
    const previous = party.stats?.raidEncounter || {};
    if (['failed', 'defeated'].includes(previous.status)) return party;
    const boss = raidBossForParty(party);
    const hp = Math.max(0, Number(boss?.fetchHp?.() || 0));
    const maxHp = Math.max(1, Number(boss?.fetchMaxHp?.() || previous.maxHp
        || party.stats?.hotRaidBoss?.maxHp || previous.encounter?.mob?.maxHp || hp || 1));
    const defeated = !boss || boss.isDead?.() || boss.state?.fetchDead?.() || hp <= 0;
    const key = previous.key || `raid:${bossTemplateId}`;
    const encounter = defeated ? null : {
        ...(previous.encounter || {}),
        version: 1,
        key,
        hp,
        at: timestamp,
        slices: Number(previous.encounter?.slices || 0)
    };
    return { ...party, stats: { ...(party.stats || {}), raidEncounter: {
        ...previous,
        version: 1,
        key,
        bossTemplateId,
        raidInstanceId: invoke('GameServer/RaidBoss/RaidEncounterScope').instanceId(boss)
            || previous.raidInstanceId || party.stats?.hotRaidBoss?.instanceId || null,
        status: defeated ? 'defeated' : 'active',
        hp,
        maxHp,
        encounter,
        revision: Number(previous.revision || 0) + 1,
        updatedAt: timestamp,
        winnerPartyId: defeated ? party.partyId : previous.winnerPartyId || null,
        defeatedAt: defeated ? timestamp : previous.defeatedAt || null
    } } };
}

function raidFailureReady(party, timestamp = Date.now()) {
    const encounter = party?.stats?.raidEncounter;
    return party?.status === 'hot' && encounter?.status === 'failed'
        && Number(encounter.failedAt || 0) > 0
        && Number(timestamp) - Number(encounter.failedAt) >= RAID_FAILURE_RETREAT_MS;
}

function stopRaidSessions(sessions, timestamp) {
    const AI = invoke('GameServer/Bot/BotAI');
    for (const member of sessions) {
        member.raidFailurePendingAt = timestamp;
        member.backgroundHuntTarget = null;
        member.currentTargetId = undefined;
        AI.stop(member);
        invoke('GameServer/Bot/AI/BotPvpTactics').stop(member, member.actor);
        member.actor?.attack?.abortCast?.(member, member.actor);
        member.actor?.attack?.clearTimers?.();
        member.actor?.automation?.abortAll?.(member.actor);
        member.actor?.unselect?.();
    }
}

function pauseRaidWorld(party, sourceSession) {
    const boss = raidBossForParty(party);
    if (!boss) return null;
    if (invoke('GameServer/RaidBoss/RaidEncounterScope').otherParticipants(World, boss, party.memberIds)) return boss;
    for (const entity of RaidEntityIndex.entitiesForRaid(World, {
        bossId: Number(boss.fetchId?.() || 0),
        bossTemplateId: Number(boss.fetchSelfId?.() || 0)
    })) {
        entity.abortCombatState?.(sourceSession);
    }
    return boss;
}

function resetRaidWorld(party, boss, maxHp, sourceSession) {
    if (!boss) return;
    if (invoke('GameServer/RaidBoss/RaidEncounterScope').otherParticipants(World, boss, party.memberIds)) return;
    const minions = invoke('GameServer/World/RaidBossMinionManager');
    minions.onBossDeath(World, boss, sourceSession);
    boss.abortCombatState?.(sourceSession);
    boss.setHp?.(maxHp);
    boss.statusUpdateVitals?.(boss);
    minions.attachBoss(World, boss);
}

function retreatRaidSessions(sessions, boss, timestamp) {
    const RaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
    for (const member of sessions) {
        member.raidFailurePendingAt = undefined;
        member.hotRaidFailureAt = timestamp;
        if (!member.actor || member.actor.isDead?.() || member.actor.state?.fetchDead?.()) continue;
        RaidSafety.retreat(member, member.actor, boss, { distance: 2200 });
    }
}

function resumeRaidSessions(sessions) {
    const AI = invoke('GameServer/Bot/BotAI');
    for (const member of sessions) {
        if (member.actor) AI.init(member);
    }
}

function criticalRaidCasualty(value) {
    return require('./RaidCasualtyPolicy').critical(value);
}

function raidDeathDisposition(value, options = {}) {
    return require('./RaidCasualtyPolicy').disposition(value, options);
}

async function failRaidOnDeath(session, timestamp = Date.now(), options = {}) {
    const partyId = session?.hotBackgroundPartyId;
    if (!partyId || raidFailures.has(partyId)) return { ok: false, reason: 'not_hot_raid_or_pending' };
    const current = Parties.find(partyId);
    if (current?.status !== 'hot' || !raidObjective(current)
        || ['defeated', 'failed'].includes(current.stats?.raidEncounter?.status)) {
        return { ok: false, reason: 'not_hot_raid_or_pending' };
    }
    const Roles = invoke('GameServer/Bot/AI/BotRoles');
    const role = Roles.inferRole(session.actor || session.coldLifeState);
    const sessions = invoke('GameServer/Bot/AI/HotBackgroundParty').roster(session);
    const bossAtDeath = raidBossForParty(current);
    const hpAtDeath = Math.max(0, Number(bossAtDeath?.fetchHp?.()
        ?? current.stats?.raidEncounter?.hp ?? 0));
    const maxHpAtDeath = Math.max(1, Number(bossAtDeath?.fetchMaxHp?.()
        ?? current.stats?.raidEncounter?.maxHp ?? 1));
    const remainingHpRatio = Math.max(0, Math.min(1, hpAtDeath / maxHpAtDeath));
    const previousDamageCasualties = sessions.filter((member) => (
        member !== session && member.hotRaidCasualtyAt
    )).length;
    const disposition = options.reason ? 'abort' : raidDeathDisposition(session.actor || session.coldLifeState, {
        previousDamageCasualties,
        remainingHpRatio
    });
    if (disposition === 'continue') {
        session.hotRaidCasualtyAt = timestamp;
        session.hotRaidCasualtyRole = Roles.isPartyMusicFighter(session.actor || session.coldLifeState)
            ? 'damage' : role;
        session.backgroundHuntTarget = null;
        session.currentTargetId = undefined;
        return { ok: true, continued: true, reason: 'raid_continues_after_damage_death',
            role: session.hotRaidCasualtyRole, remainingHpRatio };
    }
    raidFailures.add(partyId);
    let resumed = false;
    try {
        stopRaidSessions(sessions, timestamp);
        let saved = null;
        let boss = null;
        let maxHp = 1;
        let lastReason = 'raid_failure_persist_failed';
        for (let attempt = 0; attempt < 3 && !saved; attempt++) {
            await Life.settleWrites(current.memberIds);
            const latest = Parties.find(partyId);
            const states = members(latest);
            if (latest?.status !== 'hot' || !states) {
                lastReason = 'raid_party_changed';
                break;
            }
            const captured = captureHotRaidHp(latest, timestamp);
            const snapshot = captured.stats?.raidEncounter || {};
            maxHp = Math.max(1, Number(snapshot.maxHp || snapshot.encounter?.mob?.maxHp || snapshot.hp || 1));
            boss = pauseRaidWorld(captured, session) || boss;
            const failed = {
                ...captured,
                stats: { ...(captured.stats || {}), raidEncounter: {
                    ...snapshot,
                    status: 'failed',
                    remainingHpRatio: Math.max(0, Math.min(1, Number(snapshot.hp || 0) / maxHp)),
                    failureReason: options.reason || (disposition === 'fail_attrition'
                        ? 'damage_attrition' : 'critical_role_death'),
                    failedAt: timestamp,
                    failedPartyId: partyId,
                    updatedAt: timestamp,
                    revision: Number(snapshot.revision || 0) + 1
                } }
            };
            try {
                ({ party: saved } = await transition(failed, states, states, 'hot', 'raid_failed'));
            } catch (error) {
                lastReason = error?.message || lastReason;
            }
        }
        if (!saved) throw Error(lastReason);

        // The durable failed state is authoritative before the live boss is
        // restored. A crash can therefore never leave a healed boss attached
        // to a party that still believes its raid is active.
        resetRaidWorld(saved, boss, maxHp, session);
        retreatRaidSessions(sessions, boss, timestamp);
        resumeRaidSessions(sessions);
        resumed = true;
        return { ok: true, party: saved };
    } finally {
        if (!resumed) {
            sessions.forEach((member) => { member.raidFailurePendingAt = undefined; });
            resumeRaidSessions(sessions);
        }
        raidFailures.delete(partyId);
    }
}

function readinessReason(party, states, timestamp = Date.now()) {
    if (party?.status !== 'active') return 'party_not_active';
    if (!states) return 'invalid_membership';
    const Roster = require('../../Clan/ClanRaidRoster');
    if (Roster.markerFor(party) && !Roster.held(party)
        && !Roster.exact(states.map(state => state.characterId), Roster.markerFor(party).memberIds)) return 'raid_roster_incomplete';
    if (party.stats?.travel) return 'party_traveling';
    const objective = party.stats?.objective;
    if (require('./OpportunisticRaidPolicy').isObjective(objective)) {
        const refused = require('./OpportunisticRaidPolicy').pullAdmission(states, objective);
        if (refused) return refused;
    }
    const unsafeRaidMember = states.find((state) => (
        !require('./ClanEquipmentPartyPolicy').raidLevelAllowed(state, objective)
    ));
    if (unsafeRaidMember) return `member_${unsafeRaidMember.characterId}_raid_level`;
    const continuingRaid = raidObjective(party) && party.stats?.raidEncounter?.status === 'active'
        && !!party.stats.raidEncounter.encounter;
    const casualties = states.filter(s => !(s.vitals.hp > 0));
    const canContinue = continuingRaid && casualties.every(s => require('./RaidCasualtyPolicy').disposition(s, {
        previousDamageCasualties: Math.max(0, casualties.length - 1),
        remainingHpRatio: Number(party.stats.raidEncounter.hp) / Math.max(1, Number(party.stats.raidEncounter.maxHp))
    }) === 'continue');
    const toleratedCorpse = s => canContinue && !(s.vitals.hp > 0);
    const member = states.find(s => s.phase !== 'cold'
        || !s.accountName
        || (!['grouped', 'hunting', 'resting'].includes(s.activity) && !toleratedCorpse(s))
        || (s.stats?.coldCompetition?.wait?.combat && s.stats.coldCompetition.wait.until > timestamp)
        || s.stats?.travel
        || s.stats?.supplyErrand
        || s.stats?.warehouseWorkflow
        || (!(s.vitals.hp > 0) && !toleratedCorpse(s)));
    if (!member) return null;
    if (member.phase !== 'cold') return `member_${member.characterId}_not_cold`;
    if (!member.accountName) return `member_${member.characterId}_missing_account`;
    if (!['grouped', 'hunting', 'resting'].includes(member.activity)) {
        return `member_${member.characterId}_activity_${member.activity || 'missing'}`;
    }
    if (member.stats?.coldCompetition?.wait?.combat && member.stats.coldCompetition.wait.until > timestamp) {
        return `member_${member.characterId}_competition_wait`;
    }
    if (member.stats?.travel) return `member_${member.characterId}_traveling`;
    if (member.stats?.supplyErrand) return `member_${member.characterId}_supply_errand`;
    if (member.stats?.warehouseWorkflow) return `member_${member.characterId}_warehouse`;
    return `member_${member.characterId}_dead`;
}

function ready(party, states) {
    return readinessReason(party, states) === null;
}

function members(party) {
    const ids = party?.memberIds || [];
    if (ids.length < 2 || ids.length > 9 || new Set(ids).size !== ids.length || !ids.includes(party.leaderId)) return null;
    const states = ids.map(id => Life.cachedState(id));
    return states.every(s => s?.party?.partyId === party.partyId) ? states : null;
}

async function transition(party, states, next, phase, reason) {
    const at = Date.now();
    const nextResolveAt = phase === 'hot' ? null : at + 30000;
    const stats = { ...party.stats, hotLifecycle: phase === 'hot'
        ? { startedAt: party.stats?.hotLifecycle?.startedAt || at, reason }
        : null };
    // Hot time has already been played. It is never another cold reward window.
    const nextStates = next.map(s => ({ ...s, phase, activity: 'grouped',
        timing: { ...s.timing, nextResolveAt, lastResolvedAt: at }, updatedAt: at }));
    const result = await Database.transitionBackgroundParty({ partyId: party.partyId,
        expectedStatus: party.status, expectedPartyRevision: party.revision, expectedPhase: states[0].phase,
        phase, nextResolveAt, statsJson: JSON.stringify(stats),
        members: nextStates.map((s, index) => ({ characterId: s.characterId,
            expectedRevision: Number(states[index].simulation?.revision || 0),
            expectedUpdatedAt: states[index].updatedAt, patch: Owner.persistencePatch(s, at) })) });
    if (!result.ok) throw Error(result.reason);
    return { party: Parties.acceptRow(result.party), states: result.rows.map(row => Life.acceptLifecycleRow(row)) };
}

function discard(sessions) {
    const Manager = invoke('GameServer/Bot/BotManager');
    const AI = invoke('GameServer/Bot/BotAI');
    for (const session of sessions) {
        AI.stop(session);
        if (!session.populationStaging) invoke('GameServer/Bot/Population/Cooldown').removeFromClientWorld(session);
        session.populationStaging = true;
        session.actor?.destructor();
        World.removeUser(session);
        Manager.sessions = Manager.sessions.filter(s => s !== session);
        session.actor = null;
    }
}

// Release an incapable material roster in place. Its native actors, wallet,
// HP and XP remain authoritative; only the fenced party membership changes.
async function releaseUnsafeHunt(partyId) {
    if (pending.has(partyId)) return { ok: false, reason: 'party_transition_pending' };
    const Material = require('./CraftMaterialParty');
    const party = Parties.find(partyId);
    if (party?.status !== 'hot' || !Material.isObjective(party.stats?.objective)
        || party.stats?.warOperation || party.stats?.raidAdmission) return { ok: false, reason: 'not_material_hunt' };
    const sessions = party.memberIds.map(memberId => World.registeredActorById(memberId)?.session);
    const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
    const ready = () => Parties.find(partyId)?.status === 'hot'
        && Parties.find(partyId)?.revision === party.revision && sessions.every(s => s?.actor
        && s.hotBackgroundPartyId === partyId && !s.partyCompanion && s.plan === 'hunting'
        && Math.hypot(s.actor.fetchLocX() - sessions[0].actor.fetchLocX(), s.actor.fetchLocY() - sessions[0].actor.fetchLocY()) <= 700
        && !s.actor.state.fetchDead?.() && !s.actor.state.fetchHits?.() && !s.actor.state.fetchCasts?.()
        && !s.pendingSupportCast && !s.spotRelocation && !s.pvpDefense && !s.pvpEncounter
        && !s.trade && !s.activeTrade && !s.activeNegotiation && !Awareness.npcThreateningActor(s));
    if (!ready()) return { ok: false, reason: 'party_member_busy' };
    pending.add(partyId);
    sessions.forEach(s => { s.hotHuntReview = true; invoke('GameServer/Bot/AI/BotPvpTactics').stop(s, s.actor); });
    try {
        await Life.settleWrites(party.memberIds);
        if (!ready()) return { ok: false, reason: 'party_member_changed' };
        const states = members(party);
        if (!states) return { ok: false, reason: 'party_membership_changed' };
        const spot = invoke('GameServer/Bot/Population/SpotProfiles').findById(party.spotId);
        const profiles = invoke('GameServer/Bot/AI/BotTargetMatchup').actorProfiles(sessions.map(s => s.actor));
        const npcIds = [...new Set([party.stats.objective.npcId,
            ...(party.stats.agreement?.materialNeeds || []).map(need => need.npcId)].map(Number).filter(Boolean))];
        if (!spot || Material.canHunt(states, spot, profiles, npcIds)) return { ok: false, reason: 'party_hunt_capable' };
        const timestamp = Date.now(), reason = 'party_material_route_unavailable';
        const Rule = require('./BackgroundPartyLifecycle');
        const releases = sessions.map(s => {
            const state = states.find(row => row.characterId === id(s));
            const live = Life.partySessionSnapshot(s, state, 'hot', reason);
            const next = Rule.releaseMember(live, timestamp, reason, Material.departureRequest(party, live));
            next.spotId = s.currentSpot?.id || next.spotId;
            return Life.preparePartyReview(state, next);
        });
        const dissolved = Parties.prepareCommit({ ...party, status: 'dissolved', memberIds: [], nextResolveAt: null,
            stats: { ...party.stats, hotLifecycle: null, partyBreakReason: reason, dissolvedAt: timestamp } });
        if (!dissolved || releases.some(row => !row)) return { ok: false, reason: 'invalid_party_review' };
        const result = await Database.commitBackgroundPartyMembership({ party: dissolved.row, members: releases,
            review: true, expectedPhase: 'hot', expectedPartyRevision: party.revision, canCommitHot: ready,
            event: { characterId: party.leaderId, eventType: 'party', createdAt: timestamp,
                summary: 'Material party released an unsafe hunting contract', meta: { partyId, reason } } });
        if (!result.ok) return result;
        Parties.acceptRow(result.partyRow);
        const saved = Life.acceptPartyAssignments(releases, result.lifeRows);
        for (const s of sessions) {
            s.coldLifeState = saved.find(state => state.characterId === id(s));
            s.hotBackgroundPartyId = null;
            s.backgroundHuntTarget = null;
            s.backgroundSearchDestination = null;
            s.currentTargetId = undefined;
            s.actor.unselect?.();
            s.lastDecision = { action: 'leave_unsafe_party', reason, at: timestamp };
            require('../AI/DecisionEvents').raiseDecision(s, 'relations');
        }
        require('../../World/PartyMembershipPublication')(sessions, invoke);
        invoke('GameServer/Bot/Population/PopulationMetrics').recordPartyDissolution();
        return { ok: true, partyId, released: sessions.length };
    } catch (error) {
        utils.infoWarn('BotParty', 'unsafe hunt review %s: %s', partyId, error.message);
        return { ok: false, reason: error.message };
    } finally {
        pending.delete(partyId);
        sessions.forEach(s => { delete s.hotHuntReview; World.notifyUserStateChanged(s); });
    }
}

function publish(sessions, states, party) {
    const Manager = invoke('GameServer/Bot/BotManager');
    const Response = invoke('GameServer/Network/Response');
    // No await here: no AI tick or observer can see a partially published roster.
    for (const session of sessions) {
        session.coldLifeState = states.find(s => s.characterId === id(session));
        session.hotBackgroundPartyId = party.partyId;
        session.populationHotAt = Date.now();
        session.populationStaging = false;
        World.insertUser(session);
        Manager.sessions.push(session);
    }
    for (const session of sessions) {
        session.actor.automation.replenishVitals(session.actor);
        session.dataSendToOthers(Response.charInfo(session.actor), session.actor);
        session.dataSendToOthers(Response.relationChanged(session.actor), session.actor);
        invoke('GameServer/Bot/BotAI').init(session);
    }
}

async function activate(partyId, reason = 'near_player', options = {}) {
    const encounter = members(Parties.find(partyId))?.map(s => s.stats?.pvpEncounter).find(Boolean);
    if (encounter) return invoke('GameServer/Bot/Population/PvpEncounterLifecycle').activate(encounter, reason, options);
    if (pending.has(partyId)) return { ok: false, reason: 'party_transition_pending' };
    pending.add(partyId);
    let party, states, reserved = false;
    const sessions = [];
    try {
        party = Parties.find(partyId);
        states = members(party);
        if (!ready(party, states)) {
            return { ok: false, reason: 'party_not_ready', detail: readinessReason(party, states) };
        }
        const fences = await Promise.all(states.map(s => Coordinator.fenceBot(s.characterId)));
        if (fences.some(f => !f.ok)) throw Error('party_fence_failed');
        await Life.settleWrites(party.memberIds);
        party = Parties.find(partyId);
        states = members(party);
        if (!ready(party, states)) throw Error('party_changed');
        const floor = invoke('GameServer/Bot/Population/FloorAwareActivationPolicy');
        if (options.playerLoc && floor.filterCandidates(states, { playerLoc: options.playerLoc, reason }).accepted.length !== states.length) {
            throw Error('party_floor_mismatch');
        }
        const leaderIndex = states.findIndex(s => s.characterId === party.leaderId);
        // Cold members can have historical positions across their shared spot.
        // Place the leader on the persisted safe anchor, then constrain the
        // rest of the roster to a compact formation around that resolved
        // point. Independent full-radius placement can scatter two valid
        // members almost 2.8k apart and reject the whole visible party.
        const leaderPlacement = Placement.resolve(states[leaderIndex], {
            ...options,
            preferAnchor: true,
            placementRadius: 240
        });
        const placements = states.map((state, index) => index === leaderIndex
            ? leaderPlacement
            : Placement.resolve({ ...state, loc: leaderPlacement?.loc || states[leaderIndex].loc }, {
                ...options,
                placementRadius: 420
            }));
        const leaderLoc = leaderPlacement?.loc;
        if (!leaderLoc || placements.some(p => !p || Math.hypot(p.loc.locX - leaderLoc.locX, p.loc.locY - leaderLoc.locY) > 1800
            || Math.abs(p.loc.locZ - leaderLoc.locZ) > 500)) throw Error('party_no_safe_placement');
        const raidBoss = raidBossForParty(party);
        if (raidBoss) party = { ...party, stats: { ...party.stats, hotRaidBoss: {
            instanceId: invoke('GameServer/RaidBoss/RaidEncounterScope').instanceId(raidBoss),
            maxHp: Number(raidBoss.fetchMaxHp?.() || 0)
        } } };
        ({ party, states } = await transition(party, states, states, 'hot', reason));
        reserved = true;
        syncColdRaidHp(party);
        const Manager = invoke('GameServer/Bot/BotManager');
        for (let i = 0; i < states.length; i++) {
            const s = states[i], placement = placements[i];
            const continuingRaid = raidObjective(party) && party.stats?.raidEncounter?.status === 'active'
                && !!party.stats.raidEncounter.encounter;
            const session = await Manager.loadAndSpawnBot(s.accountName, { name: s.name, homeRegion: s.homeRegion,
                prepareOnly: true, spawnReady: !continuingRaid, readyOnActivation: !continuingRaid, plan: 'hunting', backgroundActivity: 'grouped',
                currentSpot: placement.spot, coldLifeState: s, populationLocationPolicy: 'physical', ...placement.loc });
            if (!session || id(session) !== s.characterId) throw Error('party_spawn_failed');
            if (continuingRaid) {
                const actor = session.actor;
                actor.setHp?.(actor.fetchMaxHp() * Math.max(0, Math.min(1, s.vitals.hp / Math.max(1, s.vitals.maxHp))));
                actor.setMp?.(actor.fetchMaxMp() * Math.max(0, Math.min(1, s.vitals.mp / Math.max(1, s.vitals.maxMp))));
                actor.state.setDead?.(!(s.vitals.hp > 0));
                session.raidPreparationComplete = true;
                if (!(s.vitals.hp > 0)) {
                    session.hotRaidCasualtyAt = Date.now();
                    session.deathTimerStart = Date.now();
                }
            }
            sessions.push(session);
        }
        await Life.settleWrites(party.memberIds);
        states = members(Parties.find(partyId));
        const prepared = sessions.map(session => Life.partySessionSnapshot(session, states.find(s => s.characterId === id(session)), 'hot', reason));
        ({ party, states } = await transition(Parties.find(partyId), states, prepared, 'hot', reason));
        publish(sessions, states, party);
        for (const state of states) invoke('GameServer/Bot/Population/PopulationMetrics').recordActivation();
        if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info('BotPopulation :: activated party %s members=%d reason=%s', partyId, states.length, reason);
        if (raidObjective(party) && options.raidFanout !== false) {
            const competitors = Parties.raidCompetitors(Parties.raidBossKey(party), 'active', party.partyId, 'raid_fanout_activate');
            for (const competitor of competitors) {
                await activate(competitor.partyId, reason, { ...options, raidFanout: false });
            }
        }
        return { ok: true, party, states, count: states.length, reason };
    } catch (error) {
        discard(sessions);
        if (reserved) {
            // Keep a failed reservation fenced until the full rollback commits.
            // A failed DB rollback leaves an explicit hot reservation for retry/restart.
            try {
                party = Parties.find(partyId);
                states = members(party);
                await transition(party, states, states, 'cold', 'party_activation_rollback');
            } catch (rollback) {
                utils.infoWarn('BotPopulation', 'party activation rollback failed %s: %s', partyId, rollback.message);
                return { ok: false, reason: 'party_rollback_failed' };
            }
        }
        for (const state of members(Parties.find(partyId)) || []) Coordinator.notifyState(state);
        return { ok: false, reason: error.message };
    } finally { pending.delete(partyId); }
}

async function cooldown(partyId, reason = 'policy', options = {}) {
    const encounter = members(Parties.find(partyId))?.map(s => s.stats?.pvpEncounter).find(Boolean);
    if (encounter) return invoke('GameServer/Bot/Population/PvpEncounterLifecycle').cooldown(encounter, reason, options);
    if (pending.has(partyId)) return { ok: false, reason: 'party_transition_pending' };
    pending.add(partyId);
    let sessions = [], stopped = false, committed = false;
    try {
        let party = Parties.find(partyId);
        const states = members(party);
        if (party?.status !== 'hot' || !states) return { ok: false, reason: 'not_hot_party' };
        const Manager = invoke('GameServer/Bot/BotManager');
        sessions = party.memberIds.map(memberId => Manager.sessions.find(s => id(s) === memberId));
        const Cooldown = invoke('GameServer/Bot/Population/Cooldown');
        const eligible = () => {
            const players = invoke('GameServer/Bot/Population/PopulationService').realPlayerSessions();
            return !sessions.some(s => !s || s.populationStaging || !Cooldown.canCooldown(s, options).ok
            || s.actor.state.fetchHits?.() || s.actor.state.fetchCasts?.()
            || invoke('GameServer/Bot/AI/PartyAwareness').npcThreateningActor(s)
            || (!options.ignoreVisibility && (Date.now() - Number(s.populationHotAt || 0) < Config.cooldownGraceMs
                || players.some(p => Math.hypot(p.actor.fetchLocX() - s.actor.fetchLocX(), p.actor.fetchLocY() - s.actor.fetchLocY()) <= Math.max(Config.cooldownRadius, Config.activationRadius)))));
        };
        if (!eligible()) {
            return { ok: false, reason: 'party_member_busy_or_visible' };
        }
        for (const s of sessions) {
            invoke('GameServer/Bot/BotAI').stop(s);
            invoke('GameServer/Bot/AI/BotPvpTactics').stop(s, s.actor);
            s.actor.automation.stopReplenish();
        }
        stopped = true;
        await Life.settleWrites(party.memberIds);
        if (!eligible()) throw Error('party_member_busy_or_visible');
        party = captureHotRaidHp(Parties.find(partyId));
        const current = members(party);
        const next = sessions.map(s => Life.partySessionSnapshot(s, current.find(c => c.characterId === id(s)), 'cold', reason));
        const result = await transition(party, current, next, 'cold', reason);
        committed = true;
        discard(sessions);
        if (result.party?.stats?.raidEncounter?.status === 'failed') {
            const dissolved = await Parties.createOrUpdate({
                ...result.party,
                status: 'dissolved',
                nextResolveAt: null,
                stats: { ...(result.party.stats || {}), partyBreakReason: 'raid_failed', dissolvedAt: Date.now() }
            });
            if (dissolved) {
                await invoke('GameServer/Clan/ClanEquipmentService').recordRaidFailure(dissolved);
                await Life.clearParty(dissolved.partyId, 'raid_failed');
                result.party = dissolved;
                result.states = result.states.map((state) => Life.cachedState(state.characterId) || state);
            }
        }
        if (raidObjective(party) && options.raidFanout !== false) {
            const competitors = Parties.raidCompetitors(Parties.raidBossKey(party), 'hot', party.partyId, 'raid_fanout_cooldown');
            for (const competitor of competitors) {
                await cooldown(competitor.partyId, reason, { ...options, raidFanout: false });
            }
        }
        result.states.forEach(state => Coordinator.notifyState(state));
        for (const state of result.states) invoke('GameServer/Bot/Population/PopulationMetrics').recordCooldown();
        if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info('BotPopulation :: cooled party %s members=%d reason=%s', partyId, next.length, reason);
        return { ok: true, ...result, count: next.length };
    } catch (error) {
        if (stopped && !committed) sessions.filter(s => s?.actor).forEach(s => {
            s.actor.automation.replenishVitals(s.actor);
            invoke('GameServer/Bot/BotAI').init(s);
        });
        return { ok: false, reason: error.message };
    } finally { pending.delete(partyId); }
}

function markedHotStates(party, sessions) {
    const states = sessions.map(session => {
        const current = Life.cachedState(id(session));
        if (!current) return null;
        const actor = session.actor;
        // Only native assessment inputs, no wallet, wish, inventory or full
        // stats serialization. Full lifecycle snapshots belong to its CAS.
        const items = (actor.backpack?.fetchItems?.() || []).filter(item => item.fetchEquipped?.() ?? item.equipped);
        return { ...current, classId: Number(actor.fetchClassId()), clanId: Number(actor.fetchClanId()), level: Number(actor.fetchLevel()),
            partyId: current.party?.partyId,
            loc: { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() },
            vitals: { hp: actor.fetchHp(), maxHp: actor.fetchMaxHp(), mp: actor.fetchMp(), maxMp: actor.fetchMaxMp() },
            inventory: Life.inventorySummaryFromItems(items),
            stats: { ...current.stats, coldCombat: invoke('GameServer/Bot/Population/ColdCombatProfile').capture(actor), hennas: session.hennas || [] } };
    });
    return states.every(Boolean) ? states : [];
}

async function openMarkedRaid(party, sessions, timestamp = Date.now()) {
    const Roster = require('../../Clan/ClanRaidRoster');
    if (!Roster.markerFor(party) || Roster.held(party)) return { ok: true, party };
    if (pending.has(party.partyId)) return { ok: false, reason: 'party_transition_pending' };
    pending.add(party.partyId);
    let cancellation = null;
    try {
        const marker = Roster.markerFor(party);
        const spot = invoke('GameServer/RaidBoss/RaidEncounterScope').projectSource(
            invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById(marker.sourceId));
        const owner = Database.clanRaidOwner(marker);
        const current = await Life.statesByIds(marker.memberIds);
        if (current.length !== 9 || current.some(state => state.phase !== 'hot' || state.partyId !== party.partyId))
            return { ok: false, reason: 'raid_roster_member_changed' };
        const states = markedHotStates(party, sessions);
        const arrived = Roster.exact(sessions.map(id), marker.memberIds)
            && sessions.every(session => World.registeredActorById(id(session))?.session === session
                && session.hotBackgroundPartyId === party.partyId && !session.partyCompanion)
            && require('./PartyHuntingAssembly').nearby(states)
            && states.every(state => !state.stats?.travel && invoke('GameServer/Bot/AI/SpotService').containsLocation(spot, state.loc));
        // A compact eligibility pass is cheap. The native gear/power assessor
        // runs in the already admitted clan planning worker, once on opening.
        const early = Roster.admission(party, states, spot, { owner, arrived, timestamp, phase: 'hot',
            assessment: { ready: true, eligible: states } });
        if (!early.ok) { cancellation = early.reason; return early; }
        const Planning = require('../../Clan/ClanPlanningCoordinator');
        if (!Planning.enabled()) return { ok: false, reason: 'worker_not_ready' };
        const deadlineAt = Date.now() + 5000;
        const prepared = await Planning.withJob(deadlineAt, async jobKey => Planning.prepareRaids({ jobKey, deadlineAt,
            clan: { id: marker.clanId, level: owner.level, physicalMemberCount: 40, state: { mode: 'autonomous' },
                members: Roster.assessmentMembers(states).map(state => ({ ...state, clanId: marker.clanId })) },
            spots: [spot], prospects: [], previousGoal: { assignedMemberIds: marker.memberIds } }));
        const team = prepared.teams?.[spot.id];
        if (!team?.actualReady || !Roster.exact(team.memberIds, marker.memberIds)) return { ok: false, reason: 'raid_roster_composition' };
        const fresh = markedHotStates(party, sessions);
        if (fresh.some(state => Roster.inputFingerprint(state) !== Roster.inputFingerprint(states.find(before => before.characterId === state.characterId))))
            return { ok: false, reason: 'raid_roster_member_changed' };
        const freshArrived = sessions.every(session => World.registeredActorById(id(session))?.session === session
            && session.hotBackgroundPartyId === party.partyId && !session.partyCompanion)
            && require('./PartyHuntingAssembly').nearby(fresh)
            && fresh.every(state => !state.stats?.travel && invoke('GameServer/Bot/AI/SpotService').containsLocation(spot, state.loc));
        const checked = Roster.admission(party, fresh, spot, { owner: Database.clanRaidOwner(marker), arrived: freshArrived, timestamp, phase: 'hot',
            assessment: { ready: true, eligible: fresh } });
        if (!checked.ok) { cancellation = checked.reason; return checked; }
        const next = { ...party, stats: { ...party.stats, raidAdmission: checked.proof } };
        const snapshots = sessions.map(session => Life.partySessionSnapshot(session,
            current.find(state => state.characterId === id(session)), 'hot', 'clan_equipment_goal'));
        return { ok: true, ...(await transition(next, current, snapshots, 'hot', 'clan_equipment_goal')) };
    } catch (error) { return { ok: false, reason: error.message }; }
    finally {
        pending.delete(party.partyId);
        if (['raid_roster_owner_changed', 'raid_roster_source_changed', 'raid_failure_blocked'].includes(cancellation)) {
            const result = await cooldown(party.partyId, cancellation, { ignoreVisibility: true });
            if (result.ok) await require('../../Clan/ClanRaidRoster').cancelUnopened(result.party || Parties.find(party.partyId), cancellation);
        }
    }
}

function markedAttackInputs(party, sessions, paidActorId = null, paidCost = null) {
    const Roster = require('../../Clan/ClanRaidRoster');
    if (!Roster.admitted(party)) return [];
    const marker = Roster.markerFor(party);
    const spot = invoke('GameServer/RaidBoss/RaidEncounterScope').projectSource(
        invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById(marker.sourceId));
    const states = markedHotStates(party, sessions);
    const payer = paidCost && states.find(state => state.characterId === paidActorId);
    if (payer) payer.openingPaidCost = paidCost;
    const arrived = Roster.exact(sessions.map(id), marker.memberIds)
        && sessions.every(session => World.registeredActorById(id(session))?.session === session
            && session.hotBackgroundPartyId === party.partyId && !session.partyCompanion)
        && require('./PartyHuntingAssembly').nearby(states)
        && states.every(state => !state.stats?.travel && invoke('GameServer/Bot/AI/SpotService').containsLocation(spot, state.loc));
    return arrived && states.length === 9 && states.every(state => state.phase === 'hot' && state.partyId === party.partyId
        && state.vitals.hp > 0 && !state.stats?.playerPartyTakeover && !state.stats?.tradeMeeting
        && invoke('GameServer/Bot/AI/RestPolicy').raidReady(state, state.vitals, state.openingPaidCost)
        && Roster.inputFingerprint(state) === party.stats.raidAdmission.members.find(row => row[0] === state.characterId)?.[3]) ? states : [];
}
function markedAttackReady(party, sessions) {
    const Roster = require('../../Clan/ClanRaidRoster');
    return !Roster.markerFor(party) || Roster.held(party) || markedAttackInputs(party, sessions).length === 9;
}
function openMarkedRaidAtImpact(party, session, actor, target, boss, nativeImpact, paidCost = null) {
    const Roster = require('../../Clan/ClanRaidRoster');
    if (!Roster.isNativeImpact(nativeImpact) || pending.has(party.partyId) || party.status !== 'hot' || actor !== session.actor
        || !Roster.markerFor(party).memberIds.includes(id(session))) return false;
    const sessions = party.memberIds.map(memberId => World.registeredActorById(memberId)?.session).filter(Boolean);
    const members = markedAttackInputs(party, sessions, id(session), paidCost);
    if (members.length !== 9) return false;
    const result = Database.openClanRaidPartyAtImpact({ partyId: party.partyId, expectedPartyRevision: party.revision,
        attackerId: id(session), targetId: Number(target.fetchId()), bossId: Number(boss.fetchId()),
        raidInstanceId: invoke('GameServer/RaidBoss/RaidEncounterScope').instanceId(boss), members, nativeImpact });
    if (!result.ok) return false;
    Parties.acceptRow(result.party);
    return true;
}
async function confirmMarkedRaidStart(party) {
    const Roster = require('../../Clan/ClanRaidRoster');
    // Compatibility reader: opening is now committed at the executor impact,
    // before the hit, rather than promoted asynchronously on a later AI tick.
    return Roster.nativeHotStarted(party);
}

module.exports = {
    snapshotForConstPause(party, session) {
        const snapshot = captureHotRaidHp(party);
        pauseRaidWorld(snapshot, session);
        return snapshot;
    },
    abandonRaid: (session, reason, timestamp) => failRaidOnDeath(session, timestamp, { reason }),
    openMarkedRaid,
    openMarkedRaidAtImpact,
    markedAttackReady,
    confirmMarkedRaidStart,
    RAID_FAILURE_RETREAT_MS,
    activate,
    cooldown,
    releaseUnsafeHunt,
    pending,
    members,
    criticalRaidCasualty,
    raidDeathDisposition,
    failRaidOnDeath,
    raidFailureReady
};
