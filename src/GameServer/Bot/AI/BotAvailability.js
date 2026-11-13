const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotServiceIdentity = invoke('GameServer/Bot/AI/BotServiceIdentity');
const SpeckMath = invoke('GameServer/SpeckMath');
const InteractionMemory = invoke('GameServer/Social/InteractionMemoryRuntime');
const PlayerPartyRelationship = require('../../Social/PlayerPartyRelationship');

const MAX_LEVEL_GAP = 12;

function actorLocation(actor) {
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function distance(a, b) {
    if (!a || !b) return null;
    return new SpeckMath.Point3D(a.locX, a.locY, a.locZ).distance(new SpeckMath.Point3D(b.locX, b.locY, b.locZ));
}

function reasonText(reason) {
    const text = {
        available: 'available',
        missing_actor: 'missing actor',
        player_dead: 'you are dead',
        bot_dead: 'dead',
        already_grouped: 'already grouped',
        const_party_changed: 'that invitation is no longer active',
        merchant_duty: 'merchant duty',
        relationship_unloaded: 'give me a moment before we decide',
        relationship_hostile: 'we still have a conflict to settle',
        recently_abandoned: 'recently abandoned',
        level_gap_too_large: 'level gap too large',
        prefers_solo: 'prefers a solo run for now',
        hunting_target: 'busy fighting',
        in_transit: 'traveling right now',
        pk_encounter_only: 'busy hunting players'
    };
    return text[reason] || reason;
}

function clanIdOf(subject) {
    if (subject?.actor?.fetchClanId) return Number(subject.actor.fetchClanId()) || 0;
    if (subject?.fetchClanId) return Number(subject.fetchClanId()) || 0;
    return Number(subject?.clanId || subject?.stats?.clanId || 0);
}

function sameClan(player, botSubject) {
    const playerClanId = clanIdOf(player);
    if (playerClanId === 0) return false;
    if (botSubject?.actor || botSubject?.fetchClanId) {
        return playerClanId === clanIdOf(botSubject);
    }
    const clan = invoke('GameServer/Clan/ClanService').findById(playerClanId);
    const botId = subjectId(botSubject);
    return botId > 0 && !!clan?.members?.some(member => Number(member.id) === botId);
}

function subjectName(subject) {
    if (subject?.actor?.fetchName) return String(subject.actor.fetchName());
    if (subject?.fetchName) return String(subject.fetchName());
    return String(subject?.name || subject?.characterName || '');
}

function subjectId(subject) {
    if (subject?.actor?.fetchId) return Number(subject.actor.fetchId()) || 0;
    if (subject?.fetchId) return Number(subject.fetchId()) || 0;
    return Number(subject?.characterId || subject?.id || 0);
}

function catalogKey(subject) {
    const id = subjectId(subject);
    if (id > 0) return `id:${id}`;
    const name = subjectName(subject).trim().toLowerCase();
    return name ? `name:${name}` : '';
}

function emptyResult(playerSession, botSubject, options = {}) {
    const legacy = options.loadMemory === false
        ? BotSocialMemory.peekSnapshot(playerSession, botSubject)
        : BotSocialMemory.getSnapshot(playerSession, botSubject);
    const sourceId = subjectId(botSubject), targetId = subjectId(playerSession);
    const at = options.timestamp ?? Date.now();
    const botSession = botSubject?.actor ? botSubject : botSubject?.session;
    const aggressor = botSession?.pvpAggressors?.get(targetId);
    const relation = Number.isSafeInteger(sourceId) && sourceId > 0 && Number.isSafeInteger(targetId) && targetId > 0 ? InteractionMemory.assess(
        { id: sourceId, clanId: clanIdOf(botSubject) },
        { id: targetId, clanId: clanIdOf(playerSession) },
        { attackingMe: !!aggressor && at >= aggressor.at
            && at - aggressor.at <= invoke('GameServer/Bot/AI/BotPvpThreats').MEMORY_MS }, at) : null;
    const shared = PlayerPartyRelationship.combine(legacy, relation);
    const memory = shared.memory;
    return {
        available: false,
        reason: 'missing_actor',
        reasonText: reasonText('missing_actor'),
        distance: null,
        clanmate: false,
        clanLeader: false,
        relationship: shared.reason === 'relationship_hostile' ? 'hostile' : BotSocialMemory.relationship(memory),
        memory,
        sharedRelationship: shared.relation,
        relationshipReason: shared.reason
    };
}

// The bot's own clan leader has priority; ordinary player invitations depend
// on the relationship, level gap and membership.
// Persona, income, recovery and current solo activities belong to autonomous
// decisions and never veto joining a player's party.
function socialRefusal(memory) {
    if (Number(memory?.trust || 0) <= -6 || Number(memory?.hostility || 0) >= 10) return 'relationship_hostile';
    return null;
}

const BotAvailability = {
    socialRefusal,

    evaluate(playerSession, botSession, options = {}) {
        const player = playerSession?.actor;
        const bot = botSession?.actor;
        const result = emptyResult(playerSession, botSession, options);
        if (!player || !bot) return result;

        result.distance = distance(actorLocation(player), actorLocation(bot));
        result.clanmate = sameClan(player, bot);
        result.clanLeader = invoke('GameServer/Bot/AI/ClanLeaderPartyInvite').isLeaderFor(playerSession, botSession);
        const staticService = BotServiceIdentity.isStaticService(botSession);

        let reason = 'available';
        if (staticService) reason = 'merchant_duty';
        else if (options.constParty === true && !invoke('GameServer/Bot/AI/ConstPartySession').isCurrent(playerSession, botSession)) reason = 'const_party_changed';
        else if (result.clanLeader || options.constParty === true) reason = 'available';
        else if (botSession.hotBackgroundPartyId || botSession.hotCompetitionCommit || botSession.coldLifeState?.party?.partyId
            || botSession.partyCompanion || botSession.followPlayerSession) reason = 'already_grouped';
        else if (result.relationshipReason) reason = result.relationshipReason;
        else if (socialRefusal(result.memory)) reason = 'relationship_hostile';
        else if (Math.abs(bot.fetchLevel() - player.fetchLevel()) > MAX_LEVEL_GAP) reason = 'level_gap_too_large';
        result.available = reason === 'available';
        result.reason = reason;
        result.reasonText = reasonText(reason);
        return result;
    },

    evaluateState(playerSession, state, options = {}) {
        const player = playerSession?.actor;
        const result = emptyResult(playerSession, state, options);
        const timestamp = Number(options.timestamp ?? Date.now());
        if (!player || !state) return result;

        // A trip is no "busy" reason: the traveller answers from
        // where it is now on its road.
        const traveller = state.activity === 'traveling';
        result.distance = distance(actorLocation(player), traveller
            ? invoke('GameServer/Bot/Population/ColdTrip').positionAt(state, timestamp) : state.loc);
        result.clanmate = sameClan(player, state);
        result.clanLeader = invoke('GameServer/Bot/AI/ClanLeaderPartyInvite').isLeaderFor(playerSession, state);
        const staticService = BotServiceIdentity.isStaticService(state);

        let reason = 'available';
        if (staticService) reason = 'merchant_duty';
        else if (options.constParty === true && !invoke('GameServer/Bot/AI/ConstPartySession').isCurrent(playerSession, state)) reason = 'const_party_changed';
        else if (result.clanLeader || options.constParty === true) reason = 'available';
        else if (state.party?.partyId || state.partyId || state.stats?.backgroundPartyId
            || state.stats?.playerPartyTakeover?.playerId) reason = 'already_grouped';
        else if (result.relationshipReason) reason = result.relationshipReason;
        else if (socialRefusal(result.memory)) reason = 'relationship_hostile';
        else if (Math.abs(Number(state.level || 1) - player.fetchLevel()) > MAX_LEVEL_GAP) reason = 'level_gap_too_large';
        result.available = reason === 'available';
        result.reason = reason;
        result.reasonText = reasonText(reason);
        return result;
    },

    listForPlayer(playerSession, botSessions) {
        return botSessions
            .filter((session) => session.actor && !BotServiceIdentity.isStaticService(session))
            .filter((session) => !(session.partyCompanion === true && session.followPlayerSession === playerSession))
            .map((session) => ({
                session,
                bot: session.actor,
                availability: this.evaluate(playerSession, session)
            }))
            .sort((a, b) => {
                if (a.availability.available !== b.availability.available) return a.availability.available ? -1 : 1;
                return (a.availability.distance ?? Number.MAX_SAFE_INTEGER) - (b.availability.distance ?? Number.MAX_SAFE_INTEGER);
            });
    },

    catalogForPlayer(playerSession, botSessions = [], lifeStates = []) {
        const hotKeys = new Set();
        const hotNames = new Set();
        (botSessions || []).forEach((session) => {
            const key = catalogKey(session);
            const name = subjectName(session).trim().toLowerCase();
            if (key) hotKeys.add(key);
            if (name) hotNames.add(name);
        });

        const hot = (botSessions || [])
            .filter((session) => session?.actor && !BotServiceIdentity.isStaticService(session))
            .filter((session) => !(session.partyCompanion === true && session.followPlayerSession === playerSession))
            .map((session) => ({
                session,
                state: session.coldLifeState || null,
                subject: session.actor,
                name: subjectName(session),
                level: Number(session.actor.fetchLevel?.() || 1),
                phase: 'hot'
            }));

        const cold = (lifeStates || [])
            .filter((state) => state && !BotServiceIdentity.isStaticService(state))
            .filter((state) => {
                const key = catalogKey(state);
                const name = subjectName(state).trim().toLowerCase();
                return (!key || !hotKeys.has(key)) && (!name || !hotNames.has(name));
            })
            .map((state) => ({
                session: null,
                state,
                subject: state,
                name: subjectName(state),
                level: Number(state.level || 1),
                phase: 'cold'
            }));

        return [...hot, ...cold].filter((candidate) => candidate.name);
    },

    reasonText
};

module.exports = BotAvailability;
