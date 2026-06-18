const World = invoke('GameServer/World/World');

function skillExec(session, actor, data) {
    const skill = actor.skillset.fetchSkill(data.selfId);
    if (!skill) return;
    const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');

    World.fetchNpc(data.id).then((npc) => {
        actor.automation.scheduleAction(session, actor, npc, skill.fetchDistance(), () => {
            if (SpoilSweep.isSpoilSkill(data.selfId)) {
                SpoilSweep.castSpoil(session, actor, npc, skill);
                return;
            }

            if (SpoilSweep.isSweepSkill(data.selfId)) {
                SpoilSweep.castSweep(session, actor, npc, skill);
                return;
            }

            if (npc.fetchAttackable() || data.ctrl) {
                actor.attack.remoteHit(session, npc, skill);
            }
        });
    }).catch(() => {
        World.fetchUser(data.id).then((user) => {
            actor.automation.scheduleAction(session, actor, user, skill.fetchDistance(), () => {
                if (data.ctrl) {
                    if (utils.isInPeaceZone(actor.fetchLocX(), actor.fetchLocY()) || utils.isInPeaceZone(user.fetchLocX(), user.fetchLocY())) {
                        const ServerResponse = invoke('GameServer/Network/Response');
                        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "You cannot attack players in a peace zone." }));
                        return;
                    }
                    actor.attack.remoteHit(session, user, skill);
                }
            });
        }).catch((err) => {
            utils.infoWarn('GameServer', 'Skill -> ' + err);
        });
    });
}

module.exports = skillExec;
