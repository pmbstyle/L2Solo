const ReceivePacket = invoke('Packet/Receive');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

const FALL_HEIGHT = 333;
const FALLING_VALIDATION_DELAY_MS = 10000;

function validatePosition(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD()  // X
        .readD()  // Y
        .readD()  // Z
        .readD()  // Head
        .readD(); // Vehicle Id

    return consume(session, {
        locX: packet.data[0],
        locY: packet.data[1],
        locZ: packet.data[2],
        head: packet.data[3],
    });
}

function consume(session, data) {
    if (!EffectRestrictions.canMove(session.actor)) {
        EffectRestrictions.stopMovement(session, session.actor);
        EffectRestrictions.reject(session);
        return false;
    }
    if (isFalling(session.actor, data)) return false;
    session.actor.updatePosition(data);
    return true;
}

function isFalling(actor, data, now = Date.now()) {
    if (!actor || actor.isDead?.() || actor.isFlying?.()) return false;
    if (Number(actor.fallingUntil) > now) return true;

    const previousZ = Number(actor.fetchLocZ?.()) || 0;
    const nextZ = Number(data?.locZ) || 0;
    const height = previousZ - nextZ;
    if (height <= FALL_HEIGHT || !GeodataEngine.hasGeo(actor.fetchLocX?.(), actor.fetchLocY?.())) return false;

    const maxHp = Number(actor.fetchMaxHp?.()) || 0;
    const currentHp = Number(actor.fetchHp?.()) || 0;
    const damage = Math.floor((height * maxHp / 1000) * EffectStats.multiplier(actor, 'fallMul'));
    if (damage > 0 && currentHp > 1) {
        actor.setHp?.(Math.max(1, currentHp - Math.min(damage, currentHp - 1)));
        actor.statusUpdateVitals?.(actor);
    }
    actor.fallingUntil = now + FALLING_VALIDATION_DELAY_MS;
    return false;
}

module.exports = validatePosition;
module.exports.isFalling = isFalling;
