const World = invoke('GameServer/World/World');
const ArenaCombatRules = invoke('GameServer/World/ArenaCombatRules');

function canTargetEnemyNpc(npc, data = {}) {
    return npc?.fetchAttackable?.() === true || npc?.fetchIsSummon?.() === true || data.ctrl === true;
}

function cancelFailedSupportTarget(session, actor, data, skill) {
    const target = { fetchId: () => Number(data?.id || 0) };
    invoke('GameServer/Bot/AI/BotActionFeedback').record(session, actor, target, skill, 'rejected', 'missing_target');
    invoke('GameServer/Bot/AI/BotSupportPlanner').cancelPendingSupportCast(session, actor, target, skill, 'missing_target');
    invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, target, skill);
}

function canStartSkill(session, actor, data) {
    if (actor.isDead?.()) return false;
    const restrictions = invoke('GameServer/Effects/EffectRestrictions');
    if (!restrictions.canCast(actor)) {
        restrictions.reject(session);
        return false;
    }
    if (actor.isBlocked?.()) {
        invoke(path.actor).queueRequest(session, actor, 'skill', data);
        return false;
    }
    return true;
}

function skillExec(session, actor, data) {
    const skill = actor.skillset.fetchSkill(data.selfId);
    if (!skill || !canStartSkill(session, actor, data)) return;
    const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');

    function scheduleCast(target, callback, options) {
        // Target lookups and approaches outlive the request's initial action
        // check. A different request may have started casting or swinging.
        if (!canStartSkill(session, actor, data)) return;
        actor.automation.scheduleAction(session, actor, target, skill.fetchDistance(), () => {
            if (canStartSkill(session, actor, data)) callback();
        }, options);
    }

    if (skill.fetchTargetKind() === 'self') {
        actor.attack.remoteHit(session, actor, skill);
        return;
    }

    if (skill.fetchTargetKind() === 'pet') {
        const summon = invoke('GameServer/Npc/SummonControl').activeSummon(actor);
        if (!summon || Number(data.id) !== Number(summon.fetchId())) {
            cancelFailedSupportTarget(session, actor, data, skill);
            return;
        }
        scheduleCast(summon, () => {
            actor.attack.remoteHit(session, summon, skill);
        });
        return;
    }

    // TARGET_PARTY, TARGET_ALLY and TARGET_CORPSE_ALLY are caster-centred in
    // Lisvus. Attack.resolveSkillTargets expands them to the eligible party,
    // clan/alliance or dead-clan members inside the sourced radius.
    if (['party', 'ally', 'corpse_ally'].includes(skill.fetchTargetKind())) {
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
        scheduleCast(npc, () => {
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
        }, { allowDeadTarget: SpoilSweep.isSweepSkill(data.selfId)
            && String(session?.accountId || '').startsWith('bot_') });
    }).catch(() => {
        World.fetchUser(data.id).then((user) => {
            scheduleCast(user, () => {
                if (skill.fetchTargetKind() !== 'enemy') {
                    actor.attack.remoteHit(session, user, skill);
                }
                else if (data.ctrl || user.fetchPvpFlag?.() > 0 || user.fetchKarma?.() > 0) {
                    if (!ArenaCombatRules.canInteract(actor, user)) return;
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
