const SendPacket = invoke('Packet/Send');

const HITFLAG_USESS = 0x10;
const HITFLAG_CRIT  = 0x20;
const HITFLAG_SHLD  = 0x40;
const HITFLAG_MISS  = 0x80;

const SOULSHOT_GRADES = {
    none: 0,
    d: 1,
    c: 2,
    b: 3,
    a: 4,
    s: 5
};

function normalizeHit(params) {
    if (params && typeof params === 'object') {
        return {
            damage: Math.max(0, Math.round(Number(params.damage) || 0)),
            flags: Number(params.flags) || 0
        };
    }

    return {
        damage: 1,
        flags: Number(params) || 0
    };
}

function soulshotGrade(actor) {
    const weapon = actor?.backpack?.fetchEquippedWeapon ? actor.backpack.fetchEquippedWeapon() : null;
    const rank = String(weapon?.fetchRank ? weapon.fetchRank() : 'none').toLowerCase();
    return SOULSHOT_GRADES[rank] ?? SOULSHOT_GRADES.none;
}

function soulshotFlags(actor) {
    return HITFLAG_USESS | soulshotGrade(actor);
}

function attack(src, destId, params = {}) {
    const packet = new SendPacket(0x05);
    const hit = normalizeHit(params);

    packet
        .writeD(src.fetchId())
        .writeD(destId)
        .writeD(hit.damage)
        .writeC(hit.flags)
        .writeD(src.fetchLocX())
        .writeD(src.fetchLocY())
        .writeD(src.fetchLocZ())
        .writeH(0x00);

    return packet.fetchBuffer();
}

attack.HITFLAG_USESS = HITFLAG_USESS;
attack.HITFLAG_CRIT = HITFLAG_CRIT;
attack.HITFLAG_SHLD = HITFLAG_SHLD;
attack.HITFLAG_MISS = HITFLAG_MISS;
attack.soulshotFlags = soulshotFlags;

module.exports = attack;
