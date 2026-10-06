'use strict';

// Future real OS Worker boundary only. Authoring/static do not execute it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { Worker, isMainThread, parentPort, workerData, threadId } = require('node:worker_threads');
const gameRoot = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const helperPath = path.join(gameRoot, 'src/GameServer/World/MainActorPublicationSource.js');
const sourcePrefix = path.join(gameRoot, 'src') + path.sep;
const digest = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const helperSHA = digest(helperPath);
const sourceModules = () => Object.keys(require.cache).filter(filename => filename.startsWith(sourcePrefix));
const gameGlobals = () => ({ invoke: typeof global.invoke, options: typeof global.options,
    utils: typeof global.utils });

function workerBoundary() {
    assert.equal(isMainThread, false);
    assert(threadId > 0);
    assert.equal(workerData.kind, 'native-issuer-worker-boundary');
    assert.equal(workerData.helperPath, helperPath);
    assert.equal(digest(helperPath), helperSHA);
    assert.equal(process.env.L2NODE_SHARED_CONFIG_FILE, undefined);
    assert.equal(process.env.L2NODE_CONFIG_FILE, workerData.configPath);
    assert.equal(process.env.BOT_KNOWLEDGE_ERRORS_ENABLED, 'false');
    assert.deepEqual(sourceModules(), []);
    const globalsBefore = gameGlobals();
    assert.deepEqual(globalsBefore, { invoke: 'undefined', options: 'undefined', utils: 'undefined' });
    const originalLoad = Module._load;
    const requests = [], refusals = [];
    const protectedModules = new Set([
        path.join(gameRoot, 'src/GameServer/World/World.js'),
        path.join(gameRoot, 'src/GameServer/World/CharacterLocationRuntime.js'),
        path.join(gameRoot, 'src/Global.js'), path.join(gameRoot, 'src/Database.js')
    ]);
    let loaderRestored = false;
    try {
        Module._load = function(request, parent, ...rest) {
            const parentFile = parent?.filename;
            let requestedFile = null;
            if (typeof request === 'string' && (path.isAbsolute(request) || request.startsWith('.'))) {
                requestedFile = path.isAbsolute(request) ? path.resolve(request)
                    : path.resolve(path.dirname(parentFile || __filename), request);
                if (!path.extname(requestedFile)) requestedFile += '.js';
            }
            if (parentFile === helperPath || protectedModules.has(requestedFile)) {
                requests.push({ request, parentFile, requestedFile,
                    protected: protectedModules.has(requestedFile) });
            }
            return Reflect.apply(originalLoad, this, [request, parent, ...rest]);
        };
        const Native = require(helperPath);
        assert.equal(Object.isFrozen(Native), true);
        assert.deepEqual(Object.keys(Native), ['native']);
        assert.equal(typeof Native.native, 'function');
        // Positive: this observer saw the actual helper load a real builtin.
        assert(requests.some(value => value.parentFile === helperPath && value.request === 'node:worker_threads'));
        assert.deepEqual(sourceModules(), [helperPath]);
        assert.deepEqual(gameGlobals(), globalsBefore);
        const cases = [
            { name: 'zero arguments in actual OS Worker', args: [] },
            { name: 'explicit undefined', args: [undefined] },
            { name: 'explicit null', args: [null] },
            { name: 'explicit frozen object', args: [Object.freeze({})] },
            { name: 'explicit boolean', args: [true] },
            { name: 'explicit string', args: ['not native authority'] },
            { name: 'two explicit arguments', args: [undefined, null] },
            { name: 'zero arguments again, no acquired singleton', args: [] }
        ];
        for (const control of cases) {
            let caught = false, originalError;
            try { Reflect.apply(Native.native, Native, control.args); }
            catch (error) { caught = true; originalError = error; }
            assert.equal(caught, true, control.name);
            assert(originalError instanceof TypeError, control.name);
            assert.equal(originalError.message, 'invalid_native_actor_publication_owner', control.name);
            assert.deepEqual(requests.filter(value => value.protected), [], control.name);
            assert.deepEqual(sourceModules(), [helperPath], control.name);
            assert.deepEqual(gameGlobals(), globalsBefore, control.name);
            refusals.push({ name: control.name, argumentsLength: control.args.length,
                errorName: originalError.name, errorMessage: originalError.message });
        }
    } finally {
        Module._load = originalLoad;
        loaderRestored = Module._load === originalLoad;
    }
    assert.equal(loaderRestored, true);
    assert.deepEqual(requests.filter(value => value.protected), []);
    assert.deepEqual(sourceModules(), [helperPath]);
    assert.deepEqual(gameGlobals(), globalsBefore);
    assert.equal(digest(helperPath), helperSHA);
    return { scope: 'actual OS Worker early issuer factory only; no game Worker or native Main acceptance',
        isMainThread, threadId, exportAndBuiltinLoadPositive: true, refusals,
        requests, loaderRestored, globalsBefore, globalsAfter: gameGlobals(),
        loadedSources: sourceModules().map(filename => ({ path: filename, sha256: digest(filename) })),
        worldLoaded: false, runtimeLoaded: false, globalLoaded: false, databaseLoaded: false };
}

async function main() {
    assert.equal(isMainThread, true);
    assert.equal(digest(helperPath), helperSHA);
    const mainSourcesBefore = sourceModules();
    const mainGlobalsBefore = gameGlobals();
    const originalCwd = process.cwd();
    const environmentKeys = ['L2NODE_CONFIG_FILE', 'L2NODE_SHARED_CONFIG_FILE',
        'BOT_KNOWLEDGE_ERRORS_ENABLED', 'NODE_OPTIONS'];
    const mainEnvironmentBefore = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'n62-issuer-worker-boundary-'));
    const generated = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite'),
        config: path.join(directory, 'default-isolated.ini') };
    let worker, joined = false, terminationCode = null;
    try {
        const defaultConfig = fs.readFileSync(path.join(gameRoot, 'config/default.ini'), 'utf8');
        const databaseHeader = /^\[Database\]\r?\npath\s*=\s*[^\r\n]+/m;
        assert(databaseHeader.test(defaultConfig));
        const isolatedConfig = defaultConfig.replace(databaseHeader,
            `[Database]\npath = ${generated.world}\nhistoryPath = ${generated.history}`);
        fs.writeFileSync(generated.config, isolatedConfig);
        const workerEnv = { ...process.env, N53_GAME_ROOT: gameRoot,
            L2NODE_CONFIG_FILE: generated.config, BOT_KNOWLEDGE_ERRORS_ENABLED: 'false' };
        delete workerEnv.L2NODE_SHARED_CONFIG_FILE;
        delete workerEnv.NODE_OPTIONS;
        process.chdir(gameRoot);
        worker = new Worker(__filename, { name: 'native-issuer-early-boundary', execArgv: [], env: workerEnv,
            workerData: { kind: 'native-issuer-worker-boundary', helperPath, configPath: generated.config } });
        const finished = await new Promise((resolve, reject) => {
            const messages = [];
            const timeout = setTimeout(() => reject(new Error('issuer boundary Worker did not exit')), 5000);
            worker.on('message', message => { messages.push(message); });
            worker.once('error', error => { clearTimeout(timeout); reject(error); });
            worker.once('exit', code => { clearTimeout(timeout); joined = true; resolve({ code, messages }); });
        });
        assert.equal(finished.code, 0);
        assert.equal(finished.messages.length, 1);
        const result = finished.messages[0];
        assert.equal(result.isMainThread, false);
        assert(result.threadId > 0);
        assert.equal(result.exportAndBuiltinLoadPositive, true);
        assert.equal(result.refusals.length, 8);
        assert.equal(result.loaderRestored, true);
        assert.deepEqual(result.loadedSources, [{ path: helperPath, sha256: helperSHA }]);
        assert.deepEqual(result.requests.filter(value => value.protected), []);
        assert.deepEqual(result.globalsAfter, { invoke: 'undefined', options: 'undefined', utils: 'undefined' });
        assert.deepEqual(fs.readdirSync(directory), ['default-isolated.ini']);
        assert.equal(fs.existsSync(generated.world), false);
        assert.equal(fs.existsSync(generated.history), false);
        console.log('OBSERVATIONS ' + JSON.stringify({ workerExit: finished.code, joined, ...result }));
    } finally {
        if (worker && !joined) { terminationCode = await worker.terminate(); joined = true; }
        process.chdir(originalCwd);
        const filesBeforeRemoval = fs.readdirSync(directory);
        const environmentUnchanged = environmentKeys.every(key => process.env[key] === mainEnvironmentBefore[key]);
        const mainSourceImportsUnchanged = JSON.stringify(sourceModules()) === JSON.stringify(mainSourcesBefore);
        const mainGlobalsUnchanged = JSON.stringify(gameGlobals()) === JSON.stringify(mainGlobalsBefore);
        fs.rmSync(directory, { recursive: true, force: true });
        const cleanup = { workerCreated: !!worker, joined, terminationCode, filesBeforeRemoval,
            generatedPaths: generated, directoryRemoved: !fs.existsSync(directory),
            worldAndHistoryAbsent: !fs.existsSync(generated.world) && !fs.existsSync(generated.history),
            cwdRestored: process.cwd() === originalCwd, environmentUnchanged,
            mainSourceImportsUnchanged, mainGlobalsUnchanged, helperSHAAfter: digest(helperPath) };
        console.log('CLEANUP ' + JSON.stringify(cleanup));
        assert.equal(cleanup.worldAndHistoryAbsent, true);
        assert.equal(cleanup.directoryRemoved, true);
        assert.equal(cleanup.cwdRestored, true);
        assert.equal(environmentUnchanged, true);
        assert.equal(mainSourceImportsUnchanged, true);
        assert.equal(mainGlobalsUnchanged, true);
        assert.equal(cleanup.helperSHAAfter, helperSHA);
    }
}

if (isMainThread) main().catch(error => { console.error(error); process.exitCode = 1; });
else { parentPort.postMessage(workerBoundary()); parentPort.close(); }
