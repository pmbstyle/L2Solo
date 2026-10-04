const Service = invoke('GameServer/Items/CrystallizationStationService');
const Response = invoke('GameServer/Network/Response');
const Station = require('../../GiranCrystallizationStation');
module.exports = async function crystallizationStation(session, parts) {
    try {
        if (parts[1] === 'apply' && parts.length === 3) {
            const reward = await Service.crystallize(session, parts[2]);
            Service.menu(session, 0, `Received ${reward.net} ${reward.crystalName}. Service fee: ${reward.fee}.`);
        } else if (parts[1] === 'preview' && parts.length === 3) Service.preview(session, Number(parts[2]));
        else if (parts[1] === 'page' && parts.length === 3) Service.menu(session, Number(parts[2]));
        else if (parts.length === 1) Service.menu(session);
        else throw Error('Unknown crystallization service.');
    } catch (error) {
        const message = 'Crystallization unavailable. Speak to the nearby station outside combat, trade or enchanting. Unequip the item and select it again.';
        session.dataSendToMe(Response.actionFailed());
        try { Service.menu(session, 0, message); }
        catch (_) {
            const talk = session.activeNpcTalk;
            if (Number(talk?.selfId) === Station.npcId) {
                session.dataSendToMe(Response.npcHtml(talk.objectId, `<html><body>Crystallization Station:<br>${message}</body></html>`));
            }
        }
        utils.infoWarn('CrystallizationStation', 'request rejected: %s', error.message);
    }
};
