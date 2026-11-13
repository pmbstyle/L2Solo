const assert = require('node:assert/strict');
require('../src/Global');

const Actor = invoke('GameServer/Actor/Actor');
const DataCache = invoke('GameServer/DataCache');
const Skill = invoke('GameServer/Model/Skill');
const SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const Response = invoke('GameServer/Network/Response');
const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');

DataCache.init();

function createSession() {
    const session = {
        packets: [], observers: [],
        dataSendToMe(packet) { this.packets.push(packet); },
        dataSendToOthers(packet) { this.observers.push(packet); },
        dataSendToMeAndOthers(packet) { this.dataSendToMe(packet); this.dataSendToOthers(packet); }
    };
    session.actor = new Actor(session, {
        ...utils.crushOb(DataCache.classTemplates.find(row => row.classId === 1)),
        id: 2000001, name: 'SpeedTester', username: 'speed_test', classId: 1,
        level: 20, exp: DataCache.experience[19], sp: 0, hp: 80, mp: 30,
        sex: 0, locX: 0, locY: 0, locZ: 0, head: 0, face: 0, hair: 0,
        hairColor: 0, title: '', karma: 0, pk: 0, pvp: 0, isGM: 0,
        items: [], paperdoll: Array.from({ length: 16 }, () => ({}))
    });
    calculateStats(session, session.actor);
    return session;
}

function movementOffset(packet) {
    let nameEnd = 21;
    while (packet.readUInt16LE(nameEnd)) nameEnd += 2;
    return nameEnd + 2 + (packet[0] === 0x04 ? 63 : 20) * 4;
}

function movement(packet) {
    const offset = movementOffset(packet);
    return {
        speeds: Array.from({ length: 8 }, (_, i) => packet.readInt32LE(offset + i * 4)),
        multiplier: packet.readDoubleLE(offset + 32)
    };
}

function assertMovement(session, label) {
    const actor = session.actor;
    const ownPacket = session.packets.findLast(packet => packet[0] === 0x04);
    const publicPacket = session.observers.findLast(packet => packet[0] === 0x03);
    assert.ok(ownPacket, `${label}: refresh the owner's movement data`);
    assert.ok(publicPacket, `${label}: refresh nearby clients' movement data`);
    const own = movement(ownPacket);
    const publicInfo = movement(publicPacket);
    const walking = actor.state.fetchWalkin();
    const base = walking ? actor.fetchWalkSpd() : actor.fetchRunSpd();
    const speed = walking ? actor.fetchCollectiveWalkSpd() : actor.fetchCollectiveRunSpd();
    assert.ok(Math.abs(own.multiplier - speed / base) < 1e-10,
        `${label}: own client must receive movement multiplier ${speed / base}, received ${own.multiplier}`);
    assert.equal(own.speeds[0], actor.fetchRunSpd(), `${label}: UserInfo retains template run speed`);
    assert.equal(own.speeds[1], actor.fetchWalkSpd(), `${label}: UserInfo retains template walk speed`);
    assert.deepEqual(own, publicInfo, `${label}: own and nearby clients receive the same movement data`);
    assert.ok(Math.abs(own.speeds[walking ? 1 : 0] * own.multiplier - speed) < 1e-10,
        `${label}: the client reconstructs the authoritative movement speed`);
    return own;
}

function assertCombatSpeeds(session, label) {
    const actor = session.actor;
    for (const packet of [session.packets.findLast(packet => packet[0] === 0x04),
        session.observers.findLast(packet => packet[0] === 0x03)]) {
        assert.ok(packet, `${label}: refresh combat speed data`);
        const offset = movementOffset(packet);
        const own = packet[0] === 0x04;
        assert.equal(packet.readInt32LE(offset - (own ? 11 : 3) * 4), actor.fetchCollectiveAtkSpd(),
            `${label}: transmit the final attack speed`);
        assert.equal(packet.readInt32LE(offset - (own ? 5 : 4) * 4), actor.fetchCollectiveCastSpd(),
            `${label}: transmit the final cast speed`);
        assert.ok(Math.abs(packet.readDoubleLE(offset + 40) - 1.1 * actor.fetchCollectiveAtkSpd() / actor.fetchAtkSpd()) < 1e-10,
            `${label}: transmit the C4 attack animation multiplier`);
    }
}

function cast(session, id, level, name) {
    session.packets.length = session.observers.length = 0;
    const data = DataCache.skills.find(row => row.selfId === id);
    const levelData = data.levels.find(row => row.level === level);
    const skill = new Skill({ ...utils.crushOb(data), ...levelData });
    const result = SkillEffects.execute(session, session.actor, session.actor, skill, { rng: () => 0 });
    assert.ok(result.effect, `${name} must apply through the skill runtime`);
    return result.effect;
}

function toggleMovement(session, label) {
    session.packets.length = session.observers.length = 0;
    session.actor.basicAction({ actionId: 1 });
    for (const packets of [session.packets, session.observers]) {
        const mode = packets.find(packet => packet[0] === 0x2e);
        assert.ok(mode, `${label}: announce the movement mode`);
        assert.equal(mode.readInt32LE(5), session.actor.state.fetchWalkin() ? 0 : 1);
    }
    return assertMovement(session, label);
}

async function run() {
    const session = createSession();
    const actor = session.actor;
    const unbuffedSpeed = actor.fetchCollectiveRunSpd();
    const unbuffedWalk = actor.fetchCollectiveWalkSpd();
    const unbuffedAttack = actor.fetchCollectiveAtkSpd();
    const unbuffedCast = actor.fetchCollectiveCastSpd();
    try {
        cast(session, 1204, 1, 'Wind Walk');
        assert.equal(actor.fetchCollectiveRunSpd(), unbuffedSpeed + 20);
        const first = assertMovement(session, 'Wind Walk 1');

        const windWalk = cast(session, 1204, 2, 'Wind Walk');
        assert.equal(actor.fetchCollectiveRunSpd(), unbuffedSpeed + 33);
        assert.ok(assertMovement(session, 'Wind Walk 2').multiplier > first.multiplier);

        // Exercise the production expiry callback without waiting twenty minutes.
        windWalk.expiresAt = Date.now() + 5;
        session.packets.length = session.observers.length = 0;
        assert.equal(EffectTicker.scheduleExpiry(session, actor, windWalk), true);
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(EffectStore.list(actor).length, 0);
        assert.equal(actor.fetchCollectiveRunSpd(), unbuffedSpeed);
        assertMovement(session, 'Wind Walk expiry');

        const slow = cast(session, 1160, 1, 'Slow');
        assert.ok(actor.fetchCollectiveRunSpd() < unbuffedSpeed);
        assertMovement(session, 'Slow');
        EffectStore.remove(actor, slow.key);
        calculateStats(session, actor);
        EffectTicker.refreshEffects(session, actor);
        assert.equal(actor.fetchCollectiveRunSpd(), unbuffedSpeed);
        assertMovement(session, 'Slow removal');

        const walkingWindWalk = cast(session, 1204, 2, 'Wind Walk');
        toggleMovement(session, 'Wind Walk: run to walk');
        assert.equal(actor.fetchCollectiveWalkSpd(), unbuffedWalk + 33,
            'Wind Walk must increase walking speed as well as running speed (Lisvus RUN_SPEED)');
        toggleMovement(session, 'Wind Walk: walk to run');
        toggleMovement(session, 'Wind Walk: run to walk again');

        const walkingSlow = cast(session, 1160, 1, 'Slow while walking');
        assert.ok(actor.fetchCollectiveWalkSpd() < unbuffedWalk + 33, 'Slow must also reduce walking speed');
        assertMovement(session, 'Slow while walking');
        EffectStore.remove(actor, walkingSlow.key);
        calculateStats(session, actor);
        EffectTicker.refreshEffects(session, actor);
        assert.equal(actor.fetchCollectiveWalkSpd(), unbuffedWalk + 33);
        assertMovement(session, 'Walking Slow removal');

        walkingWindWalk.expiresAt = Date.now() + 5;
        session.packets.length = session.observers.length = 0;
        EffectTicker.scheduleExpiry(session, actor, walkingWindWalk);
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(actor.fetchCollectiveWalkSpd(), unbuffedWalk);
        assertMovement(session, 'Wind Walk expiry while walking');

        toggleMovement(session, 'Return to running');
        actor.model.collectiveRunSpd = 28;
        EffectTicker.refreshEffects(session, actor);
        assertMovement(session, 'Run speed penalty');

        actor.model.swim = 50;
        const ownSwim = movement(Response.userInfo(actor));
        assert.deepEqual(ownSwim, movement(Response.charInfo(actor)), 'swim fields use the same multiplier for both clients');

        const haste = cast(session, 1086, 2, 'Haste');
        assert.equal(actor.fetchCollectiveAtkSpd(), Math.round(unbuffedAttack * 1.33));
        assertCombatSpeeds(session, 'Haste 2');
        const acumen = cast(session, 1085, 3, 'Acumen');
        assert.ok(actor.fetchCollectiveCastSpd() > unbuffedCast);
        assertCombatSpeeds(session, 'Acumen 3');
        EffectStore.remove(actor, haste.key);
        EffectStore.remove(actor, acumen.key);
        calculateStats(session, actor);
        EffectTicker.refreshEffects(session, actor);
        assert.equal(actor.fetchCollectiveAtkSpd(), unbuffedAttack);
        assert.equal(actor.fetchCollectiveCastSpd(), unbuffedCast);
        assertCombatSpeeds(session, 'Haste and Acumen removal');
    } finally {
        EffectTicker.clearAll(actor);
    }
    console.log('Player movement and combat speed packet checks passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
