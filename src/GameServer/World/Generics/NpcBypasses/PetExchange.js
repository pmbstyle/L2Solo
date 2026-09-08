const Exchange = invoke('GameServer/Pets/PetExchange');
const Response = invoke('GameServer/Network/Response');
module.exports = async function petExchange(session, parts) {
    try {
        if (parts[1] === 'exchange') {
            await Exchange.exchange(session, parts[2], Number(parts[3]));
            Exchange.menu(session, 'Your ticket has been exchanged.');
        } else if (parts.length === 1) Exchange.menu(session);
        else session.dataSendToMe(Response.actionFailed());
    } catch (error) {
        utils.infoWarn('Pet', 'ticket exchange rejected: %s', error.message);
        session.dataSendToMe?.(Response.actionFailed());
        // Only render an error while the same nearby manager is still valid.
        try { Exchange.menu(session, 'Exchange unavailable. Check your ticket and speak to the Pet Manager again.'); } catch (_) {}
    }
};
