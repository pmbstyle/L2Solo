const ServerResponse = invoke('GameServer/Network/Response');
const World          = invoke('GameServer/World/World');
const SpeckMath      = invoke('GameServer/SpeckMath');
const TownGuard      = invoke('GameServer/Npc/TownGuard');
const NpcAggro       = invoke('GameServer/Npc/NpcAggro');

function isBotSession(session) {
    return !!session && (
        session.botSession === true ||
        session.constructor?.name === 'BotSession' ||
        String(session.accountId || '').startsWith('bot_')
    );
}

function updateEnvironment(session, actor, { immediateNpcInfo = false, forceRefresh = false } = {}) {
    const actorArea = new SpeckMath.Circle(actor.fetchLocX(), actor.fetchLocY(), 6000);
    const npcs = World.fetchNpcsInRadius(actor.fetchLocX(), actor.fetchLocY(), 6000).filter((ob) => ob.state.fetchDead() === false) ?? [];

    if (forceRefresh || new SpeckMath.Point(actor.previousXY?.locX ?? 0, actor.previousXY?.locY ?? 0).distance(new SpeckMath.Point(actor.fetchLocX(), actor.fetchLocY())) >= 1000) {
        npcs.forEach((npc) => {
            const sendNpcInfo = () => session.dataSendToMe(ServerResponse.npcInfo(npc));
            if (immediateNpcInfo) {
                sendNpcInfo();
            } else {
                // Gives a sense of random NPC Animation to the actor.
                setTimeout(sendNpcInfo, utils.randomNumber(2000));
            }
        });

        const sourceIsBot = isBotSession(session);
        // Bot observers do not consume visibility packets and do not need an
        // event-driven AI wakeup just because another actor crossed their
        // radius. Their regular LOD tick, plus the explicit player
        // interaction paths (select, damage, chat), is sufficient. Avoiding
        // the bot-to-bot fan-out is important when hundreds of hot actors
        // share one field: a single movement must not enqueue a wakeup for
        // the whole local population.
        const visibleUsers = sourceIsBot && typeof World.fetchVisibleRealPlayers === 'function'
            ? World.fetchVisibleRealPlayers(session, actor)
            : World.fetchVisibleUsers(session, actor);
        visibleUsers.forEach((user) => {
            const userIsBot = isBotSession(user);

            // BotSession.dataSendToMe() intentionally discards packets. Do not
            // build the expensive CharInfo/relation/store payloads for a bot
            // observer, and do not build the source snapshot for a bot source.
            // Real clients still receive the complete visibility refresh.
            if (!sourceIsBot) {
                session.dataSendToMe(ServerResponse.charInfo(user.actor));
                session.dataSendToMe(ServerResponse.relationChanged(user.actor));

                const visibleStoreType = user.actor.fetchPrivateStoreType && user.actor.fetchPrivateStoreType();
                const storeTitle = user.actor.fetchPrivateStore?.()?.title || user.actor.fetchTitle();
                if (visibleStoreType === 1) {
                    session.dataSendToMe(ServerResponse.privateStoreMsg(user.actor, storeTitle));
                } else if (visibleStoreType === 3) {
                    session.dataSendToMe(ServerResponse.privateStoreBuyMsg(user.actor, storeTitle));
                } else if (visibleStoreType === 5) {
                    session.dataSendToMe(ServerResponse.recipeShopMsg(user.actor));
                }
            }

            if (!userIsBot) {
                user.dataSendToMe(ServerResponse.charInfo(actor));
                user.dataSendToMe(ServerResponse.relationChanged(actor));
            }

        });

        actor.previousXY = actorArea.toCoords();
    }

    // Detect hostile NPCs.  This same gate is used by hot-bot movement and
    // respawn processing, so the actor type cannot change auto-aggro rules.
    NpcAggro.engageNearby(session, actor, { npcs });

    // C4 guards are not ordinary hostile mobs: they seek only red names and
    // use line-of-sight before entering combat.
    TownGuard.engageNearby(session, actor, npcs);
}

module.exports = updateEnvironment;
module.exports.isBotSession = isBotSession;
