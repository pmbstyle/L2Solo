const ServerResponse = invoke('GameServer/Network/Response');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const SummonControl = invoke('GameServer/Npc/SummonControl');

const StriderNpcIds = new Set([12526, 12527, 12528]);

function setMounted(actor, value, mountNpcId = 0) {
    if (typeof actor.setMounted === 'function') actor.setMounted(value);
    else actor.mounted = value;
    if (typeof actor.setMountNpcId === 'function') actor.setMountNpcId(mountNpcId);
    else actor.mountNpcId = mountNpcId;
}

function mountPet(session, actor) {
    const World = invoke('GameServer/World/World');
    const pet = actor.pet;
    if (!pet?.fetchIsPet?.() || !StriderNpcIds.has(Number(pet.fetchSelfId?.())) || pet.state?.fetchDead?.() === true) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    World.npc.spawns = World.npc.spawns.filter((spawn) => spawn.fetchId?.() !== pet.fetchId?.());
    World.indexSpawnsInGrid?.();
    setMounted(actor, true, pet.fetchSelfId());
    session.dataSendToMeAndOthers(ServerResponse.userInfo(actor), actor);
    session.dataSendToMeAndOthers(ServerResponse.charInfo(actor), actor);
}

function dismountPet(session, actor) {
    const World = invoke('GameServer/World/World');
    const pet = actor.pet;
    setMounted(actor, false, 0);
    if (pet && !pet.state?.fetchDead?.() && !World.npc.spawns.some((spawn) => spawn.fetchId?.() === pet.fetchId?.())) {
        pet.setLocXYZ?.({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
        World.npc.spawns.push(pet);
        World.indexSpawnsInGrid?.();
        session.dataSendToMeAndOthers(ServerResponse.npcInfo(pet), pet);
    }
    session.dataSendToMeAndOthers(ServerResponse.userInfo(actor), actor);
    session.dataSendToMeAndOthers(ServerResponse.charInfo(actor), actor);
}

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

    case 0x0f: // Pet follow/stop (legacy action ID)
    case 0x15: // Pet/servitor follow/stop
        {
            const summon = SummonControl.activeSummon(actor);
            summon ? SummonControl.toggleFollowOwner(session, actor, summon) : session.dataSendToMe(ServerResponse.actionFailed());
        }
        break;

    case 0x10: // Pet attack (legacy action ID)
    case 0x16: // Pet/servitor attack
        {
            const summon = SummonControl.activeSummon(actor);
            summon ? SummonControl.attack(session, actor, summon) : session.dataSendToMe(ServerResponse.actionFailed());
        }
        break;

    case 0x11: // Pet cancel action (legacy action ID)
    case 0x17: // Pet/servitor cancel action
        {
            const summon = SummonControl.activeSummon(actor);
            summon ? SummonControl.stop(session, summon) : session.dataSendToMe(ServerResponse.actionFailed());
        }
        break;

    case 0x13: // Pet unsummon to control item
        {
            const pet = actor.pet;
            const currentFeed = Number(pet?.fetchCurrentFeed?.()) || 0;
            const maxFeed = Number(pet?.fetchMaxFeed?.()) || 0;
            const hungry = maxFeed > 0 && currentFeed < maxFeed * 0.55;
            if (!pet || pet.fetchIsPet?.() !== true || pet.state?.fetchDead?.() === true || pet.isDead?.() === true || hungry) {
                session.dataSendToMe(ServerResponse.actionFailed());
            } else {
                SummonControl.unsummon(session, actor, pet);
            }
        }
        break;

    case 0x26: // Strider mount / dismount
        if (actor.fetchMounted?.() === true || actor.mounted === true) dismountPet(session, actor);
        else mountPet(session, actor);
        break;

    case 0x28: // Recommend without selection
        break;

    case 0x34: // Servitor unsummon
        {
            const summon = SummonControl.activeSummon(actor);
            summon ? SummonControl.unsummon(session, actor, summon) : session.dataSendToMe(ServerResponse.actionFailed());
        }
        break;

    case 0x35: // Servitor move to selected target
    case 0x36: // Hatchling/strider move to selected target
        {
            const summon = SummonControl.activeSummon(actor);
            summon ? SummonControl.moveToTarget(session, actor, summon) : session.dataSendToMe(ServerResponse.actionFailed());
        }
        break;

    default:
        {
            const summon = SummonControl.activeSummon(actor);
            if (summon && SummonControl.useSkillAction(session, actor, summon, data.actionId)) {
                break;
            }
        }
        utils.infoWarn('GameServer', 'unknown basic action 0x%s', utils.toHex(data.actionId));
        break;
    }
}

module.exports = basicAction;
