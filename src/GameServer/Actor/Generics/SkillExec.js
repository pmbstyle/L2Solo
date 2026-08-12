const World = invoke('GameServer/World/World');

function canTargetEnemyNpc(npc, data = {}) {
    return npc?.fetchAttackable?.() === true || npc?.fetchIsSummon?.() === true || data.ctrl === true;
}

function cancelFailedSupportTarget(session, actor, data, skill) {
    const target = { fetchId: () => Number(data?.id || 0) };
    invoke('GameServer/Bot/AI/BotSupportPlanner').cancelPendingSupportCast(session, actor, target, skill, 'missing_target');
    invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, target, skill);
}

function skillExec(session, actor, data) {
    const skill = actor.skillset.fetchSkill(data.selfId);
    if (!skill) return;
    const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');

    if (skill.fetchTargetKind() === 'self') {
        actor.attack.remoteHit(session, actor, skill);
        return;
    }

    // C4 party auras use a negative distance to mean that the cast originates
    // from the caster and expands to party members in Attack.resolveSkillTargets.
    // Treating that value as a zero-radius movement target makes the caster try
    // to stand on the selected party member and lets normal follow movement
    // cancel the cast before it ever starts.
    if (skill.fetchTargetKind() === 'party' && Number(skill.fetchDistance()) < 0) {
        actor.attack.remoteHit(session, actor, skill);
        return;
    }

    // Hate Aura and similar C4 TARGET_AURA enemy skills are centred on the
    // caster as well. Attack.resolveSkillTargets will fan the native effect
    // out only to valid enemies inside the sourced radius.
    if (skill.fetchTargetKind() === 'enemy' && skill.fetchSemantic?.().sourceTarget === 'aura') {
        actor.attack.remoteHit(session, actor, skill);
        return;
    }

    World.fetchNpc(data.id).then((npc) => {
        actor.automation.scheduleAction(session, actor, npc, skill.fetchDistance(), () => {
            if (SpoilSweep.isSpoilSkill(data.selfId)) {
                SpoilSweep.castSpoil(session, actor, npc, skill);
                return;
            }

            if (SpoilSweep.isSpoilFestivalSkill(data.selfId)) {
                const radius = Math.max(0, Number(skill.fetchSemantic?.().radius) || 0);
                const nearby = radius > 0
                    ? actor.attack.fetchSkillTargetsInRadius(actor, npc.fetchLocX(), npc.fetchLocY(), radius)
                    : [];
                SpoilSweep.castSpoilTargets(session, actor, [npc, ...nearby], skill);
                return;
            }

            if (SpoilSweep.isSweepSkill(data.selfId)) {
                SpoilSweep.castSweep(session, actor, npc, skill);
                return;
            }

            if (skill.fetchTargetKind() === 'corpse_mob' && npc.fetchAttackable?.() && npc.isDead?.()) {
                actor.attack.remoteHit(session, npc, skill);
            }
            else if (skill.fetchTargetKind() === 'enemy' && canTargetEnemyNpc(npc, data)) {
                actor.attack.remoteHit(session, npc, skill);
            }
        });
    }).catch(() => {
        World.fetchUser(data.id).then((user) => {
            actor.automation.scheduleAction(session, actor, user, skill.fetchDistance(), () => {
                if (skill.fetchTargetKind() !== 'enemy') {
                    actor.attack.remoteHit(session, user, skill);
                }
                else if (data.ctrl) {
                    if (utils.isInPeaceZone(actor.fetchLocX(), actor.fetchLocY()) || utils.isInPeaceZone(user.fetchLocX(), user.fetchLocY())) {
                        const ServerResponse = invoke('GameServer/Network/Response');
                        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "You cannot attack players in a peace zone." }));
                        return;
                    }
                    actor.attack.remoteHit(session, user, skill);
                }
            });
        }).catch((err) => {
            cancelFailedSupportTarget(session, actor, data, skill);
            utils.infoWarn('GameServer', 'Skill -> ' + err);
        });
    });
}

module.exports = skillExec;
module.exports.canTargetEnemyNpc = canTargetEnemyNpc;
module.exports.cancelFailedSupportTarget = cancelFailedSupportTarget;
