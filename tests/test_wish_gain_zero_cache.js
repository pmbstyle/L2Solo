'use strict';
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const { isMainThread, Worker, parentPort } = require('node:worker_threads');
const root = path.resolve(__dirname, '..');
require(root + '/tests/helpers/databaseIsolation');
const isolated = require(root + '/tests/helpers/isolatedSocialDatabase')('zero-gain-cache');
require(root + '/src/Global');
isolated.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache');
Data.init();
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');

const native = id => {
    const state = {
        characterId: id, level: 41, stats: { classId: 14 },
        inventory: { 1: { selfId: 1, amount: 1, equipped: true, equippedCount: 1, slot: 7 } }
    };
    state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(14, 41), 0);
    return state;
};

function verify() {
    const state = native(911001), entry = Profile.buildGainsFor(state, 0);
    let calls = 0;
    const gain = (key, value) => Profile.gainFor(entry, key, () => {
        calls++;
        return value;
    });
    for (let i = 0; i < 80; i++) {
        for (let j = 0; j < 3; j++) {
            assert.deepEqual(gain('zero:' + i, { attack: 0, defence: 0 }), { attack: 0, defence: 0 });
        }
    }
    assert.equal(calls, 80);
    assert.equal(entry.size, 80);
    const exact = { attack: .12345678912345678, defence: Math.PI };
    for (let i = 0; i < 126; i++) {
        for (let j = 0; j < 3; j++) assert.deepEqual(gain('nonzero:' + i, exact), exact);
    }
    for (const [key, value] of [
        ['negative-zero', { attack: -0, defence: 0 }],
        ['other-negative-zero', { attack: 0, defence: -0 }]
    ]) {
        for (let j = 0; j < 3; j++) {
            const result = gain(key, value);
            assert(Object.is(result.attack, value.attack));
            assert(Object.is(result.defence, value.defence));
        }
    }
    assert.equal(calls, 208, 'zero candidates do not evict the128 cached native nonzero gains');
    assert.equal(entry.gainSize, 128);
    assert.equal(entry.size, 208);
    for (let i = 0; i < 13; i++) {
        for (let j = 0; j < 2; j++) assert.deepEqual(gain('uncached:' + i, exact), exact);
    }
    assert.equal(entry.size, 208);
    assert.equal(calls, 234, 'over-cap computations still return the exact result');
    for (let i = 80; i < 128; i++) {
        for (let j = 0; j < 2; j++) gain('zero:' + i, { attack: 0, defence: 0 });
    }
    assert.equal(entry.size, 256);
    assert.equal(entry.ids.length, 256);
    assert.equal(entry.slots.length, 256);
    assert.equal(entry.gains.length, 256);
    assert.strictEqual(entry.ids.buffer, entry.slots.buffer);
    assert.strictEqual(entry.ids.buffer, entry.gains.buffer);
    assert.equal(require('node:v8').serialize(entry).byteLength < 4096, true);
    const second = { ...state, characterId: 911002 };
    assert.strictEqual(Profile.buildGainsFor(second, 0), entry);
    Profile.forgetBuild(911001);
    assert.strictEqual(Profile.buildGainsFor(second, 0), entry);
    Profile.forgetBuild(911002);
    assert.equal(Profile.size().ownerBuilds, 0);
    assert.equal(Profile.size().buildGains, 0);

    // Native night-reading skill294 keeps two variants and one shared marker.
    const GameTime = invoke('GameServer/World/GameTime');
    const midnight = GameTime.localMidnight(1791332800000), night = midnight + 1000, day = midnight + 7200000;
    assert(GameTime.isNight(night));
    assert(!GameTime.isNight(day));
    const nocturnal = native(911005);
    nocturnal.stats.coldCombat.skills = Profile.skillSnapshotsFromRecords([{ selfId: 294, level: 1 }]);
    nocturnal.stats.coldCombat.skillSource = 'database';
    const daytime = Profile.buildGainsFor(nocturnal, day), other = { ...nocturnal, characterId: 911006 };
    const nighttime = Profile.buildGainsFor(other, night);
    assert.equal(daytime.night, 1);
    assert.notEqual(daytime, nighttime);
    assert.equal(Profile.size().buildGains, 3);
    assert.strictEqual(Profile.buildGainsFor(nocturnal, night), nighttime);
    assert.equal(Profile.size().buildGains, 2);
    Profile.forgetBuild(911005);
    Profile.forgetBuild(911006);
    assert.equal(Profile.size().buildGains, 0);

    // Actual kernel ownership removal releases this cache in either thread.
    const Kernel = require(root + '/src/GameServer/Bot/Population/ColdSimulationKernel');
    const kernel = new Kernel.ColdSimulationKernel({
        now: () => 0,
        resolveSolo: () => { throw Error('removal must not resolve combat'); }
    });
    const retained = native(911007);
    kernel.states.set(retained.characterId, { state: retained, context: {} });
    const owned = Profile.buildGainsFor(retained, 0);
    for (let i = 0; i < 200; i++) Profile.gainFor(owned, 'kernel-zero:' + i, () => ({ attack: 0, defence: 0 }));
    assert.equal(owned.size, 200);
    assert.equal(owned.gainSize, 0);
    kernel.remove(retained.characterId);
    assert.equal(Profile.size().ownerBuilds, 0);
    assert.equal(Profile.size().buildGains, 0);

    // The candidate index admits id65535 exactly; unknown ids remain computed.
    const initialIndexSize = Profile.size().candidateIndex;
    const capped = Profile.buildGainsFor(native(911003), 0);
    for (let i = 0; i < 66000; i++) Profile.gainFor(capped, 'global:' + i, () => exact);
    assert.equal(Profile.size().candidateIndex, 65536);
    assert.deepEqual(Profile.gainFor(capped, 'past-limit', () => exact), exact);
    Profile.forgetBuild(911003);
    assert.equal(Profile.size().ownerBuilds, 0);
    assert.equal(Profile.size().buildGains, 0);
    const boundary = Profile.buildGainsFor(native(911004), 0);
    let boundaryCalls = 0;
    for (let i = 0; i < 2; i++) {
        assert.deepEqual(Profile.gainFor(boundary, 'global:' + (65535 - initialIndexSize), () => {
            boundaryCalls++;
            return exact;
        }), exact);
    }
    assert.equal(boundary.ids[0], 65535);
    assert.equal(boundaryCalls, 1, 'the last admitted ID is cached without Uint16 wrap');
    Profile.forgetBuild(911004);
    assert.equal(Profile.size().ownerBuilds, 0);
    assert.equal(Profile.size().buildGains, 0);
    assert.equal(invoke('Database').isReady(), false);
    fs.rmSync(isolated.directory, { recursive: true, force: true });
    console.log('zero-gain exact/signed-zero/ID-limit/caps/shared-owner/night/kernel-release: PASS', isMainThread ? 'main' : 'worker');
}

(async () => {
    verify();
    if (isMainThread) {
        const worker = new Worker(__filename);
        await new Promise((resolve, reject) => {
            worker.once('error', reject);
            worker.once('exit', code => code === 0 ? resolve() : reject(Error('worker exit ' + code)));
        });
    } else parentPort.close();
})().catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
});
