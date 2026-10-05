const assert = require('assert');
require('../src/Global');
const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');

assert.strictEqual(Learning.learnedError(0.2, 0.03, 0, 10), 0.2);
assert(Math.abs(Learning.learnedError(0.2, 0.03, 10, 10) - 0.115) < 1e-12);
assert(Math.abs(Learning.learnedError(0.2, 0.03, 30, 10) - 0.05125) < 1e-12);
assert.strictEqual(Learning.learnedError(0.2, 0.03, Infinity, 10), 0.03);
assert.strictEqual(Learning.learnedError(0.03, 0.03, 30, 10), 0.03);
assert.strictEqual(Learning.learnedError(0.01, 0.03, 0, 10), 0.03, 'traits cannot start below the domain floor');
assert.strictEqual(Learning.learnedError(0.2, 0.03, -10, 10), 0.2);
assert(Learning.learnedError(0.2, 0.03, 100, 100) > Learning.learnedError(0.2, 0.03, 100, 10),
    'the same lifelong experience leaves more error at a harder stage');
assert.throws(() => Learning.learnedError(0.2, 0.03, 10, 0), RangeError);
const enabled = Config.knowledgeErrorsEnabled;
try {
    Config.knowledgeErrorsEnabled = false;
    assert.strictEqual(Learning.knowledgeEnabled(), false);
    Config.knowledgeErrorsEnabled = true;
    assert.strictEqual(Learning.knowledgeEnabled(), true);
} finally { Config.knowledgeErrorsEnabled = enabled; }
console.log('Shared knowledge switch and floor-bounded learning rule passed');
