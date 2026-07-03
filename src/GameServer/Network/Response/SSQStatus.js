const SendPacket = invoke('Packet/Send');

const PERIOD_COMP_RECRUITING = 0;

const SYSTEM_MESSAGE_INITIAL_PERIOD = 1183;
const SYSTEM_MESSAGE_UNTIL_TODAY_6PM = 1287;

function ssqStatus(state = {}) {
    const period = Number(state.period ?? PERIOD_COMP_RECRUITING);
    const packet = new SendPacket(0xf5);

    packet
        .writeC(1)
        .writeC(period)
        .writeD(Number(state.cycle ?? 0))
        .writeD(Number(state.periodMessage ?? SYSTEM_MESSAGE_INITIAL_PERIOD))
        .writeD(Number(state.remainingMessage ?? SYSTEM_MESSAGE_UNTIL_TODAY_6PM))
        .writeC(Number(state.playerCabal ?? 0))
        .writeC(Number(state.playerSeal ?? 0))
        .writeD(Number(state.playerStoneContrib ?? 0))
        .writeD(Number(state.playerAdenaCollect ?? 0))
        .writeD(Number(state.duskStoneScore ?? 0))
        .writeD(Number(state.duskFestivalScore ?? 0))
        .writeD(Number(state.duskTotalScore ?? 0))
        .writeC(Number(state.duskPercent ?? 0))
        .writeD(Number(state.dawnStoneScore ?? 0))
        .writeD(Number(state.dawnFestivalScore ?? 0))
        .writeD(Number(state.dawnTotalScore ?? 0))
        .writeC(Number(state.dawnPercent ?? 0));

    return packet.fetchBuffer();
}

module.exports = ssqStatus;
