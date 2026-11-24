const assert = require('assert');

require('../src/Global');

const EffectStore = invoke('GameServer/Effects/EffectStore');
const SkillModel = invoke('GameServer/Model/Skill');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const validatePosition = invoke('GameServer/Network/Request/ValidatePosition');

function actor() {
    return {
        hp: 1000,
        maxHp: 1000,
        x: 100,
        y: 200,
        z: 1000,
        fetchHp() { return this.hp; },
        fetchMaxHp() { return this.maxHp; },
        fetchLocX() { return this.x; },
        fetchLocY() { return this.y; },
        fetchLocZ() { return this.z; },
        isDead: () => false,
        setHp(value) { this.hp = value; },
        statusUpdateVitals() {}
    };
}

const originalHasGeo = GeodataEngine.hasGeo;
GeodataEngine.hasGeo = () => true;
try {
    const unprotected = actor();
    assert.strictEqual(validatePosition.isFalling(unprotected, { locZ: 500 }, 1000), false, 'The first fall report should still accept the landing position');
    assert.strictEqual(unprotected.fetchHp(), 500, 'Fall damage must use C4 height × maxHP / 1000');
    assert.strictEqual(validatePosition.isFalling(unprotected, { locZ: 400 }, 1001), true, 'Falling validation delay must suppress repeated fall damage');
    assert.strictEqual(unprotected.fetchHp(), 500, 'Suppressed fall reports must not deal additional damage');

    const ironBody = actor();
    ironBody.skillset = { fetchSkills: () => [new SkillModel({ selfId: 295, name: 'Iron Body', level: 1, passive: true })] };
    validatePosition.isFalling(ironBody, { locZ: 500 }, 1000);
    assert.strictEqual(ironBody.fetchHp(), 700, 'Iron Body must reduce fall damage by its sourced 40%');

    const danceProtected = actor();
    EffectStore.apply(danceProtected, { key: 'dance_of_protection', id: 311, type: 'buff', stats: { fallMul: 0.7 }, durationMs: 60000 });
    validatePosition.isFalling(danceProtected, { locZ: 500 }, 1000);
    assert.strictEqual(danceProtected.fetchHp(), 650, 'Dance of Protection must reduce fall damage by its sourced 30%');

    // Fall-through: inside the window a report far under the geodata floor is answered with ValidateLocation.
    const originalGetHeight = GeodataEngine.getHeight;
    try {
        const sent = [];
        const e = actor();
        e.fetchId = () => 77;
        e.updatePosition = () => {};
        e.session = { dataSendToMe: (b) => sent.push(b) };
        const session = { actor: e, dataSendToMe: (b) => sent.push(b) };
        const report = (z) => {
            const packet = Buffer.alloc(21);
            [e.x, e.y, z, 0, 0].forEach((v, i) => packet.writeInt32LE(v, 1 + i * 4));
            return validatePosition(session, packet);
        };
        GeodataEngine.getHeight = () => 400;
        report(500);
        const fall = sent.filter((b) => b[0] === 0x64);
        assert.strictEqual(fall.length, 1, 'Fall damage must send one system message');
        assert.strictEqual(fall[0].readInt32LE(1), 296, 'Fall damage message must be 296');
        assert.strictEqual(fall[0].readInt32LE(9), 1, 'Fall damage argument must be a number');
        assert.strictEqual(fall[0].readInt32LE(13), 500, 'Fall damage message must carry the damage');
        sent.length = 0;
        e.z = 500;
        e.fallingUntil = Date.now() + 10000;
        assert.strictEqual(report(380), false);
        assert.strictEqual(sent.length, 0, 'A report 20 under the floor must get no correction');
        assert.strictEqual(report(-1000), false);
        const corr = sent.filter((b) => b[0] === 0x61);
        assert.strictEqual(corr.length, 1, 'A report more than 100 under the floor must get one ValidateLocation');
        assert.strictEqual(corr[0].readInt32LE(13), 400, 'ValidateLocation must carry the geodata floor z');
    } finally {
        GeodataEngine.getHeight = originalGetHeight;
    }
} finally {
    GeodataEngine.hasGeo = originalHasGeo;
}

console.log('Fall damage checks passed');
