'use strict';

// Owns every visible sit/stand of a player or a hot bot body: the posture flag,
// the ChangeWaitType broadcast and the 2.5 s lock while the client plays the
// sit-down or stand-up. Called by the player's sit/stand action (BasicAction),
// the bot states and services, and the store/toggle code. A body created
// already seated (spawn, projection) sets the flag directly: CharInfo carries it.
//
// C4 (Lisvus L2PcInstance.sitDown/standUp, SitDownTask/StandUpTask): the
// character cannot act for 2.5 s after it sits or stands; the action asked
// meanwhile is kept (one slot, the latest wins) and runs when the stand-up
// ends (StandUpTask runs the AI's next intention, L2PlayerAI saves a move
// asked during REST). A sit is refused while a stand-up still plays; a stand
// asked during a sit-down starts at once and its own 2.5 s count from then.
// Our choice: a skill pressed during the stand-up is kept and cast at its end
// too (Lisvus refuses it in useMagic).

const ServerResponse = invoke('GameServer/Network/Response');
const FailureLog = invoke('FailureLog');

const POSTURE_ANIMATION_MS = 2500;

function settle(session, actor) {
    try {
        actor.postureTimer = null;
        actor.state.setAnimated(false);
        if (session.actor !== actor || actor.state.fetchHits() || actor.state.fetchCasts()) return;
        if (actor.attack?.queue?.name) actor.attack.dequeueEvent(session);
    } catch (error) {
        FailureLog.note('actor.posture_settle', error);
    }
}

// Returns whether the posture changed.
function posture(session, actor, seated) {
    if (actor.state.fetchSeated() === seated) return false;
    if (seated && actor.state.fetchAnimated()) return false;

    actor.state.setSeated(seated);
    actor.state.setAnimated(true);
    session.dataSendToMeAndOthers(ServerResponse.sitAndStand(actor), actor);
    clearTimeout(actor.postureTimer);
    actor.postureTimer = setTimeout(() => settle(session, actor), POSTURE_ANIMATION_MS);
    return true;
}

module.exports = posture;
