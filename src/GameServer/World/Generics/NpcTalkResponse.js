const ServerResponse = invoke('GameServer/Network/Response');

function npcTalkResponse(session, data) {
    let parts = data.link.split(' ') ?? [];
    console.log("npcTalkResponse link:", data.link, "parts:", parts);
    if (parts.length === 0 || !parts[0]) return;

    if (parts[0] === 'html') {
        const path = 'data/Html/';
        const filename = path + parts[1] + '.html';

        if (utils.fileExists(filename)) {
            session.dataSendToMe(
                ServerResponse.npcHtml(7146, utils.parseRawFile(filename))
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
