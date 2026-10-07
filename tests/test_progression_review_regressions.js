const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { createRequire } = require('node:module');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Cap = invoke('GameServer/Progression/ProgressionCap');
function load(file, dependencies, extra = '', globals = {}) {
    const box = { exports: {} };
    const filename = require.resolve('../src/' + file);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + extra, {
        module: box, invoke: name => dependencies[name] || {}, require: createRequire(filename),
        path: { actor: 'generics' }, options, utils: { infoWarn() {} }, ...globals
    });
    return box.exports;
}
(async () => {
    let release;
    let pending = 1;
    const read = new Promise(resolve => { release = resolve; });
    const Death = load('GameServer/Progression/DeathExperience.js', { Database: {
        isReady: () => true, fetchCharacterDeathExperience: () => read,
        clearCharacterDeathExperience: async () => { pending = 0; }
    } });
    const actor = { fetchId: () => 42 };
    const loading = Death.load(actor);
    await Promise.resolve();
    const clearing = Death.clearPendingRestoration(actor, 'restart_to_town');
    release({ pendingRestoration: 1, deathContext: '{}' });
    await Promise.all([loading, clearing]);
    assert.equal(pending, 0);
    assert.equal(actor.deathExperience, null);

    let finishLoad;
    const entering = load('GameServer/Actor/Generics/EnterWorld.js', {
        'GameServer/Progression/DeathExperience': { load: () => new Promise(resolve => { finishLoad = resolve; }) }
    });
    let online = false;
    const entry = entering({}, { setIsOnline() { online = true; throw new Error('online-after-load'); } });
    assert.equal(online, false);
    finishLoad();
    await assert.rejects(entry, /online-after-load/);
    assert.equal(online, true);

    const Session = invoke('GameServer/Session');
    const Opcodes = invoke('GameServer/Network/Opcodes');
    const original = Opcodes.table[0xff];
    let finishEntry, dispatched = 0;
    const session = { actor: {}, tracePacket() {}, enterWorldReady: new Promise(resolve => { finishEntry = resolve; }) };
    try {
        Opcodes.table[0xff] = () => { dispatched++; };
        const packet = Buffer.from([3, 0, 255]);
        const deferred = Session.prototype.dataReceive.call(session, packet);
        assert.equal(dispatched, 0);
        finishEntry();
        await deferred;
        assert.equal(dispatched, 1);
    } finally { Opcodes.table[0xff] = original; }

    let observed;
    const die = load('GameServer/Actor/Generics/Die.js', {
        'GameServer/Progression/DeathExperience': { applyDeathPenalty: (_s, _a, context) => { observed = context; throw new Error('captured'); } }
    });
    const victim = { isDead: () => false, fetchExp() {}, setExpSp() {} };
    const owner = {};
    const summon = { fetchKind() {} };
    for (const [context, expected] of [[{ source: summon, killer: owner }, true], [{ source: summon }, false], [{ killer: victim }, false], [{}, false]]) {
        assert.throws(() => die({ actor: victim }, victim, context), /captured/);
        assert.equal(observed.killerPlayable, expected);
    }

    options.default.Progression = { contentCap: 40 };
    let level = 78, exp = Data.experience[77], saved, recalculated = 0;
    const reward = load('GameServer/Actor/Generics/ExperienceReward.js', {
        'GameServer/Progression/ProgressionCap': Cap,
        'GameServer/ProgressionRates': { profile: () => ({ exp: 1, sp: 1 }) },
        'GameServer/Effects/EffectStats': { multiplier: () => 1 },
        'GameServer/Karma': { karmaLostForExperience: () => 0 },
        'GameServer/ConsoleText': { transmit() {}, caption: {}, kind: {} },
        'GameServer/Network/Response': { userInfo() {}, charInfo() {} },
        'GameServer/Persistence/CharacterWriteQueue': { experience: (_id, l, e) => { saved = [l, e]; } },
        generics: { calculateStats: () => { recalculated++; }, levelUp: () => assert.fail('cap reduction is not a level-up') }
    });
    reward({ dataSendToMe() {}, dataSendToOthers() {} }, {
        fetchId: () => 42, fetchLevel: () => level, fetchExp: () => exp, fetchSp: () => 0,
        setLevel: l => { level = l; }, setExpSp: e => { exp = e; }
    }, 100, 0);
    assert.equal(level, 40);
    assert.equal(exp, Cap.maximumAllowedExperience());
    assert.equal(saved[0], Cap.levelForExperience(saved[1]));
    assert.equal(recalculated, 1);

    const events = [];
    const character = { id: 42, classId: 8, level: 78, exp: Data.experience[77], sp: 500, adena: 100 };
    const ensure = load('GameServer/Bot/Population/GeneratedColdSeeder.js', {
        Database: {
            fetchCharacters: async () => [{ ...character }],
            deleteSkills: async () => { events.push('skills-cleared'); },
            updateCharacterClassId: async () => {},
            updateCharacterExperience: async (_id, l, e, sp) => { Object.assign(character, { level: l, exp: e, sp }); events.push('saved'); }
        },
        'GameServer/Progression/ProgressionCap': Cap,
        'GameServer/Bot/Economy/CraftShopService': { CraftStations: [], STATION_CRAFTER: { classId: 57, level: 70 } },
        'GameServer/DataCache': Data
    }, `\nprofileForIndex = () => ({ level: 40 });\nensureBaseLoadout = async (_id, _class, _adena, level) => { probe(level); };\nmodule.exports = ensureCharacter;`, {
        require: () => ({}), probe: l => { assert.equal(l, 40); assert.equal(character.level, 40); events.push('loadout'); }
    });
    const result = await ensure('test', 1, { serviceCrafter: false });
    assert.equal(result.character.level, 40);
    assert.equal(result.character.exp, Cap.maximumAllowedExperience());
    assert.equal(result.character.sp, 500);
    assert.deepEqual(events, ['skills-cleared', 'saved', 'loadout']);
    console.log('Progression review: login race, summon attribution, actor cap and existing seed cap passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
