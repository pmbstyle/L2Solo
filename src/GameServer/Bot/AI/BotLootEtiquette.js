const DataCache = invoke('GameServer/DataCache');
const SpeckMath = invoke('GameServer/SpeckMath');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

const ADENA_ID = 57;
const REQUEST_RANGE = 1600;
const REQUEST_TTL_MS = 180000;
const REQUEST_COOLDOWN_MS = 120000;
const PLAYER_REQUEST_COOLDOWN_MS = 90000;
const IGNORE_PENALTY_RANGE = REQUEST_RANGE * 1.5;
const MAX_PENDING_REQUESTS = 1;
const MIN_DEMAND_SCORE = 3;

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
    const name = template.name || `item ${selfId}`;

    return {
        selfId,
        name,
        kind,
        price: Number(template.price || 0),
        rank: itemDetails.etc?.rank || 'none',
        stackable: !!itemDetails.etc?.stackable,
        weapon: kind.startsWith('Weapon.'),
        armor: kind.startsWith('Armor.'),
        material: kind === 'Other.Material',
        recipe: kind === 'Other.Recipe',
        shot: kind === 'Other.Shot',
        potion: kind === 'Other.Potion',
        scroll: kind === 'Other.Scroll',
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

function addDemand(result, score, reason) {
    result.score += score;
    if (reason && !result.reasons.includes(reason)) {
        result.reasons.push(reason);
    }
}

function itemDemand(botSession, info) {
    const result = { score: 0, reasons: [] };
    const classId = botSession.actor.fetchClassId();
    const role = BotRoles.inferRole(classId);
    const name = info.name.toLowerCase();
    const weaponType = info.kind.replace('Weapon.', '');
    const armorType = info.kind.replace('Armor.', '');

    if (info.weapon) {
        if (role === 'archer' && weaponType === 'Bow') addDemand(result, 6, 'archer weapon');
        else if ((role === 'mage' || role === 'healer' || role === 'buffer') && /staff|wand|rod|spellbook|voodoo|scroll/.test(name)) addDemand(result, 6, 'caster weapon');
        else if (role === 'tank' && ['Sword', 'Blunt', 'Pole'].includes(weaponType)) addDemand(result, 4, 'frontline weapon');
        else if (role === 'dps' && ['Knife', 'Sword', 'GreatSword', 'Pole', 'Blunt'].includes(weaponType)) addDemand(result, 4, 'damage weapon');
    }

    if (info.armor) {
        if (role === 'tank' && ['Shield', 'Chain'].includes(armorType)) addDemand(result, 6, 'tank gear');
        else if ((role === 'mage' || role === 'healer' || role === 'buffer') && ['Fabric', 'Wear', 'Jewel'].includes(armorType)) addDemand(result, 4, 'caster gear');
        else if ((role === 'archer' || role === 'dps') && ['Leather', 'Wear', 'Jewel'].includes(armorType)) addDemand(result, 4, 'combat gear');
    }

    if (info.shot) {
        if (name.includes('spiritshot') && (role === 'mage' || role === 'healer' || role === 'buffer')) addDemand(result, 5, 'caster shots');
        else if (name.includes('soulshot') && ['archer', 'tank', 'dps', 'dwarf', 'spoiler', 'crafter'].includes(role)) addDemand(result, 4, 'weapon shots');
    }

    if (info.potion && (role === 'healer' || role === 'buffer' || role === 'tank')) {
        addDemand(result, 3, 'survival supplies');
    }

    if ((info.material || info.recipe) && BotRoles.valuesMaterial(role)) {
        addDemand(result, info.recipe ? 6 : 5, info.recipe ? 'craft recipe' : 'craft material');
    }

    if (info.scroll && name.includes('enchant')) {
        addDemand(result, 3, 'enchant scroll');
    }

    if (info.price >= 250000) addDemand(result, 3, 'valuable drop');
    else if (info.price >= 10000) addDemand(result, 1, 'valuable drop');

    return {
        ...result,
        reason: result.reasons[0] || 'useful item'
    };
}

function findCandidate(playerSession, npc, info) {
    const BotManager = invoke('GameServer/Bot/BotManager');
    const current = now();

    cleanup(playerSession);

    const existingRequests = requestList(playerSession);
    if (existingRequests.length >= MAX_PENDING_REQUESTS) return null;
    if (current - (playerSession.lastLootRequestAt || 0) < PLAYER_REQUEST_COOLDOWN_MS) return null;

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
            demand: itemDemand(botSession, info)
        }))
        .filter((entry) => entry.demand.score >= MIN_DEMAND_SCORE)
        .sort((a, b) => b.demand.score - a.demand.score)[0] || null;
}

function shouldRecordIgnoredRequest(request) {
    if (!request.playerSession?.actor || !request.botSession?.actor) return false;
    if (request.botSession.followPlayerSession !== request.playerSession) return false;
    if (request.botSession.partyCompanion !== true) return false;

    return actorDistance(request.playerSession.actor, request.botSession.actor) <= IGNORE_PENALTY_RANGE;
}

function expireRequest(request) {
    setTimeout(() => {
        if (request.fulfilled) return;

        request.fulfilled = true;
        removeRequest(request.playerSession, request.botSession, request);
        if (shouldRecordIgnoredRequest(request)) {
            BotSocialMemory.recordEvent(
                request.playerSession,
                request.botSession,
                'ignored_loot_request',
                `${request.amount} ${request.itemName}`
            );
            console.info("BotLoot :: %s ignored %s request from %s", actorName(request.playerSession), request.itemName, actorName(request.botSession));
        } else {
            console.info("BotLoot :: %s request for %s expired without social penalty", actorName(request.botSession), request.itemName);
        }
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

            const candidate = findCandidate(playerSession, npc, info);
            if (!candidate) return;

            const current = now();
            const { botSession, demand } = candidate;
            const request = {
                id: `${current}:${playerSession.actor.fetchId()}:${botSession.actor.fetchId()}:${selfId}`,
                playerSession,
                botSession,
                playerId: playerSession.actor.fetchId(),
                botId: botSession.actor.fetchId(),
                selfId,
                itemName: info.name,
                amount,
                reason: demand.reason,
                demandScore: demand.score,
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
                reason: request.reason,
                requestedAt: current,
                expiresAt: request.expiresAt
            };
            botSession.lastLootRequestAt = current;
            playerSession.lastLootRequestAt = current;

            const BotManager = invoke('GameServer/Bot/BotManager');
            BotManager.botTell(botSession, playerSession, `If you don't need ${info.name}, could you trade it to me? I can use it for ${request.reason}.`);
            console.info("BotLoot :: %s requested %d %s from %s (%s, score %d)", actorName(botSession), amount, info.name, actorName(playerSession), request.reason, demand.score);
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
