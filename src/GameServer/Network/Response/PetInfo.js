const SendPacket = invoke('Packet/Send');

function petInfo(summon, owner, val = 1) {
    const packet = new SendPacket(0xb1);
    const remaining = Number(summon.summonTimeRemaining);
    const total = Number(summon.summonTotalLifeTime);
    const currentFed = Number.isFinite(remaining) ? remaining : Number(summon.fetchCurrentFeed?.()) || 0;
    const maxFed = Number.isFinite(total) ? total : 0;
    const runSpeed = Number(summon.fetchCollectiveRunSpd?.()) || 0;
    const walkSpeed = Number(summon.fetchCollectiveWalkSpd?.()) || runSpeed;

    packet
        .writeD(1)
        .writeD(summon.fetchId())
        .writeD((Number(summon.fetchSelfId?.()) || 0) + 1000000)
        .writeD(0)
        .writeD(summon.fetchLocX())
        .writeD(summon.fetchLocY())
        .writeD(summon.fetchLocZ())
        .writeD(summon.fetchHead())
        .writeD(0)
        .writeD(summon.fetchCollectiveCastSpd())
        .writeD(summon.fetchCollectiveAtkSpd())
        .writeD(runSpeed)
        .writeD(walkSpeed)
        .writeD(runSpeed)
        .writeD(walkSpeed)
        .writeD(runSpeed)
        .writeD(walkSpeed)
        .writeD(runSpeed)
        .writeD(walkSpeed)
        .writeF(1)
        .writeF(1)
        .writeF(summon.fetchRadius())
        .writeF(summon.fetchSize())
        .writeD(0)
        .writeD(0)
        .writeD(0)
        .writeC(owner ? 1 : 0)
        .writeC(1)
        .writeC(summon.controlMode === 'attack' ? 1 : 0)
        .writeC(summon.isDead?.() ? 1 : 0)
        .writeC(val)
        .writeS(summon.fetchName())
        .writeS(summon.fetchTitle())
        .writeD(1)
        .writeD(owner?.fetchPvpFlag?.() || 0)
        .writeD(owner?.fetchKarma?.() || 0)
        .writeD(currentFed)
        .writeD(maxFed)
        .writeD(summon.fetchHp())
        .writeD(summon.fetchMaxHp())
        .writeD(summon.fetchMp())
        .writeD(summon.fetchMaxMp())
        .writeD(0)
        .writeD(summon.fetchLevel())
        .writeD(0)
        .writeD(0)
        .writeD(0)
        .writeD(0)
        .writeD(0)
        .writeD(summon.fetchCollectivePAtk())
        .writeD(summon.fetchCollectivePDef())
        .writeD(summon.fetchCollectiveMAtk())
        .writeD(summon.fetchCollectiveMDef())
        .writeD(summon.fetchCollectiveAccur())
        .writeD(summon.fetchCollectiveEvasion())
        .writeD(summon.fetchCollectiveCritical?.() ?? summon.fetchCritical?.() ?? 0)
        .writeD(runSpeed)
        .writeD(summon.fetchCollectiveAtkSpd())
        .writeD(summon.fetchCollectiveCastSpd())
        .writeD(0)
        .writeH(0)
        .writeC(0)
        .writeH(0)
        .writeC(0)
        .writeD(0)
        .writeD(0);

    return packet.fetchBuffer();
}

module.exports = petInfo;
