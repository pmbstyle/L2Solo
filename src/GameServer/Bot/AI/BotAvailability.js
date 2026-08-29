const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotServiceIdentity = invoke('GameServer/Bot/AI/BotServiceIdentity');
const PersonaPartyDecisionPolicy = invoke('GameServer/Bot/AI/PersonaPartyDecisionPolicy');
const SpeckMath = invoke('GameServer/SpeckMath');

const MAX_LEVEL_GAP = 12;
const RECENT_ABANDON_MS = 5 * 60 * 1000;

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
        merchant_duty: 'merchant duty',
        low_trust: 'low trust',
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
    return playerClanId === clanIdOf(botSubject);
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
    const memory = options.loadMemory === false
        ? BotSocialMemory.peekSnapshot(playerSession, botSubject)
        : BotSocialMemory.getSnapshot(playerSession, botSubject);
    return {
        available: false,
        reason: 'missing_actor',
        reasonText: reasonText('missing_actor'),
        distance: null,
        clanmate: false,
        relationship: BotSocialMemory.relationship(memory),
        memory
    };
}

const BotAvailability = {
    evaluate(playerSession, botSession, options = {}) {
        const player = playerSession?.actor;
        const bot = botSession?.actor;
        const result = emptyResult(playerSession, botSession, options);

        if (!player || !bot) return result;

        result.distance = distance(actorLocation(player), actorLocation(bot));
        result.clanmate = sameClan(player, bot);
        const staticService = BotServiceIdentity.isStaticService(botSession);

        let reason = 'available';
        if (staticService) reason = 'merchant_duty';
        else if (result.clanmate) reason = 'available';
        else if (player.isDead && player.isDead()) reason = 'player_dead';
        else if (bot.isDead && bot.isDead()) reason = 'bot_dead';
        else if (!options.forceFriend && botSession.plan === 'merchant') reason = 'merchant_duty';
        else if (!options.forceFriend && botSession.partyCompanion === true && botSession.followPlayerSession) reason = 'already_grouped';
        else if (!options.forceFriend && result.memory.trust <= -6) reason = 'low_trust';
        else if (!options.forceFriend && result.memory.recentlyAbandonedAt && Date.now() - result.memory.recentlyAbandonedAt < RECENT_ABANDON_MS) reason = 'recently_abandoned';
        else if (!options.forceFriend && Math.abs(bot.fetchLevel() - player.fetchLevel()) > MAX_LEVEL_GAP) reason = 'level_gap_too_large';

        if (reason === 'available' && !result.clanmate && !options.forceFriend) {
            result.partyDecision = PersonaPartyDecisionPolicy.evaluate(botSession, result.memory);
            if (!result.partyDecision.accept) {
                reason = result.partyDecision.reason;
            }
        }
        result.available = reason === 'available';
        result.reason = reason;
        result.reasonText = result.partyDecision?.reason === reason
            ? result.partyDecision.reasonText : reasonText(reason);
        return result;
    },

    evaluateState(playerSession, state, options = {}) {
        const player = playerSession?.actor;
        const result = emptyResult(playerSession, state, options);
        if (!player || !state) return result;

        result.distance = distance(actorLocation(player), state.loc);
        result.clanmate = sameClan(player, state);
        const staticService = BotServiceIdentity.isStaticService(state);

        let reason = 'available';
        if (staticService) reason = 'merchant_duty';
        else if (!options.forceFriend && state.activity === 'traveling') reason = 'in_transit';
        else if (!options.forceFriend && state.activity === 'pk_hunting') reason = 'pk_encounter_only';
        else if (result.clanmate) reason = 'available';
        else if (player.isDead && player.isDead()) reason = 'player_dead';
        else if (state.activity === 'dead' || Number(state.vitals?.hp || 1) <= 0) reason = 'bot_dead';
        else if (!options.forceFriend && (state.activity === 'merchant' || state.activity === 'crafting')) reason = 'merchant_duty';
        else if (!options.forceFriend && result.memory.trust <= -6) reason = 'low_trust';
        else if (!options.forceFriend && result.memory.recentlyAbandonedAt && Date.now() - result.memory.recentlyAbandonedAt < RECENT_ABANDON_MS) reason = 'recently_abandoned';
        else if (!options.forceFriend && Math.abs(Number(state.level || 1) - player.fetchLevel()) > MAX_LEVEL_GAP) reason = 'level_gap_too_large';

        if (reason === 'available' && !result.clanmate && !options.forceFriend) {
            result.partyDecision = PersonaPartyDecisionPolicy.evaluate(state, result.memory);
            if (!result.partyDecision.accept) {
                reason = result.partyDecision.reason;
            }
        }
        result.available = reason === 'available';
        result.reason = reason;
        result.reasonText = result.partyDecision?.reason === reason
            ? result.partyDecision.reasonText : reasonText(reason);
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
