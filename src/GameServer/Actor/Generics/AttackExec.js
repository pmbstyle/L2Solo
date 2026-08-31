const World = invoke('GameServer/World/World');
const AttackRange = invoke('GameServer/Actor/AttackRange');
const ArenaCombatRules = invoke('GameServer/World/ArenaCombatRules');

function canAttackNpc(npc, data = {}) {
    return npc?.fetchAttackable?.() === true || npc?.fetchIsSummon?.() === true || data.ctrl === true;
}

function attackExec(session, actor, data) {
    const attackRange = AttackRange.fetchNormalAttackRange(actor, data);

    World.fetchNpc(data.id).then((npc) => {
        actor.automation.scheduleAction(session, actor, npc, attackRange, () => {
            if (canAttackNpc(npc, data)) {
                actor.attack.meleeHit(session, npc);
            }
            else {
                World.npcTalk(session, npc);
            }
        }, { collisionAware: true });
    }).catch(() => {
        World.fetchUser(data.id).then((user) => {
            actor.automation.scheduleAction(session, actor, user, attackRange, () => {
                if (data.ctrl) {
                    if (!ArenaCombatRules.canInteract(actor, user)) return;
                    if (utils.isInPeaceZone(actor.fetchLocX(), actor.fetchLocY()) || utils.isInPeaceZone(user.fetchLocX(), user.fetchLocY())) {
                        const ServerResponse = invoke('GameServer/Network/Response');
                        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "You cannot attack players in a peace zone." }));
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
            }, { collisionAware: true });
        }).catch((err) => {
            utils.infoWarn('GameServer', 'Attack -> ' + err);
        })
    });
}

module.exports = attackExec;
module.exports.canAttackNpc = canAttackNpc;
