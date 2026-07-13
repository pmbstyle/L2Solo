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
} finally {
    GeodataEngine.hasGeo = originalHasGeo;
}

console.log('Fall damage checks passed');
