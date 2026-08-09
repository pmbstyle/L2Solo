const ServerResponse = invoke('GameServer/Network/Response');
const DungeonTeleports = invoke('GameServer/World/C4SevenSignsDungeonTeleports');

module.exports = function sevenSignsDungeonTeleport(session) {
    const actor = session?.actor;
    const destination = DungeonTeleports.destination(session?.activeNpcTalk?.selfId);
    if (!actor || !destination) {
        session?.dataSendToMe?.(ServerResponse.actionFailed());
        return;
    }

    invoke(path.actor).teleportTo(session, actor, destination);
};
