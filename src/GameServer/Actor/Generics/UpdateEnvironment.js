const ServerResponse = invoke('GameServer/Network/Response');
const World          = invoke('GameServer/World/World');
const SpeckMath      = invoke('GameServer/SpeckMath');
const BotAI          = invoke('GameServer/Bot/BotAI');
const TownGuard      = invoke('GameServer/Npc/TownGuard');

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

        World.fetchVisibleUsers(session, actor).forEach((user) => {
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

            user.dataSendToMe(ServerResponse.charInfo(actor));
            user.dataSendToMe(ServerResponse.relationChanged(actor));

            // Immediate bot AI wakeup when entering player's visibility range (within 6000 range)
            const dx = actor.fetchLocX() - user.actor.fetchLocX();
            const dy = actor.fetchLocY() - user.actor.fetchLocY();
            if (dx * dx + dy * dy <= 6000 * 6000) {
                if (user.constructor.name === 'BotSession') {
                    BotAI.wakeup(user);
                }
                if (session.constructor.name === 'BotSession') {
                    BotAI.wakeup(session);
                }
            }
        });

        actor.previousXY = actorArea.toCoords();
    }

    // Detect hostile NPCs
    const hostile = npcs.filter((ob) => ob.fetchHostile() && actorArea.distance(new SpeckMath.Point(ob.fetchLocX(), ob.fetchLocY())) <= 500) ?? [];
    hostile.forEach((npc) => {
        npc.setLocZ(actor.fetchLocZ()); // TODO: Remove, uber hack...
        npc.enterCombatState(session, actor);
    });

    // C4 guards are not ordinary hostile mobs: they seek only red names and
    // use line-of-sight before entering combat.
    TownGuard.engageNearby(session, actor, npcs);
}

module.exports = updateEnvironment;
