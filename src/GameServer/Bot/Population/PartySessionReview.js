const AssemblyRecovery = require('./PartyAssemblyRecovery');
const ClanEquipment = require('./ClanEquipmentPartyPolicy');
const { fnv1a32 } = require('../Fnv1a');
const MINUTE = 60000;
// Recent progress sustains a group: a win within this window keeps a member
// whose own goal lies elsewhere (our rule, not C4).
const PROGRESS_WINDOW_MS = 10 * MINUTE;
const clamp = n => Math.max(0, Math.min(1, Number(n) || 0));
const Rewards = require('../../Actor/PartyRewardMath');

// What the review reads of the members' relations: per member, whether it is
// friendly with or hostile to a peer and whether its memory is ready (memory,
// clan war and clan social between the members only). options.relationFlags:
// the caller's held answer (the worker keeps it while the members' memory,
// war and social revisions hold); else read here.
function relationFlags(members, options = {}, timestamp = Date.now()) {
    const held = options.relationFlags?.(members, timestamp);
    if (held) return held;
    return members.map(member => {
        let friendly = false, hostile = false, memoryReady = true;
        for (const peer of members) {
            if (peer.characterId === member.characterId) continue;
            const relation = options.assessRelationship?.({ id: member.characterId }, { id: peer.characterId }, {}, timestamp);
            if (!relation?.ready) { memoryReady = false; continue; }
            friendly ||= relation.disposition === 'friendly';
            hostile ||= relation.disposition === 'hostile' || relation.diplomaticEnemy === true;
            friendly ||= Number(relation.effective?.trust || 0) >= 5;
            hostile ||= Number(relation.effective?.hostility || 0) >= 10;
        }
        return [friendly, hostile, memoryReady];
    });
}

// The review's inputs that move by a write or a revision, hashed: the roster
// with its levels (XP eligibility, the shared target's band), the party's
// ground, objective, acquisition goal and clan help roster, each member's
// plan target and clan objective, and what the review reads of the relations
// between the members (relationFlags). The review runs when this moves; its
// clocks (patience, grace, recent progress, no fight, clan help's end, a
// pause's end) are the due rule's (due).
function inputKey(party, members, options = {}, timestamp = Date.now()) {
    const flags = relationFlags(members, options, timestamp);
    const stats = party.stats || {}, objective = stats.objective || {};
    return fnv1a32(JSON.stringify([party.spotId ?? null,
        [objective.npcId, objective.spotId, objective.clanGoalKey, objective.sourceKind, objective.raidBoss,
            objective.opportunisticRaid, objective.minPartySize, objective.reason, objective.kind].map(value => value ?? null),
        stats.acquisitionGoal?.next?.npcId ?? null, stats.clanHelp?.memberIds ?? null,
        members.map((member, at) => {
            const plan = member.stats?.equipmentPlan, clan = member.stats?.clanPartyObjective;
            return [Number(member.characterId), Number(member.level || 1), plan?.status ?? null, plan?.next?.spotId ?? null,
                plan?.next?.npcId ?? null, plan?.targetNpcId ?? null, plan?.requiresParty ?? null, plan?.partyNeed ?? null,
                clan?.status ?? null, clan?.clanGoalKey ?? null, flags[at]];
        })]));
}

// A shared target born from spot competition (cold: `reason`,
// HotCompetitionParty: `kind`) ends otherwise only when the party objectives
// are rebuilt, which happens while some bot waits for a required party. The
// party agrees it is done once every mob of that ground is below the leader's
// hunt band; it then routes like any other party. `spot` is the party's
// current ground.
function sharedTargetOutgrown(party, members, spot) {
    const objective = party.stats?.objective;
    if (objective?.reason !== 'shared_target' && objective?.kind !== 'shared_target') return false;
    if (!spot || String(spot.id) !== String(objective.spotId)) return false;
    const leader = members.find(m => m.characterId === party.leaderId) || members[0];
    if (!leader) return false;
    return Number(spot.maxLevel) < require('../AI/SpotService').huntBand(Number(leader.level)).min;
}

// When the party's last rest or market break ended (0: none).
function pauseEnd(party) {
    return Math.max(Number(party.stats?.restUntil || 0),
        ...Object.values(party.stats?.marketAbsences || {}).map(value => Number(value.until) || 0));
}

// A review is a conversation, not a forced disband, held when its inputs move
// (inputKey) or one of its clocks runs out (due). No random rolls: rereading
// the same persisted evidence produces the same individual decisions.
function assess(party, members, timestamp, options = {}) {
    const previous = party.stats?.sessionReview || {};
    const wins = Number(party.stats?.fightsWon || 0);
    const fights = Number(party.stats?.fightsResolved || 0);
    const progressAt = Number(party.stats?.lastProgressAt || 0);
    const gained = previous.at && wins > Number(previous.wins || 0);
    // Progress dates from the last win where the party row knows it.
    const noProgressSince = gained || (progressAt > Number(previous.noProgressSince || 0))
        ? progressAt || timestamp
        : Number(previous.noProgressSince || timestamp);
    const attemptsSinceProgress = gained || progressAt > Number(previous.noProgressSince || 0) ? 0
        : Number(previous.attemptsSinceProgress || 0) + Math.max(0, fights - Number(previous.fights ?? fights));
    const profitable = (gained || progressAt > 0) && timestamp - noProgressSince < PROGRESS_WINDOW_MS;
    const marketPaused = require('./PartyMarketBreak').pending(party, timestamp).length > 0;
    const paused = marketPaused || party.stats?.travel || Number(party.stats?.restUntil || 0) > timestamp;
    // Since when the party resolved no fight (its first review: formation;
    // a trip's arrival restarts it), counted from its last pause's end.
    const idleSince = !previous.at || fights !== Number(previous.fights ?? fights) ? timestamp
        : Number(previous.idleSince || previous.at);
    const idleFor = timestamp - Math.max(idleSince, pauseEnd(party));
    const assemblyExpired = AssemblyRecovery.expired(party);
    const understaffed = party.stats?.objective?.clanGoalKey
        && members.length < Math.max(2, Number(party.stats.objective.minPartySize) || 3);
    const raidObjective = party.stats?.objective?.sourceKind === 'raid'
        || party.stats?.objective?.raidBoss === true;
    const raidCommitted = party.stats?.objective?.opportunisticRaid === true;
    const raidRosterIncomplete = raidObjective
        && !(party.stats?.objective?.opportunisticRaid
            ? require('./OpportunisticRaidPolicy').composition(members)
            : require('../../Clan/ClanRaidPolicy').composition(members)).ready;
    const assemblyRecovered = assemblyExpired && !understaffed && !raidRosterIncomplete
        && require('./PartyHuntingAssembly').ready(party, members, { id: party.spotId });
    const abandonedRaid = ClanEquipment.abandonedRaid(party);
    const target = Number(party.stats?.objective?.npcId || party.stats?.acquisitionGoal?.next?.npcId || 0);
    const concerns = {}, decisions = [], experience = {};
    // The clocks the next review waits on (due): fixed deadlines, the least
    // patience of a member not yet stalled, a member kept only by recent
    // progress, and whether a pause holds back a reason or a concern.
    const deadlines = [];
    let patienceLeft = Infinity, profitHeld = false, pauseHolds = false;
    const eligible = new Set(Rewards.validMemberIndexes(members.map(m => Number(m.level || 1))));
    const flags = relationFlags(members, options, timestamp);
    for (const member of members) {
        const traits = (options.personaFor?.(member) || member.persona)?.traits || {};
        const commitment = clamp(traits.commitment ?? 0.5), caution = clamp(traits.caution ?? 0.5);
        const social = clamp(traits.sociability ?? 0.5), empathy = clamp(traits.empathy ?? 0.5);
        const [friendly, hostile, memoryReady] = flags[members.indexOf(member)];
        const plan = member.stats?.equipmentPlan;
        const active = plan?.status === 'active' && !!plan.next?.spotId;
        const sameTarget = active && ((target > 0 && Number(plan.next?.npcId || plan.targetNpcId) === target)
            || plan.next.spotId === party.spotId);
        const clanObjective = member.stats?.clanPartyObjective;
        const sharedClan = clanObjective?.status === 'open' && !!clanObjective.clanGoalKey
            && clanObjective.clanGoalKey === party.stats?.objective?.clanGoalKey;
        const clanHelp = Number(party.stats?.clanHelp?.until || 0) > timestamp
            && party.stats.clanHelp.memberIds?.map(Number).includes(Number(member.characterId));
        const helping = clanHelp || friendly && (empathy + commitment >= 1.2);
        const patience = (8 + commitment * 8 + (friendly ? social * 6 : 0) - caution * 2) * MINUTE;
        // Failed fights with no win, or no fight at all, over the member's patience.
        const stalled = attemptsSinceProgress >= 3 && timestamp - noProgressSince >= patience
            || !paused && idleFor >= patience;
        // Group wins must not reset the patience of a member excluded from XP.
        // Only fights observed while this particular member is excluded count.
        const excluded = !eligible.has(members.indexOf(member));
        const priorXp = previous.experience?.[member.characterId];
        if (excluded) experience[member.characterId] = {
            since: Number(priorXp?.since ?? timestamp),
            wins: Number(priorXp?.wins ?? wins), patience
        };
        const noExperience = excluded && wins - experience[member.characterId].wins >= 3
            && timestamp - experience[member.characterId].since >= patience;
        let reason = null;
        const elsewhere = !raidCommitted && active && !sameTarget && !sharedClan && !helping;
        const diverged = elsewhere && (!profitable || plan.requiresParty || plan.partyNeed === 'required');
        if (!paused) {
            if (hostile) reason = 'party_relationship_conflict';
            else if (diverged) reason = 'party_goals_diverged';
            profitHeld ||= !hostile && elsewhere && !diverged;
        } else pauseHolds ||= hostile || elsewhere;
        if (!raidCommitted && options.requiresWeaponBridge?.(member)) reason = 'weapon_bridge';
        const equipmentBridgeReason = options.equipmentBridgeReason?.(member);
        if (!raidCommitted && equipmentBridgeReason) reason = equipmentBridgeReason;
        // Recovery alone proves nothing, but it must not hide repeated failed
        // fights already observed over the member's patience window.
        if (!marketPaused && noExperience) reason = 'party_no_experience';
        else if (!marketPaused && !reason && stalled) reason = 'party_no_progress';
        if (!paused && assemblyExpired && !assemblyRecovered) reason = AssemblyRecovery.REASON;
        if (!ClanEquipment.allowed(member, party.stats?.objective)) {
            reason = 'clan_party_unsafe';
        }
        if (abandonedRaid) reason = 'raid_failed';
        const prior = previous.concerns?.[member.characterId];
        const since = prior?.reason === reason ? Number(prior.since) : timestamp;
        // Suspend a goal/conflict grace period while recovering instead of
        // erasing its accumulated evidence on every ordinary rest cycle.
        if (paused && !reason && prior) {
            concerns[member.characterId] = {
                ...prior, since: Number(prior.since) + Math.max(0, timestamp - Number(previous.at || timestamp))
            };
            pauseHolds = true;
        }
        if (reason) concerns[member.characterId] = { reason, since };
        const grace = [AssemblyRecovery.REASON, 'party_no_progress', 'party_no_experience', 'clan_party_unsafe', 'weapon_bridge', 'class_armor_bridge', 'raid_failed'].includes(reason)
            ? 0
            : (2 + commitment * 4) * MINUTE;
        const leave = !!reason && timestamp - since >= grace;
        if (reason && !leave) deadlines.push(since + grace);
        // A stall the review acted on waits on its concern; one a market
        // break held back is judged again after it (due).
        if (!leave && !(stalled && reason)) patienceLeft = Math.min(patienceLeft, patience);
        // A leaving member's evidence wakes no later review.
        if (leave) delete experience[member.characterId];
        decisions.push({ characterId: member.characterId, leave,
            reason: reason || (paused ? 'party_recovering_or_travelling' : sameTarget || sharedClan ? 'party_shared_goal'
                : friendly ? 'party_friends' : 'party_observing_progress'), memoryReady });
    }
    const objectiveDone = sharedTargetOutgrown(party, members, options.spot);
    if (Number(party.stats?.clanHelp?.until || 0) > timestamp) deadlines.push(Number(party.stats.clanHelp.until));
    return { decisions, assemblyRecovered, objectiveDone, review: { at: timestamp,
        nextAt: deadlines.length ? Math.min(...deadlines) : 0, wins, fights, attemptsSinceProgress,
        noProgressSince, idleSince, patience: Number.isFinite(patienceLeft) ? patienceLeft : 0, profitHeld, pauseHolds,
        concerns, experience, decisions } };
}

// A review is due when its inputs moved since the last one (members: the
// party's current states, the key's) or one of its clocks ran out: a fixed
// deadline (a concern's grace, clan help's end), a pause ended that held back
// a reason or a concern, the least patience of a member not yet stalled after
// three fights with no win or with no fight at all (time is its input; after a
// win the first review counts afresh), the recent progress that kept a member, or an XP-excluded
// member's patience after three wins. Wins and fights are the party row's.
function due(party, members, timestamp, options = {}) {
    const review = party.stats?.sessionReview || {}, stats = party.stats || {};
    if (Number(review.nextAt || 0) > 0 && timestamp >= Number(review.nextAt)) return true;
    if (members && review.key !== inputKey(party, members, options, timestamp)) return true;
    const marketPaused = require('./PartyMarketBreak').pending(party, timestamp).length > 0;
    if (review.pauseHolds && !marketPaused && !stats.travel && Number(stats.restUntil || 0) <= timestamp) return true;
    if (marketPaused) return false;
    const wins = Number(stats.fightsWon || 0), fights = Number(stats.fightsResolved || 0);
    const progressAt = Number(stats.lastProgressAt || 0), since = Number(review.noProgressSince || 0);
    const patience = Number(review.patience || 0);
    if (wins > Number(review.wins || 0) || progressAt > since) {
        if (patience > 0 && timestamp - progressAt >= patience) return true;
    } else if (patience > 0 && Number(review.attemptsSinceProgress || 0) + fights - Number(review.fights || 0) >= 3
        && timestamp - since >= patience) return true;
    if (patience > 0 && fights === Number(review.fights || 0) && !stats.travel && Number(stats.restUntil || 0) <= timestamp
        && timestamp - Math.max(Number(review.idleSince || review.at || 0), pauseEnd(party)) >= patience) return true;
    if (review.profitHeld && timestamp - Math.max(progressAt, since) >= PROGRESS_WINDOW_MS) return true;
    return Object.values(review.experience || {}).some(entry => wins - Number(entry.wins) >= 3
        && timestamp - Number(entry.since) >= Number(entry.patience || 0));
}

module.exports = { assess, due, inputKey, relationFlags, PROGRESS_WINDOW_MS };
