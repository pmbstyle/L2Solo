const Service = invoke('GameServer/SecondProfession');
const QuestService = invoke('GameServer/Quest/QuestService');
const Response = invoke('GameServer/Network/Response');

module.exports = function secondProfession(session, parts) {
    return QuestService.mutate(session, async () => {
        if (!Service.nearbyNpc(session)) return session.dataSendToMe(Response.actionFailed());
        if (!parts[1]) return Service.render(session);
        const target = Number(parts[1]);
        if (!Number.isInteger(target)) return;
        const result = await Service.transfer(session, target);
        const route = Service.routes.find(route => route.classId === target);
        if (result.ok) {
            const message = `Congratulations! You are now a ${route.name}.`
                + (result.refreshPending ? '<br>Speak with this master again to refresh your skills.' : '');
            session.dataSendToMe(Response.npcHtml(session.activeNpcTalk.objectId,
                `<html><body>${message}</body></html>`));
            session.dataSendToMe(Response.actionFailed());
        } else Service.render(session, result.reason === 'level' ? 'You must reach level 40.'
            : result.reason === 'marks' ? 'The transfer could not be completed. Check that you carry all three marks.'
                : 'This profession is not available here.');
        return result;
    }).catch(error => {
        utils.infoWarn('Quest', 'second profession transfer failed: %s', error.message);
        session.dataSendToMe(Response.actionFailed());
    });
};
