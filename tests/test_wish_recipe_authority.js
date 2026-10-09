'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-recipe-authority-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'config.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const state = { characterId: 901, level: 20, phase: 'cold', activity: 'hunting', adena: 1000,
    stats: { classId: 1, decisionSeq: 2, activityLeaf: 0 }, inventory: {},
    currentRegion: 'Giran', timing: {}, simulation: { revision: 3 },
    loc: { locX: 80000, locY: 148000, locZ: -3500 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
const deps = { board: new BoardIndex(), spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure(), timestamp: 1e12 };
const filename = require.resolve('../src/GameServer/Bot/Economy/EconomyContext');
const workerContext = new Module(filename, module); workerContext.filename = filename;
workerContext.paths = Module._nodeModulePaths(path.dirname(filename));
const nativeRequire = workerContext.require.bind(workerContext);
workerContext.require = name => name === 'node:worker_threads' ? { isMainThread: false } : nativeRequire(name);
workerContext._compile(fs.readFileSync(filename, 'utf8'), filename);
try {
    for (const reader of [Economy, workerContext.exports]) {
        reader.reset();
        const empty = reader.forState(state, { ...deps, knownRecipes: [] });
        const learned = reader.forState(state, { ...deps, knownRecipes: [47, 49] });
        assert.notStrictEqual(learned, empty, 'native recipe acquisition invalidates the shared wish context');
        assert.notEqual(learned.inputKey, empty.inputKey);
        assert.strictEqual(reader.forState(state, { ...deps, knownRecipes: [{ recipeId: 49 }, 47, 47] }), learned,
            'recipe order and duplicate representations do not cause another decision');
        const forgotten = reader.forState(state, { ...deps, knownRecipes: [] });
        assert.notStrictEqual(forgotten, learned, 'authoritative withdrawal invalidates cached knowledge');
        reader.reset();
    }
    assert.equal(invoke('Database').isReady(), false);
    console.log('PASS native recipe authority: main and worker context dependency, canonical book, withdrawal');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
