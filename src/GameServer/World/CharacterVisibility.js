const Response = invoke('GameServer/Network/Response');

function knownActors(session) {
    const viewer = session.actor;
    const teleport = Number(viewer?.teleportSequence || 0);
    // The connection can survive a character switch, and teleporting unloads
    // the client's scene. A remembered object is not proof it still exists
    // in that new scene, even if the same bot body is still hot.
    if (session.characterVisibilityViewer !== viewer || session.characterVisibilityTeleport !== teleport) {
        session.knownCharacterActors?.clear();
        session.characterVisibilityViewer = viewer;
        session.characterVisibilityTeleport = teleport;
    }
    return session.knownCharacterActors ||= new Map();
}

// A movement packet cannot create a C4 character. Remember the actor instance,
// too: a hot/cold replacement may reuse its object ID with a new body.
function beforeSend(session, packet) {
    const actor = packet?.__movingActor;
    if (!actor || !session?.dataSendToMe || session.actor === actor) return;
    if (knownActors(session).get(actor.fetchId())?.deref() === actor) return;
    const info = Response.charInfo(actor);
    info.__skipMotionReplay = true;
    session.dataSendToMe(info);
}

function afterSend(session, packet) {
    if (packet?.[0] === 0x12 && packet.length >= 5) {
        session.knownCharacterActors?.delete(packet.readInt32LE(1));
        return;
    }
    const actor = packet?.__characterActor;
    if (packet?.[0] !== 0x03 || !actor) return;
    knownActors(session).set(actor.fetchId(), new WeakRef(actor));
    if (packet.__skipMotionReplay || session.actor === actor || !session.dataSendToMe
        || actor.state?.fetchDead?.() || !actor.state?.fetchTowards?.()) return;

    const owner = actor.session;
    const segment = owner?.activeMoveSegment;
    const nativeMove = actor.automation?.moveInterpolation;
    const to = owner?.actor === actor && owner.moveTimer && segment?.actor === actor
        && segment.goal === owner.activeMoveGoal ? segment.to
        : nativeMove?.actor === actor ? nativeMove.to : null;
    if (!to) return;
    // CharInfo replaces the client's movement state. Continue the existing
    // leg from the exact position just sent, only for this recipient. Never
    // restart pathfinding or broadcast the old origin to other observers.
    const from = { locX: packet.readInt32LE(1), locY: packet.readInt32LE(5), locZ: packet.readInt32LE(9) };
    if (nativeMove?.actor === actor && nativeMove.followTarget) {
        session.dataSendToMe(Response.moveToPawn(actor, nativeMove.followTarget, nativeMove.followRadius, from));
        return;
    }
    session.dataSendToMe(Response.moveToLocation(actor.fetchId(), {
        from,
        to
    }, actor));
}

module.exports = { beforeSend, afterSend };
