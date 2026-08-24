const ServerResponse = invoke('GameServer/Network/Response');

function npcTalkResponse(session, data) {
    let parts = data.link.split(' ') ?? [];
    console.log("npcTalkResponse link:", data.link, "parts:", parts);
    if (parts.length === 0 || !parts[0]) return;

    if (parts[0] === 'quest') {
        const QuestService = invoke('GameServer/Quest/QuestService');
        QuestService.onEvent(session, { questId: parts[1], name: parts[2] }).catch((error) => {
            utils.infoWarn('Quest', 'failed to process quest event: %s', error.message);
            session.dataSendToMe(ServerResponse.actionFailed());
        });
        return;
    }

    if (parts[0] === 'html') {
        const activeNpc = session.activeNpcTalk;
        const questPage = /^(\d+)-quest$/.exec(parts[1] || '');
        if (questPage && activeNpc && Number(questPage[1]) === Number(activeNpc.selfId)) {
            const QuestService = invoke('GameServer/Quest/QuestService');
            const npc = {
                fetchSelfId: () => activeNpc.selfId,
                fetchId: () => activeNpc.objectId
            };
            QuestService.onTalk(session, npc).then((handled) => {
                if (handled) return;
                session.dataSendToMe(ServerResponse.npcHtml(
                    activeNpc.objectId,
                    '<html><body>You are either not on a quest that involves this NPC, or you don\'t meet this NPC\'s minimum quest requirements.<br></body></html>'
                ));
                session.dataSendToMe(ServerResponse.actionFailed());
            }).catch((error) => {
                utils.infoWarn('Quest', 'failed to open NPC quest dialog: %s', error.message);
                session.dataSendToMe(ServerResponse.actionFailed());
            });
            return;
        }

        const path = 'data/Html/';
        const filename = path + parts[1] + '.html';

        if (utils.fileExists(filename)) {
            session.dataSendToMe(
                ServerResponse.npcHtml(session.activeNpcTalk?.objectId ?? 7146, utils.parseRawFile(filename))
            );
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }
        utils.infoWarn('GameServer', 'html file "%s" does not exist', filename);
        return;
    }

    // Convert spinal/snake case commands into PascalCase dynamic load routes
    const command = parts[0].replace(/[-_]([a-z])/g, (g) => g[1].toUpperCase());
    const handlerName = command.charAt(0).toUpperCase() + command.slice(1);

    try {
        const handler = invoke(`GameServer/World/Generics/NpcBypasses/${handlerName}`);
        handler(session, parts);
    } catch (err) {
        utils.infoWarn('GameServer', 'Unhandled bypass command: %s, error: %s', parts[0], err.message);
    }
}

npcTalkResponse.items = { nextId: 10000000 };

module.exports = npcTalkResponse;
