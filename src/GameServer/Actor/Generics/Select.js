const ServerResponse = invoke('GameServer/Network/Response');
const World          = invoke('GameServer/World/World');

function select(session, actor, data) {
    const Generics = invoke(path.actor);

    if (actor.fetchId() === data.id) { // Click on self
        actor.setDestId(actor.fetchId());
        session.dataSendToMe(ServerResponse.destSelected(actor.fetchDestId()));
        return;
    }

    // Check BotManager sessions first (bots may not be in World.user.sessions)
    const BotManager = invoke('GameServer/Bot/BotManager');
    const botSession = BotManager.sessions.find(s => Number(s.actor?.fetchId()) === Number(data.id));

    if (botSession) {
        const user = botSession.actor;
        if (user.fetchId() !== actor.fetchDestId()) { // First click on bot
            actor.setDestId(user.fetchId());
            session.dataSendToMe(ServerResponse.destSelected(actor.fetchDestId()));
            return;
        }
        // Second click on bot
        if (user.fetchPrivateStoreType && user.fetchPrivateStoreType() !== 0) {
            session.viewedPrivateStoreSeller = user;
            if (user.fetchPrivateStoreType() === 1) {
                const isMerchantBot = botSession.plan === 'merchant';
                if (isMerchantBot) {
                    const BuyMerchantItem = invoke('GameServer/World/Generics/NpcBypasses/BuyMerchantItem');
                    BuyMerchantItem(session, ["buy-merchant-item"]);
                } else {
                    session.dataSendToMe(ServerResponse.privateStoreMsg(session.actor, user));
                    session.dataSendToMe(ServerResponse.privateStoreListSell(user, session.actor));
                }
            } else if (user.fetchPrivateStoreType() === 2) {
                const isMerchantBot = botSession.plan === 'merchant';
                if (isMerchantBot) {
                    const SellToMerchantItem = invoke('GameServer/World/Generics/NpcBypasses/SellToMerchantItem');
                    SellToMerchantItem(session, ["sell-to-merchant-item"]);
                } else {
                    session.dataSendToMe(ServerResponse.privateStoreListBuy(session.actor, user));
                }
            }
            return;
        }
        Generics.attackRequest(session, actor, data);
        return;
    }

    // Fallback to World lookups for non-bot entities
    World.fetchNpc(data.id).then((npc) => {
        if (npc.fetchId() !== actor.fetchDestId()) { // First click on a Creature
            actor.setDestId(npc.fetchId());
            npc.setLocZ(actor.fetchLocZ()); // TODO: Remove, uber hack...
            session.dataSendToMe(ServerResponse.destSelected(actor.fetchDestId(), actor.fetchLevel() - npc.fetchLevel()));
            actor.statusUpdateVitals(npc);
        }
        else { // Second click on same Creature
            Generics.attackRequest(session, actor, data);
        }
    }).catch(() => {
        World.fetchItem(data.id).then(() => {
            Generics.pickupRequest(session, actor, data);
        }).catch(() => {
            World.fetchUser(data.id).then((user) => {
                if (user.fetchId() !== actor.fetchDestId()) { // First click on a User
                    actor.setDestId(user.fetchId());
                    session.dataSendToMe(ServerResponse.destSelected(actor.fetchDestId()));
                }
                else { // Second click on same User
                    if (user.fetchPrivateStoreType && user.fetchPrivateStoreType() !== 0) {
                        session.viewedPrivateStoreSeller = user;
                        if (user.fetchPrivateStoreType() === 1) {
                            session.dataSendToMe(ServerResponse.privateStoreMsg(session.actor, user));
                            session.dataSendToMe(ServerResponse.privateStoreListSell(user, session.actor));
                        } else if (user.fetchPrivateStoreType() === 2) {
                            session.dataSendToMe(ServerResponse.privateStoreListBuy(session.actor, user));
                        }
                        return;
                    }
                    Generics.attackRequest(session, actor, data);
                }
            }).catch(() => {
                utils.infoWarn('GameServer', 'unknown World Id %d', data.id);
            });
        });
    });
}

module.exports = select;
