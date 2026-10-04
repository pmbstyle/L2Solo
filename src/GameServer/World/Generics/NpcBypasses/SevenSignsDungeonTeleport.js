const ServerResponse = invoke('GameServer/Network/Response');
const DungeonTeleports = invoke('GameServer/World/C4SevenSignsDungeonTeleports');
const refuseKarmaTeleport = invoke('GameServer/World/Generics/TeleporterKarmaRefusal');

module.exports = function sevenSignsDungeonTeleport(session) {
    const actor = session?.actor;
    const destination = DungeonTeleports.destination(session?.activeNpcTalk?.selfId);
    if (!actor || !destination) {
        session?.dataSendToMe?.(ServerResponse.actionFailed());
        return;
    }
    if (refuseKarmaTeleport(session, actor)) return;

    invoke(path.actor).teleportTo(session, actor, destination);
};
