const ReceivePacket = invoke('Packet/Receive');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Response = invoke('GameServer/Network/Response');
const GardenOfEvaBarriers = require('../../Geodata/GardenOfEvaBarriers');

const FALL_HEIGHT = 333;
const FALL_THROUGH_TOLERANCE = 100;
const FALLING_VALIDATION_DELAY_MS = 10000;
const IMMOBILE_XY_TOLERANCE = 16;
const IMMOBILE_Z_TOLERANCE = 64;

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
        // A passive acknowledgement is not a new action. Repeated StopMove
        // and ActionFailed packets here interrupt rooted combat animations.
        const actor = session.actor;
        if (Math.hypot(data.locX - actor.fetchLocX(), data.locY - actor.fetchLocY()) > IMMOBILE_XY_TOLERANCE
            || Math.abs(data.locZ - actor.fetchLocZ()) > IMMOBILE_Z_TOLERANCE) {
            EffectRestrictions.stopMovement(session, actor);
        }
        return false;
    }
    if (isFalling(session.actor, data)) {
        // C4 (Lisvus ValidatePosition): a client that fell through its own map mesh is put back on the geodata floor.
        const floorZ = GeodataEngine.getHeight(data.locX, data.locY, data.locZ);
        if (floorZ - data.locZ > FALL_THROUGH_TOLERANCE) {
            session.dataSendToMe(Response.validateLocation(session.actor.fetchId(), { ...data, locZ: floorZ }));
        }
        return false;
    }
    const actor = session.actor;
    if (GardenOfEvaBarriers.blocks(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ(),
        data.locX, data.locY, data.locZ)) {
        actor.automation?.abortAll?.(actor);
        EffectRestrictions.stopMovement(session, actor);
        return false;
    }
    if (invoke('GameServer/Geodata/PlayerTransitionRecovery').observe(session, data)) return false;
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
    const baseDamage = height * maxHp / 1000;
    const damage = Math.floor(Math.max(0, baseDamage + EffectStats.add(actor, 'fallAdd')) * EffectStats.multiplier(actor, 'fallMul'));
    if (damage > 0 && currentHp > 1) {
        actor.setHp?.(Math.max(1, currentHp - Math.min(damage, currentHp - 1)));
        actor.statusUpdateVitals?.(actor);
        // C4 FALL_DAMAGE_S1 (296).
        actor.session?.dataSendToMe?.(Response.systemMessage.typed(296, { number: Math.min(damage, currentHp - 1) }));
    }
    actor.fallingUntil = now + FALLING_VALIDATION_DELAY_MS;
    return false;
}

module.exports = validatePosition;
module.exports.isFalling = isFalling;
