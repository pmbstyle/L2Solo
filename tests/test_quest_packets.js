const assert = require('assert');

require('../src/Global');

const QuestList = invoke('GameServer/Network/Response/QuestList');
const QuestService = invoke('GameServer/Quest/QuestService');

assert.deepStrictEqual(QuestService.quests().map((quest) => quest.id), [1, 2, 3], 'early C4 quests register in deterministic order');
assert.deepStrictEqual(QuestService.quests()[0].startNpcs, [7048], 'only Darin starts Q001; Roxxy keeps her normal dialog before it begins');

const empty = QuestList();
assert.strictEqual(empty[0], 0x80);
assert.strictEqual(empty.length, 8, 'wire framing pads the three-byte C4 QuestList payload');
assert.strictEqual(empty.readUInt16LE(1), 0);

const active = QuestList([{ id: 1, condition: 3 }, { id: 151, condition: 2 }]);
assert.strictEqual(active.readUInt16LE(1), 2);
assert.strictEqual(active.readInt32LE(3), 1);
assert.strictEqual(active.readInt32LE(7), 3);
assert.strictEqual(active.readInt32LE(11), 151);
assert.strictEqual(active.readInt32LE(15), 2);

console.log('quest packets ok');
