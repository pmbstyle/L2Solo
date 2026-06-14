const DataCache = invoke('GameServer/DataCache');
const SpeckMath = invoke('GameServer/SpeckMath');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');

const ADENA_ID = 57;
const REQUEST_RANGE = 1600;
const REQUEST_TTL_MS = 180000;
const REQUEST_COOLDOWN_MS = 120000;

function now() {
    return Date.now();
}

function isBotSession(session) {
    return session && (session.constructor.name === 'BotSession' || (session.accountId && String(session.accountId).startsWith('bot_')));
}

function actorName(session) {
    return session?.actor?.fetchName?.() || session?.accountId || 'unknown';
}

function actorDistance(a, b) {
    return new SpeckMath.Point3D(a.fetchLocX(), a.fetchLocY(), a.fetchLocZ())
        .distance(new SpeckMath.Point3D(b.fetchLocX(), b.fetchLocY(), b.fetchLocZ()));
}

function requestList(session) {
    if (!session.pendingLootRequests) {
        session.pendingLootRequests = [];
    }

    return session.pendingLootRequests;
}

function cleanup(session) {
    if (!session?.pendingLootRequests) return;
    const current = now();
    session.pendingLootRequests = session.pendingLootRequests.filter((request) => !request.fulfilled && request.expiresAt > current);
}

function removeRequest(playerSession, botSession, request) {
    if (playerSession?.pendingLootRequests) {
        playerSession.pendingLootRequests = playerSession.pendingLootRequests.filter((entry) => entry.id !== request.id);
    }

    if (botSession?.pendingLootRequests) {
        botSession.pendingLootRequests = botSession.pendingLootRequests.filter((entry) => entry.id !== request.id);
    }

    if (botSession?.lastLootRequest?.id === request.id) {
        botSession.lastLootRequest = null;
    }
}

function itemInfo(itemDetails, selfId) {
    const template = itemDetails.template || {};
    const kind = template.kind || '';

    return {
        selfId,
        name: template.name || `item ${selfId}`,
        kind,
        price: Number(template.price || 0),
        stackable: !!itemDetails.etc?.stackable,
        equipment: kind.startsWith('Weapon.') || kind.startsWith('Armor.'),
        consumable: !!itemDetails.etc?.consumable || kind.includes('Potion') || kind.includes('Shot')
    };
}

function isNotable(info, amount) {
    if (!info || info.selfId === ADENA_ID) return false;
    if (info.kind === 'Other.Arrow') return false;
    if (info.equipment) return true;
    if (info.price >= 75) return true;
    if (amount > 1 && info.price >= 10) return true;
    return false;
}

function candidateScore(botSession, info) {
    let score = 1;
    const classId = botSession.actor.fetchClassId();
    const healerClasses = [15, 16, 17, 29, 30, 42, 43];
    const archerClasses = [8, 9, 22, 23, 35, 36, 37];
    const mageClasses = [10, 11, 12, 13, 14, 25, 26, 27, 28, 38, 39, 40, 41, 49, 50, 51, 52];

    if (info.equipment) score += 4;
    if (info.consumable) score += 2;
    if (info.kind.includes('Shot') && (archerClasses.includes(classId) || mageClasses.includes(classId))) score += 2;
    if (info.kind.includes('Potion') && healerClasses.includes(classId)) score += 1;
    if (info.price >= 250) score += 2;

    return score;
}

function findCandidate(playerSession, npc, info) {
    const BotManager = invoke('GameServer/Bot/BotManager');
    const current = now();

    cleanup(playerSession);

    const existingRequests = requestList(playerSession);
    if (existingRequests.length >= 2) return null;

    return BotManager.sessions
        .filter((botSession) => (
            botSession.actor &&
            botSession.followPlayerSession === playerSession &&
            botSession.partyCompanion === true &&
            botSession.plan !== 'merchant' &&
            actorDistance(botSession.actor, npc) <= REQUEST_RANGE &&
            current - (botSession.lastLootRequestAt || 0) >= REQUEST_COOLDOWN_MS &&
            !existingRequests.some((request) => request.botId === botSession.actor.fetchId() && request.selfId === info.selfId)
        ))
        .map((botSession) => ({
            botSession,
            score: candidateScore(botSession, info)
        }))
        .sort((a, b) => b.score - a.score)[0]?.botSession || null;
}

function expireRequest(request) {
    setTimeout(() => {
        if (request.fulfilled) return;

        request.fulfilled = true;
        removeRequest(request.playerSession, request.botSession, request);
        BotSocialMemory.recordEvent(
            request.playerSession,
            request.botSession,
            'ignored_loot_request',
            `${request.amount} ${request.itemName}`
        );
        console.info("BotLoot :: %s ignored %s request from %s", actorName(request.playerSession), request.itemName, actorName(request.botSession));
    }, REQUEST_TTL_MS);
}

const BotLootEtiquette = {
    observeDrop(playerSession, npc, selfId, amount) {
        if (!playerSession?.actor || isBotSession(playerSession) || !npc || selfId === ADENA_ID) {
            return;
        }

        DataCache.fetchItemFromSelfId(selfId, (itemDetails) => {
            const info = itemInfo(itemDetails, selfId);
            if (!isNotable(info, amount)) return;

            const botSession = findCandidate(playerSession, npc, info);
            if (!botSession) return;

            const current = now();
            const request = {
                id: `${current}:${playerSession.actor.fetchId()}:${botSession.actor.fetchId()}:${selfId}`,
                playerSession,
                botSession,
                playerId: playerSession.actor.fetchId(),
                botId: botSession.actor.fetchId(),
                selfId,
                itemName: info.name,
                amount,
                requestedAt: current,
                expiresAt: current + REQUEST_TTL_MS,
                fulfilled: false
            };

            requestList(playerSession).push(request);
            requestList(botSession).push(request);
            botSession.lastLootRequest = {
                id: request.id,
                playerName: actorName(playerSession),
                itemName: request.itemName,
                amount,
                requestedAt: current,
                expiresAt: request.expiresAt
            };
            botSession.lastLootRequestAt = current;

            const BotManager = invoke('GameServer/Bot/BotManager');
            BotManager.botTell(botSession, playerSession, `If you don't need ${info.name}, could you trade it to me?`);
            console.info("BotLoot :: %s requested %d %s from %s", actorName(botSession), amount, info.name, actorName(playerSession));
            expireRequest(request);
        });
    },

    resolveTrade(playerSession, botSession, movedItems) {
        if (!playerSession?.pendingLootRequests || !botSession?.actor || !movedItems?.length) {
            return null;
        }

        cleanup(playerSession);
        cleanup(botSession);

        const request = playerSession.pendingLootRequests.find((entry) => (
            !entry.fulfilled &&
            entry.botId === botSession.actor.fetchId() &&
            movedItems.some((item) => item.selfId === entry.selfId && item.count > 0)
        ));

        if (!request) return null;

        request.fulfilled = true;
        removeRequest(playerSession, botSession, request);
        console.info("BotLoot :: %s fulfilled %s request from %s", actorName(playerSession), request.itemName, actorName(botSession));
        return request;
    }
};

module.exports = BotLootEtiquette;
