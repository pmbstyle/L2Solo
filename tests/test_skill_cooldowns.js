const assert = require('assert');
const fs = require('fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('l2-skill-reuse');
require('../src/Global');
fixture.assertConfigured(options.default);
const Actor = invoke('GameServer/Actor/Actor');
const Skill = invoke('GameServer/Model/Skill');
const Reuse = invoke('GameServer/Skills/SkillReuse');
const Status = invoke('GameServer/Actor/CharacterStatus');
const Response = invoke('GameServer/Network/Response');
const Mastery = invoke('GameServer/Skills/SkillMastery');
const Effects = invoke('GameServer/Effects/EffectStore');
const Database = invoke('Database');
const raw = require('../data/Skills/Active/active.json').find(s => s.selfId === 127);
const skill = new Skill({ selfId: 127, ...raw.template, ...raw.time, ...raw.levels[13] });
skill.setCalculatedHitTime(1500);
const now = Date.now();
const actor = {
    effects: {}, skillReuseUntil: new Map(),
    fetchCollectiveCastSpd: () => 666, fetchCollectiveAtkSpd: () => 666,
    fetchId: () => 2000001, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
    fetchHp: () => 50, fetchMp: () => 25, fetchCp: () => 0
};
const mark = () => Actor.prototype.markSkillReuse.call(actor, skill, now);
mark();
assert.equal(actor.skillReuseUntil.get(127), now + 3500);
assert.equal(Response.skillStarted(actor, 1, skill).readInt32LE(21), 3500);
Effects.apply(actor, { key: 'test_reuse', id: 9999, type: 'buff', durationMs: 60000, stats: { mReuseMul: 0.5 } });
mark();
assert.equal(Response.skillStarted(actor, 1, skill).readInt32LE(21), 1750);
Effects.remove(actor, 'test_reuse');
const originalMastery = Mastery.succeeds;
try {
    Mastery.succeeds = () => true;
    mark();
    assert.equal(actor.skillReuseUntil.get(127), now + 100);
    assert.equal(Response.skillStarted(actor, 1, skill).readInt32LE(21), 100);
} finally { Mastery.succeeds = originalMastery; }
mark();
const restored = {};
Reuse.restore(restored, JSON.stringify(Reuse.entries(actor, now)), now + 1000);
assert.equal(restored.skillReuseUntil.get(127), now + 3500);
assert(!Actor.prototype.canUseSkill.call(restored, skill, now + 3499));
assert(Actor.prototype.canUseSkill.call(restored, skill, now + 3500));
const packet = Response.skillCoolTime(restored, now + 1000);
assert.equal(packet[0], 0xc1);
assert.deepStrictEqual([1, 5, 9, 13, 17].map(offset => packet.readInt32LE(offset)), [1, 127, 14, 3, 2]);
assert.equal(Response.skillCoolTime(restored, now + 3500).readInt32LE(1), 0);
const packets = [];
invoke('GameServer/Network/Opcodes').table[0x9d]({ actor, dataSendToMe: p => packets.push(p) });
assert.equal(packets[0][0], 0xc1);
Reuse.restore(restored, '{bad json');
assert.equal(restored.skillReuseUntil.size, 0);
Reuse.restore(restored, [{ id: 127, until: now - 1 }], now);
assert.equal(restored.skillReuseUntil.size, 0);

// Exercise the actual DB migration and status write against a disposable database.
const dir = fixture.directory;
(async () => {
    try {
        // Neither logout nor character selection may acknowledge before the save completes.
        for (const name of ['Logout', 'Restart']) {
            const vm = require('vm');
            const events = [];
            let finishSave;
            const save = new Promise(resolve => { finishSave = resolve; });
            const dependencies = {
                'GameServer/Network/Response': { logoutSuccess: () => 'logout', restart: () => 'restart' },
                'GameServer/Network/Shared': { fetchCharacters: async () => [], enterCharacterHall: () => {} },
                'GameServer/World/Generics/NativeUiSession': { reset(_session, options) {
                    assert.strictEqual(options.clearDirection, true);
                    events.push('reset-ui');
                } },
                'GameServer/World/ArenaDuelService': { release() {} },
                'GameServer/World/World': { retireUserActor(session, currentActor) {
                    assert.strictEqual(currentActor, session.actor);
                    events.push('retire');
                } },
                'GameServer/Effects/EffectTicker': { clearAll() {} }
            };
            const context = { module: { exports: {} }, invoke: key => dependencies[key] };
            vm.runInNewContext(fs.readFileSync(require.resolve(`../src/GameServer/Network/Request/${name}`), 'utf8'), context);
            const pending = context.module.exports({ actor: { destructor: () => events.push('destroy') },
                persistCharacterStatus: () => save, dataSendToMe: () => events.push('reply') });
            assert.deepStrictEqual(events, ['reset-ui']);
            finishSave();
            await pending;
            assert.deepStrictEqual(events, ['reset-ui', 'retire', 'destroy', 'reply']);
        }
        await Database.init();
        await Database.createAccount('reuse_test', 'test');
        await Database.createCharacter('reuse_test', { name: 'ReuseProbe', race: 0, classId: 0,
            maxHp: 50, maxMp: 25, sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0 });
        const character = (await Database.fetchCharacters('reuse_test'))[0];
        actor.skillReuseUntil.set(127, now + 600000);
        actor.skillReuseDetails.set(127, { duration: 600000, level: 14 });
        await Database.updateCharacterStatus(character.id, Status.persistenceRecord(actor));
        await Database.close();
        await Database.init();
        const saved = (await Database.fetchCharacters('reuse_test'))[0];
        Reuse.restore(restored, saved.skillCooldowns, now + 10000);
        assert.equal(restored.skillReuseUntil.get(127), now + 600000);
        assert.equal(restored.skillReuseDetails.get(127).duration, 600000);
        Reuse.restore(restored, saved.skillCooldowns, now + 600001);
        assert.equal(restored.skillReuseUntil.size, 0);
        console.log('Cooldown packets, speed/buffs/mastery, expiry and SQLite persistence passed');
    } finally {
        await Database.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
