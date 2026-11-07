// A marked equipment roster is a committed owner identity, not a head count.
// Combat math and composition remain owned by ClanRaidPolicy.
const Demand = require('./ClanRosterDemand');
const ReviewEvents = require('./ClanReviewEvents');
// Invocation authority, never persisted or cached per actor/party.
const nativeImpact = Symbol('native-raid-offensive-impact');
const isNativeImpact = value => value === nativeImpact;
const id = member => Number(member?.characterId ?? member?.id);
const ids = values => (Array.isArray(values) ? values : []).map(Number).sort((a, b) => a - b);
const exact = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && new Set(left).size === left.length && JSON.stringify(ids(left)) === JSON.stringify(ids(right));
function identity(marker) {
    return marker && [marker.clanId, marker.ownerSection, marker.goalKey, marker.generation,
        ids(marker.memberIds), marker.sourceId, marker.npcId, marker.raidInstanceId, marker.minPartySize, marker.maxPartySize];
}
const same = (left, right) => JSON.stringify(identity(left)) === JSON.stringify(identity(right));
function inputFingerprint(member) {
    return Demand.memberFingerprint({ characterId: id(member), classId: Number(member.classId ?? member.stats?.classId ?? 0),
        level: Number(member.level), clanId: 0, phase: 'cold',
        inventory: member.inventory || {}, stats: { coldCombat: member.stats?.coldCombat, hennas: member.stats?.hennas } });
}
const markerFor = party => party?.stats?.objective?.fullRoster || null;
function valid(marker) {
    return marker?.clanId > 0 && ['goal', 'productionGoal'].includes(marker.ownerSection)
        && !!marker.goalKey && !!marker.generation && !!marker.sourceId && marker.npcId > 0 && !!marker.raidInstanceId
        && marker.minPartySize === 9 && marker.maxPartySize === 9 && Array.isArray(marker.memberIds) && marker.memberIds.length === 9
        && new Set(marker.memberIds).size === 9 && marker.memberIds.every(value => Number.isSafeInteger(value) && value > 0);
}
function admitted(party, spot = null) {
    const marker = markerFor(party), proof = party?.stats?.raidAdmission;
    return valid(marker) && proof?.partyId === party.partyId && proof.openedAt > 0
        && same(marker, proof.marker) && Array.isArray(proof.members)
        && proof.members.every(row => Array.isArray(row) && row.length === 4 && Number.isSafeInteger(row[0]))
        && exact(proof.members.map(row => row[0]), marker.memberIds)
        && (!spot || marker.sourceId === spot.id && Number(marker.npcId) === Number(spot.raidBossTemplateId)
            && marker.raidInstanceId === spot.raidInstanceId);
}
function held(party, spot = null) { return admitted(party, spot)
    && exact(party.memberIds, markerFor(party).memberIds) && Number(party.stats.raidAdmission.startedAt) > 0; }
function nativeHotStarted(party) {
    const marker = markerFor(party), execution = party?.stats?.raidAdmission?.execution;
    // Written by the native offensive impact transaction, before damage can
    // destroy the boss/target or complete the equipment owner goal.
    return held(party) && execution?.at === party.stats.raidAdmission.startedAt
        && marker.memberIds.includes(execution.attackerId) && execution.targetId > 0 && execution.bossId > 0
        && execution.raidInstanceId === marker.raidInstanceId;
}
function offensiveParty(session) {
    const party = session?.hotBackgroundPartyId
        && invoke('GameServer/Bot/Population/BackgroundPartyState').find(session.hotBackgroundPartyId);
    return markerFor(party) ? party : null;
}
function beforeOffensiveEffect(session, actor, target, dispatchedParty = null, paidCost = null) {
    if (!session?.hotBackgroundPartyId) return !dispatchedParty;
    const party = invoke('GameServer/Bot/Population/BackgroundPartyState').find(session.hotBackgroundPartyId);
    if (dispatchedParty && (!party || party.status !== 'hot' || party.partyId !== dispatchedParty.partyId
        || !same(markerFor(party), markerFor(dispatchedParty)))) return false;
    if (!markerFor(party)) return true;
    const Safety = invoke('GameServer/Bot/AI/BotRaidSafety');
    if (!Safety.isProtectedRaidEntity(target)) return true;
    const boss = Safety.raidBossFor(target), marker = markerFor(party);
    if (Number(boss?.fetchSelfId?.()) !== marker.npcId
        || invoke('GameServer/RaidBoss/RaidEncounterScope').instanceId(boss) !== marker.raidInstanceId) return false;
    if (held(party)) return marker.memberIds.includes(Number(actor?.fetchId?.()));
    return invoke('GameServer/Bot/Population/HotPartyLifecycle').openMarkedRaidAtImpact(party, session, actor, target, boss, nativeImpact, paidCost);
}
function assessmentMembers(members) {
    // The native planner accepts cold states. Execution callers have already
    // proved their actual hot or party state separately.
    return members.map(member => ({ ...member, classId: Number(member.classId ?? member.stats?.classId ?? 0),
        phase: 'cold', partyId: member.partyId || member.party?.partyId }));
}
function selectMembers(members, objective, options = {}) {
    const marker = objective?.fullRoster;
    if (!marker) return invoke('GameServer/Bot/Population/BackgroundPartyComposition').selectMembers(members, options);
    if (!valid(marker)) return [];
    const selected = members.filter(member => marker.memberIds.includes(id(member))
        && Number(member.clanId ?? member.stats?.clanId) === Number(marker.clanId)
        && same(member.stats?.clanPartyObjective?.fullRoster || member.stats?.partyRequest?.fullRoster, marker));
    return exact(selected.map(id), marker.memberIds)
        && require('./ClanRaidPolicy').composition(selected, { desiredMembers: 9, requireCapabilities: true }).ready ? selected : [];
}
function admission(party, members, spot, options = {}) {
    const marker = markerFor(party);
    if (!marker) return { ok: true, legacy: true };
    if (held(party, spot)) return { ok: true, held: true, proof: party.stats.raidAdmission };
    const fail = reason => ({ ok: false, reason });
    if (!valid(marker) || !exact(party.memberIds, marker.memberIds) || !exact(members.map(id), marker.memberIds)) return fail('raid_roster_incomplete');
    if (party.spotId !== marker.sourceId || spot?.id !== marker.sourceId
        || Number(spot.raidBossTemplateId) !== Number(marker.npcId) || spot.raidInstanceId !== marker.raidInstanceId
        || spot.raidWorldAvailable === false) return fail('raid_roster_source_changed');
    const owner = options.owner;
    if (!owner || owner.mode !== 'autonomous' || !same(owner.marker, marker)) return fail('raid_roster_owner_changed');
    if (owner.raidBlocked) return fail('raid_failure_blocked');
    // A clan departure ends the roster (owner change cancels the party); the rest is transient.
    if (members.some(member => {
        const current = owner.members?.find(row => row[0] === id(member));
        return !current || current[2] !== marker.clanId || Number(member.clanId ?? member.stats?.clanId) !== marker.clanId;
    })) return fail('raid_roster_owner_changed');
    if (members.some(member => {
        const current = owner.members.find(row => row[0] === id(member));
        return current[1] !== Number(member.classId ?? member.stats?.classId ?? 0)
            || current[3] !== Number(member.level) || current[4]
            || String(member.partyId || member.party?.partyId || '') !== String(party.partyId)
            || member.phase !== (options.phase || 'cold')
            || !(Number(member.vitals?.hp ?? member.hp) > 0) || member.stats?.travel || member.stats?.tradeMeeting
            || member.stats?.playerPartyTakeover;
    })) return fail('raid_roster_member_changed');
    if (options.phase === 'hot' && members.some(member => !invoke('GameServer/Bot/AI/RestPolicy').raidReady(member))) {
        return fail('raid_resources_not_ready');
    }
    if (!options.arrived) return fail('party_assembling');
    const assessment = options.assessment || require('./ClanRaidPolicy').assessment({ members: assessmentMembers(members) }, spot,
        { assignedMemberIds: marker.memberIds }, { desiredMembers: 9, requireCapabilities: true, preferredMemberIds: marker.memberIds });
    if (!assessment.ready || !exact((assessment.eligible || []).map(id), marker.memberIds)) return fail(assessment.reason || 'raid_roster_composition');
    return { ok: true, proof: { partyId: party.partyId, marker, openedAt: Number(options.timestamp || Date.now()),
        startedAt: options.phase === 'hot' ? null : Number(options.timestamp || Date.now()),
        members: members.map(member => [id(member), Number(member.classId ?? member.stats?.classId ?? 0), Number(member.level), inputFingerprint(member)]) } };
}
async function cancelUnopened(party, reason) {
    const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const current = Parties.find(party?.partyId);
    if (!current || current.status !== 'active' || held(current) || !same(markerFor(current), markerFor(party))
        || Number(current.revision) !== Number(party.revision)) return false;
    const saved = await Parties.createOrUpdate({ ...current, status: 'dissolved', nextResolveAt: null,
        stats: { ...current.stats, partyBreakReason: reason } });
    if (!saved) return false;
    await invoke('GameServer/Bot/Population/BotLifeState').releaseDissolvedPartyMembers(party.partyId, reason);
    wakeCancelled(current, reason);
    return true;
}
// A marked party dissolved for one of these reasons leaves its clan goal executing:
// wake its review for a new attempt. Callers wake only after the dissolve is saved.
const CANCEL_REASONS = Object.freeze(['raid_roster_owner_changed', 'raid_roster_source_changed', 'raid_roster_not_opened', 'raid_failure_blocked']);
function wakeCancelled(party, reason = party?.stats?.partyBreakReason) {
    const marker = markerFor(party);
    if (!marker || !CANCEL_REASONS.includes(reason)) return false;
    return ReviewEvents.changed(marker.clanId, 'raid_cancelled');
}
module.exports = { markerFor, identity, same, valid, exact, admitted, held, nativeHotStarted, offensiveParty, beforeOffensiveEffect, isNativeImpact, inputFingerprint, assessmentMembers, selectMembers, admission, cancelUnopened, CANCEL_REASONS, wakeCancelled };
