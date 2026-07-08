const ServerResponse = invoke('GameServer/Network/Response');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const World = invoke('GameServer/World/World');
const Formulas = invoke('GameServer/Formulas');
const Attack = invoke('GameServer/Actor/Attack');

const SummonAttack = new Attack();

function sitAndStand(session, actor, data) {
    if (actor.state.fetchHits() || actor.state.fetchCasts() || actor.state.fetchAnimated() || actor.state.inMotion()) {
        invoke(path.actor).queueRequest(session, actor, 'sit', data);
        return;
    }

    actor.state.setAnimated(true);
    actor.state.setSeated(!actor.state.fetchSeated());
    session.dataSendToMeAndOthers(ServerResponse.sitAndStand(actor), actor);

    setTimeout(() => {
        actor.state.setAnimated(false);
    }, 2500);
}

function walkAndRun(session, actor) {
    actor.state.setWalkin(!actor.state.fetchWalkin());
    session.dataSendToMeAndOthers(ServerResponse.walkAndRun(actor.fetchId(), actor.state.fetchWalkin() ? 0 : 1), actor);
}

function activeSummon(actor) {
    const summon = actor.summon || actor.pet || null;
    if (!summon || summon.state?.fetchDead?.() === true || summon.isDead?.() === true) return null;
    return summon;
}

function selectedTarget(actor) {
    const targetId = actor.fetchDestId?.();
    if (targetId === undefined || targetId === null) return Promise.resolve(null);
    return World.fetchNpc(targetId).catch(() => World.fetchUser(targetId).catch(() => null));
}

function stopSummon(session, summon) {
    summon.controlMode = 'idle';
    summon.followOwner = false;
    summon.attack?.clearTimers?.();
    summon.automation.abortAll(summon);
    summon.state.setHits(false);
    summon.state.setCasts(false);
    session.dataSendToMeAndOthers(ServerResponse.stopMove(summon.fetchId(), {
        locX: summon.fetchLocX(),
        locY: summon.fetchLocY(),
        locZ: summon.fetchLocZ(),
        head: summon.fetchHead()
    }), summon);
}

function followSummonOwner(session, actor, summon) {
    summon.controlMode = 'follow';
    summon.followOwner = !summon.followOwner;
    summon.attack?.clearTimers?.();

    if (!summon.followOwner) {
        stopSummon(session, summon);
        return;
    }

    summon.automation.scheduleAction(session, summon, actor, 80, () => {
        summon.state.setHits(false);
    });
}

function summonMoveToTarget(session, actor, summon) {
    selectedTarget(actor).then((target) => {
        if (!target || target === summon) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        summon.controlMode = 'move';
        summon.followOwner = false;
        summon.attack?.clearTimers?.();
        summon.automation.scheduleAction(session, summon, target, 0, () => {});
    });
}

function summonAttack(session, actor, summon) {
    selectedTarget(actor).then((target) => {
        if (!target || target === summon) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        if (target.fetchAttackable?.() !== true) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        summon.controlMode = 'attack';
        summon.followOwner = false;
        summon.attack?.clearTimers?.();

        const attackRange = Math.max(
            0,
            Number(summon.fetchAtkRadius?.()) || 0,
            Number(target.fetchRadius?.()) || 0
        );

        summon.automation.scheduleAction(session, summon, target, attackRange, () => {
            summonAttackTick(session, summon, target);
        });
    });
}

function summonAttackTick(session, summon, target) {
    if (summon.controlMode !== 'attack' || summon.isDead?.() || target.isDead?.()) {
        stopSummon(session, summon);
        return;
    }

    const speed = Formulas.calcMeleeAtkTime(summon.fetchCollectiveAtkSpd());
    const hitLanded = Formulas.calcHitChance(summon, target, Math.random, SummonAttack.positionContext(summon, target));
    const hit = SummonAttack.prepareNpcMeleeHit(summon, target, hitLanded);

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
        summonAttackTick(session, summon, target);
    }, speed);
}

function unsummon(session, actor, summon) {
    stopSummon(session, summon);
    World.npc.spawns = World.npc.spawns.filter((spawn) => spawn.fetchId() !== summon.fetchId());
    World.indexSpawnsInGrid?.();
    if (actor.summon === summon) actor.summon = null;
    if (actor.pet === summon) actor.pet = null;
    if (session.summon === summon) session.summon = null;
    session.dataSendToMeAndOthers(ServerResponse.deleteOb(summon.fetchId()), summon);
}

function basicAction(session, actor, data) {
    if (actor.isDead()) {
        return;
    }

    if (!EffectRestrictions.canUseBasicAction(actor)) {
        EffectRestrictions.reject(session);
        return;
    }

    switch (data.actionId) {
    case 0x00: // Sit / Stand
        sitAndStand(session, actor, data);
        break;

    case 0x01: // Walk / Run
        walkAndRun(session, actor);
        break;

    case 0x15: // Pet/servitor follow/stop
        {
            const summon = activeSummon(actor);
            summon ? followSummonOwner(session, actor, summon) : session.dataSendToMe(ServerResponse.actionFailed());
        }
        break;

    case 0x16: // Pet/servitor attack
        {
            const summon = activeSummon(actor);
            summon ? summonAttack(session, actor, summon) : session.dataSendToMe(ServerResponse.actionFailed());
        }
        break;

    case 0x17: // Pet/servitor cancel action
        {
            const summon = activeSummon(actor);
            summon ? stopSummon(session, summon) : session.dataSendToMe(ServerResponse.actionFailed());
        }
        break;

    case 0x28: // Recommend without selection
        break;

    case 0x34: // Servitor unsummon
        {
            const summon = activeSummon(actor);
            summon ? unsummon(session, actor, summon) : session.dataSendToMe(ServerResponse.actionFailed());
        }
        break;

    case 0x35: // Servitor move to selected target
        {
            const summon = activeSummon(actor);
            summon ? summonMoveToTarget(session, actor, summon) : session.dataSendToMe(ServerResponse.actionFailed());
        }
        break;

    default:
        utils.infoWarn('GameServer', 'unknown basic action 0x%s', utils.toHex(data.actionId));
        break;
    }
}

module.exports = basicAction;
