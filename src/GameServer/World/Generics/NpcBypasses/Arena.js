const ArenaDuelService = invoke('GameServer/World/ArenaDuelService');

module.exports = function arenaBypass(session, parts) {
    return ArenaDuelService.handleBypass(session, parts);
};
