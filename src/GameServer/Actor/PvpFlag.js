function mark(session, actor) {
    const Response = invoke('GameServer/Network/Response');
    actor.setPvpFlag(1);
    session.dataSendToMe(Response.userInfo(actor));
    session.dataSendToOthers(Response.charInfo(actor), actor);
    session.dataSendToOthers(Response.relationChanged(actor), actor);
    if (session.pvpFlagTimer) clearTimeout(session.pvpFlagTimer);
    session.pvpFlagTimer = setTimeout(() => {
        actor.setPvpFlag(0);
        session.dataSendToMe(Response.userInfo(actor));
        session.dataSendToOthers(Response.charInfo(actor), actor);
        session.dataSendToOthers(Response.relationChanged(actor), actor);
        session.pvpFlagTimer = undefined;
    }, 15000);
}

module.exports = { mark };
