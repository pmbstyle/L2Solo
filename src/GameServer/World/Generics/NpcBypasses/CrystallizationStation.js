const Service = invoke('GameServer/Items/CrystallizationStationService');
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
        session.dataSendToMe(invoke('GameServer/Network/Response').actionFailed());
        try { Service.menu(session, 0, 'Crystallization unavailable. Unequip the item and select it again.'); } catch (_) {}
        utils.infoWarn('CrystallizationStation', 'request rejected: %s', error.message);
    }
};
