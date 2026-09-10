function mark(session, actor, durationMs = 15000, until = Date.now() + durationMs) {
    const Response = invoke('GameServer/Network/Response');
    actor.setPvpFlag(1);
    session.dataSendToMe(Response.userInfo(actor));
    session.dataSendToOthers(Response.charInfo(actor), actor);
    session.dataSendToOthers(Response.relationChanged(actor), actor);
    if (session.pvpFlagTimer) clearTimeout(session.pvpFlagTimer);
    session.pvpFlagUntil = until;
    session.pvpFlagTimer = setTimeout(() => {
        actor.setPvpFlag(0);
        session.dataSendToMe(Response.userInfo(actor));
        session.dataSendToOthers(Response.charInfo(actor), actor);
        session.dataSendToOthers(Response.relationChanged(actor), actor);
        session.pvpFlagTimer = undefined;
        session.pvpFlagUntil = 0;
    }, durationMs);
}

function restore(session, actor, until) {
    const remaining = Number(until) - Date.now();
    if (remaining > 0) mark(session, actor, remaining, until);
}
module.exports = { mark, restore };
