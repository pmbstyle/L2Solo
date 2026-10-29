const World = invoke('GameServer/World/World');
const AttackRange = invoke('GameServer/Actor/AttackRange');
const ArenaCombatRules = invoke('GameServer/World/ArenaCombatRules');

function canAttackNpc(npc, data = {}) {
    return npc?.fetchAttackable?.() === true || npc?.fetchIsSummon?.() === true || data.ctrl === true;
}

function attackExec(session, actor, data) {
    const attackRange = AttackRange.fetchNormalAttackRange(actor, data);
    const moveGeneration = Number(actor.moveRequestGeneration || 0);

    function canStartAttack() {
        if (session.actor !== actor || Number(actor.moveRequestGeneration || 0) !== moveGeneration) return false;
        if (actor.isDead?.()) return false;
        const restrictions = invoke('GameServer/Effects/EffectRestrictions');
        if (!restrictions.canAttack(actor)) {
            restrictions.reject(session);
            return false;
        }
        if (actor.isBlocked?.()) {
            invoke(path.actor).queueRequest(session, actor, 'attack', data);
            return false;
        }
        return true;
    }

    function scheduleAttack(target, callback) {
        // A cast or swing may start while target lookup or travel is pending.
        // Queue the original request, including its PvP permission flags.
        if (!canStartAttack()) return;
        actor.automation.scheduleAction(session, actor, target, attackRange, () => {
            if (canStartAttack()) callback();
        }, { collisionAware: true, action: 'attack' });
    }

    World.fetchNpc(data.id).then((npc) => {
        scheduleAttack(npc, () => {
            if (canAttackNpc(npc, data)) {
                actor.attack.meleeHit(session, npc);
            }
            else {
                World.npcTalk(session, npc);
            }
        });
    }).catch(() => {
        World.fetchUser(data.id).then((user) => {
            scheduleAttack(user, () => {
                if (data.ctrl || user.fetchPvpFlag?.() > 0 || user.fetchKarma?.() > 0) {
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
            });
        }).catch((err) => {
            utils.infoWarn('GameServer', 'Attack -> ' + err);
        })
    });
}

module.exports = attackExec;
module.exports.canAttackNpc = canAttackNpc;
