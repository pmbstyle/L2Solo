const World = invoke('GameServer/World/World');

function attackExec(session, actor, data) {
    World.fetchNpc(data.id).then((npc) => {
        actor.automation.scheduleAction(session, actor, npc, 0, () => {
            if (npc.fetchAttackable() || data.ctrl) {
                actor.attack.meleeHit(session, npc);
            }
            else {
                World.npcTalk(session, npc);
            }
        });
    }).catch(() => {
        World.fetchUser(data.id).then((user) => {
            actor.automation.scheduleAction(session, actor, user, 0, () => {
                if (data.ctrl) {
                    if (utils.isInPeaceZone(actor.fetchLocX(), actor.fetchLocY()) || utils.isInPeaceZone(user.fetchLocX(), user.fetchLocY())) {
                        const ServerResponse = invoke('GameServer/Network/Response');
                        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Вы не можете атаковать игроков в мирной зоне." }));
                        return;
                    }
                    actor.attack.meleeHit(session, user);
                }
                else {
                    const BotManager = invoke('GameServer/Bot/BotManager');
                    const botSession = BotManager.sessions.find(s => s.actor && s.actor.fetchId() === user.fetchId());
                    if (botSession && botSession.plan === 'merchant') {
                        const BotMerchant = invoke('GameServer/Bot/BotMerchant');
                        BotMerchant.talk(session, user);
                    }
                }
            });
        }).catch((err) => {
            utils.infoWarn('GameServer', 'Attack -> ' + err);
        })
    });
}

module.exports = attackExec;
