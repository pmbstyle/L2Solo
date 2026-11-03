'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const HeapProfile = require('../src/Perf/HeapProfile');

const MB = 1048576;
const url = (file) => pathToFileURL(path.join(__dirname, '..', file)).href;
const node = (functionName, file, lineNumber, selfSize, children = []) => ({
    callFrame: { functionName, url: file ? url(file) : '', lineNumber }, selfSize, children });

// root ── tick BotAI.js:11 ─┬─ remember Memory.js:6 (live 2 MB, then 6 MB: it keeps growing)
//                           └─ (native) push (1 MB)
//      └─ load Data.js:3 (4 MB, stays)
const profile = (rememberMb) => ({ head: node('(root)', '', -1, 0, [
    node('tick', 'src/GameServer/Bot/AI/BotAI.js', 10, 0, [
        node('remember', 'src/GameServer/Memory.js', 5, rememberMb * MB),
        node('push', '', -1, MB)
    ]),
    node('load', 'src/GameServer/Data.js', 2, 4 * MB)
]) });

const s = HeapProfile.summarize(profile(2));
assert.equal(s.liveMb, 7);
assert.deepEqual(s.self.map(row => row.fn), ['load src/GameServer/Data.js:3', 'remember src/GameServer/Memory.js:6', 'push']);
assert.deepEqual(s.code, [
    { fn: 'load src/GameServer/Data.js:3', mb: 4 },
    { fn: 'tick src/GameServer/Bot/AI/BotAI.js:11', mb: 3 },
    { fn: 'remember src/GameServer/Memory.js:6', mb: 2 }
], 'a project frame holds what its callees keep, native ones included');

const grown = HeapProfile.diff(profile(2), profile(6));
assert.equal(grown.beforeMb, 7);
assert.equal(grown.afterMb, 11);
assert.deepEqual(grown.self, [{ fn: 'remember src/GameServer/Memory.js:6', mb: 4 }], 'only what grew is listed');
assert.deepEqual(grown.code.map(row => row.fn), ['tick src/GameServer/Bot/AI/BotAI.js:11', 'remember src/GameServer/Memory.js:6']);
assert.deepEqual(HeapProfile.diff(profile(6), profile(2)).self, [], 'shrinking is not growth');
assert.equal(HeapProfile.summarize({}).liveMb, 0);

console.log('test_perf_heap_profile passed');
