const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');
const Formulas = invoke('GameServer/Formulas');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');

const SummonSkillActions = new Map([
    [0x27, { skillId: 4138, target: 'selected' }], // Soulless - Parasite Burst
    [0x2a, { skillId: 4378, target: 'self' }],     // Kai the Cat - Self Damage Shield
    [0x2b, { skillId: 4137, target: 'selected' }], // Unicorn Merrow - Hydro Screw
    [0x2d, { skillId: 4025, target: 'owner' }],    // Unicorn Boxer - Master Recharge
    [0x2e, { skillId: 4261, target: 'selected' }], // Mew the Cat - Mega Storm Strike
    [0x2f, { skillId: 4260, target: 'selected' }], // Silhouette - Steal Blood
    [1007, { skillId: 4699, target: 'owner' }],
    [1008, { skillId: 4700, target: 'owner' }],
    [1009, { skillId: 4701, target: 'owner' }],
    [1010, { skillId: 4702, target: 'owner' }],
    [1011, { skillId: 4703, target: 'owner' }],
    [1012, { skillId: 4704, target: 'owner' }],
    [1013, { skillId: 4705, target: 'selected' }],
    [1014, { skillId: 4706, target: 'selected' }],
    [1015, { skillId: 4707, target: 'owner' }],
    [1016, { skillId: 4709, target: 'selected' }],
    [1017, { skillId: 4708, target: 'selected' }]
]);

const FollowDistance = 80;
const FollowTickMs = 500;
const InteractionDistance = 150;

function activeSummon(actor) {
    const summon = actor.summon || actor.pet || null;
    if (!summon || summon.state?.fetchDead?.() === true || summon.isDead?.() === true) return null;
    return summon;
}

function distance2d(src, dst) {
    const dx = (Number(src?.fetchLocX?.()) || 0) - (Number(dst?.fetchLocX?.()) || 0);
    const dy = (Number(src?.fetchLocY?.()) || 0) - (Number(dst?.fetchLocY?.()) || 0);
    return Math.sqrt(dx * dx + dy * dy);
}

function ensureTimerBag(summon) {
    if (!summon.timer) summon.timer = {};
}

function clearFollowTimer(summon) {
    if (!summon) return;
    clearInterval(summon.timer?.followOwner);
    if (summon.timer) summon.timer.followOwner = undefined;
}

function clearResumeTimer(summon) {
    if (!summon) return;
    clearTimeout(summon.timer?.summonResume);
    if (summon.timer) summon.timer.summonResume = undefined;
}

function clearLifetimeTimer(summon) {
    if (!summon) return;
    clearInterval(summon.timer?.summonLifetime);
    if (summon.timer) summon.timer.summonLifetime = undefined;
}

function sendStopMove(session, summon) {
    session?.dataSendToMeAndOthers?.(ServerResponse.stopMove(summon.fetchId(), {
        locX: summon.fetchLocX(),
        locY: summon.fetchLocY(),
        locZ: summon.fetchLocZ(),
        head: summon.fetchHead()
    }), summon);
}

function stop(session, summon) {
    summon.controlMode = 'idle';
    summon.followOwner = false;
    clearFollowTimer(summon);
    clearResumeTimer(summon);
    summon.attack?.clearTimers?.();
    summon.automation.abortAll(summon);
    summon.state.setHits(false);
    summon.state.setCasts(false);
    sendStopMove(session, summon);
}

function startLifetime(session, actor, summon, skill) {
    const total = Number(skill.fetchSummonTotalLifeTime?.()) || 0;
    if (total <= 0) return;

    ensureTimerBag(summon);
    clearLifetimeTimer(summon);
    summon.summonTimeRemaining = total;
    summon.summonTotalLifeTime = total;
    summon.summonTimeLostIdle = Number(skill.fetchSummonTimeLostIdle?.()) || 1000;
    summon.summonTimeLostActive = Number(skill.fetchSummonTimeLostActive?.()) || summon.summonTimeLostIdle;
    summon.summonItemConsumeId = Number(skill.fetchOngoingItemConsumeId?.()) || 0;
    summon.summonItemConsumeCount = Number(skill.fetchOngoingItemConsumeCount?.()) || 0;
    summon.summonItemConsumeSteps = Number(skill.fetchOngoingItemConsumeSteps?.()) || 0;
    summon.summonNextItemConsumeTime = summon.summonItemConsumeId && summon.summonItemConsumeSteps > 0
        ? total - total / (summon.summonItemConsumeSteps + 1)
        : -1;

    summon.timer.summonLifetime = setInterval(() => tickLifetime(session, actor, summon), 1000);
    summon.timer.summonLifetime.unref?.();
}

function tickLifetime(session, actor, summon) {
    if (!summon || (actor.summon !== summon && actor.pet !== summon)) {
        clearLifetimeTimer(summon);
        return;
    }

    const oldRemaining = Number(summon.summonTimeRemaining) || 0;
    const active = summon.controlMode === 'attack' || summon.state?.fetchHits?.() === true;
    const loss = active ? summon.summonTimeLostActive : summon.summonTimeLostIdle;
    summon.summonTimeRemaining = oldRemaining - Math.max(0, Number(loss) || 0);

    if (summon.summonTimeRemaining < 0) {
        unsummon(session, actor, summon);
        return;
    }

    if (
        summon.summonNextItemConsumeTime >= 0 &&
        summon.summonTimeRemaining <= summon.summonNextItemConsumeTime &&
        oldRemaining > summon.summonNextItemConsumeTime
    ) {
        const step = (Number(summon.summonTotalLifeTime) || oldRemaining) / (summon.summonItemConsumeSteps + 1);
        summon.summonNextItemConsumeTime -= step;
        const item = actor.backpack?.fetchItemFromSelfId?.(summon.summonItemConsumeId);
        if (!item || Number(item.fetchAmount?.()) < summon.summonItemConsumeCount) {
            unsummon(session, actor, summon);
            return;
        }
        actor.backpack.deleteItem(session, item.fetchId(), summon.summonItemConsumeCount, () => {});
    }
}

function scheduleFollowStep(session, actor, summon) {
    if (summon.controlMode !== 'follow' || summon.followOwner !== true) return;
    if (actor.state?.fetchDead?.() === true || actor.isDead?.() === true) {
        stop(session, summon);
        return;
    }
    if (summon.state.fetchCasts?.() || summon.state.fetchHits?.() || summon.state.inMotion?.()) return;
    if (distance2d(summon, actor) <= FollowDistance + Math.max(0, Number(actor.fetchRadius?.()) || 0)) return;

    summon.automation.scheduleAction(session, summon, actor, FollowDistance, () => {
        if (summon.controlMode !== 'follow' || summon.followOwner !== true) return;
        summon.setLocXYZ(summon.automation.actionStopCoords(summon, actor, FollowDistance));
        summon.state.setHits(false);
    });
}

function startFollowOwner(session, actor, summon) {
    ensureTimerBag(summon);
    clearFollowTimer(summon);
    clearResumeTimer(summon);
    summon.attack?.clearTimers?.();
    summon.controlMode = 'follow';
    summon.followOwner = true;

    const tick = () => scheduleFollowStep(session, actor, summon);
    tick();
    summon.timer.followOwner = setInterval(tick, FollowTickMs);
    summon.timer.followOwner.unref?.();
}

function toggleFollowOwner(session, actor, summon) {
    if (summon.followOwner === true && summon.controlMode === 'follow') {
        stop(session, summon);
        return;
    }

    startFollowOwner(session, actor, summon);
}

function selectedTarget(actor) {
    const targetId = actor.fetchDestId?.();
    if (targetId === undefined || targetId === null) return Promise.resolve(null);
    return World.fetchNpc(targetId).catch(() => World.fetchUser(targetId).catch(() => null));
}

function moveToTarget(session, actor, summon) {
    selectedTarget(actor).then((target) => {
        if (!target || target === summon) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        clearFollowTimer(summon);
        clearResumeTimer(summon);
        summon.controlMode = 'move';
        summon.followOwner = false;
        summon.attack?.clearTimers?.();
        summon.automation.scheduleAction(session, summon, target, 0, () => {
            summon.setLocXYZ(summon.automation.actionStopCoords(summon, target, 0));
        });
    });
}

function attack(session, actor, summon) {
    selectedTarget(actor).then((target) => {
        if (!target || target === summon) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        if (target.fetchAttackable?.() !== true) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        clearFollowTimer(summon);
        clearResumeTimer(summon);
        summon.controlMode = 'attack';
        summon.followOwner = false;
        summon.attack?.clearTimers?.();

        const attackRange = Math.max(
            0,
            Number(summon.fetchAtkRadius?.()) || 0,
            Number(target.fetchRadius?.()) || 0
        );

        summon.automation.scheduleAction(session, summon, target, attackRange, () => {
            summon.setLocXYZ(summon.automation.actionStopCoords(summon, target, attackRange));
            attackTick(session, summon, target);
        });
    });
}

function attackTick(session, summon, target) {
    if (summon.controlMode !== 'attack' || summon.isDead?.() || target.isDead?.()) {
        stop(session, summon);
        return;
    }

    const Attack = invoke('GameServer/Actor/Attack');
    const attackHelper = new Attack();
    const speed = Formulas.calcMeleeAtkTime(summon.fetchCollectiveAtkSpd());
    const hitLanded = Formulas.calcHitChance(summon, target, Math.random, attackHelper.positionContext(summon, target));
    const hit = attackHelper.prepareNpcMeleeHit(summon, target, hitLanded);

    session.dataSendToMeAndOthers(ServerResponse.attack(summon, target.fetchId(), hit), summon);
    summon.state.setHits(true);

    summon.attack.queueTimer(() => {
        if (summon.controlMode !== 'attack' || summon.isDead?.() || target.isDead?.()) return;
        if (hitLanded) {
            invoke(path.npc).receivedHit(session, summon, target, hit.damage);
        }
    }, speed * 0.644);

    summon.attack.queueTimer(() => {
        summon.state.setHits(false);
        if (summon.controlMode !== 'attack' || summon.isDead?.() || target.isDead?.()) return;
        attackTick(session, summon, target);
    }, speed);
}

function unsummon(session, actor, summon) {
    stop(session, summon);
    clearLifetimeTimer(summon);
    World.npc.spawns = World.npc.spawns.filter((spawn) => spawn.fetchId() !== summon.fetchId());
    World.indexSpawnsInGrid?.();
    if (actor.summon === summon) actor.summon = null;
    if (actor.pet === summon) actor.pet = null;
    if (session.summon === summon) session.summon = null;
    session.dataSendToMeAndOthers(ServerResponse.deleteOb(summon.fetchId()), summon);
}

function showStatusWindow(session, actor, summon) {
    session.dataSendToMe(ServerResponse.moveToPawn(actor, summon, InteractionDistance));
    session.dataSendToMe(ServerResponse.petStatusShow(1));
    session.dataSendToMe(ServerResponse.actionFailed());
}

function findSummonSkill(summon, skillId) {
    return NpcSkills.forNpc(summon).find((skill) => Number(skill.fetchSelfId()) === Number(skillId)) || null;
}

function isValidEnemyTarget(target) {
    return target?.fetchAttackable?.() === true && target?.state?.fetchDead?.() !== true && target?.isDead?.() !== true;
}

function resolveSkillTarget(actor, summon, config) {
    if (config.target === 'owner') return Promise.resolve(actor);
    if (config.target === 'self') return Promise.resolve(summon);
    return selectedTarget(actor).then((target) => (isValidEnemyTarget(target) ? target : null));
}

function useSkillAction(session, actor, summon, actionId) {
    const config = SummonSkillActions.get(Number(actionId));
    if (!config) return false;

    const skill = findSummonSkill(summon, config.skillId);
    if (!skill) {
        session.dataSendToMe(ServerResponse.actionFailed());
        utils.infoWarn(
            'SummonControl',
            'summon %s/%d has no npc skill %d for action %d',
            summon.fetchName?.() || 'unknown',
            summon.fetchSelfId?.() || 0,
            config.skillId,
            actionId
        );
        return true;
    }

    resolveSkillTarget(actor, summon, config).then((target) => {
        if (!target) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        const resumeFollow = summon.followOwner === true && summon.controlMode === 'follow';
        clearFollowTimer(summon);
        clearResumeTimer(summon);
        summon.attack?.clearTimers?.();
        summon.automation.abortAll(summon);
        summon.controlMode = 'cast';

        summon.attack.remoteHit({
            actor: summon,
            dataSendToMe: (packet) => session.dataSendToMe(packet),
            dataSendToMeAndOthers: (packet) => session.dataSendToMeAndOthers(packet, summon)
        }, target, skill);

        if (resumeFollow) {
            ensureTimerBag(summon);
            summon.timer.summonResume = setTimeout(() => {
                summon.timer.summonResume = undefined;
                if (summon.state?.fetchDead?.() === true || summon.isDead?.() === true) return;
                startFollowOwner(session, actor, summon);
            }, Math.max(100, Number(skill.fetchCalculatedHitTime?.()) || 0) + 50);
            summon.timer.summonResume.unref?.();
        }
    });

    return true;
}

module.exports = {
    activeSummon,
    attack,
    moveToTarget,
    showStatusWindow,
    startFollowOwner,
    startLifetime,
    stop,
    tickLifetime,
    toggleFollowOwner,
    unsummon,
    useSkillAction
};
