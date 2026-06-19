const ServerResponse = invoke('GameServer/Network/Response');

function npcTalk(session, npc) {
    const path = 'data/Html/';
    const filename = path + npc.fetchSelfId() + '.html';

    session.activeNpcShop = null;
    session.activeNpcTalk = {
        selfId: npc.fetchSelfId(),
        objectId: npc.fetchId(),
        name: npc.fetchName()
    };

    session.dataSendToMe(
        ServerResponse.npcHtml(npc.fetchId(), utils.parseRawFile(
            utils.fileExists(filename) ? filename : path + 'noquest.html'
        ))
    );
}

module.exports = npcTalk;
