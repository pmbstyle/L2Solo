const assert = require("assert");

require("../src/Global");

const QuestList = invoke("GameServer/Network/Response/QuestList");
const QuestService = invoke("GameServer/Quest/QuestService");

assert.deepStrictEqual(
  QuestService.quests().map((quest) => quest.id),
  [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 34, 36, 42, 43, 45, 46, 47, 48, 49, 101, 102, 103,
    104, 105, 106, 107, 108, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160,
    161, 162, 163, 164, 165, 166, 167, 168, 169, 170,
    401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415,
    416, 417, 418,
  ],
  "early C4 quests register in deterministic order",
);
assert.deepStrictEqual(
  QuestService.quests()[0].startNpcs,
  [7048],
  "only Darin starts Q001; Roxxy keeps her normal dialog before it begins",
);

const empty = QuestList();
assert.strictEqual(empty[0], 0x80);
assert.strictEqual(
  empty.length,
  8,
  "wire framing pads the three-byte C4 QuestList payload",
);
assert.strictEqual(empty.readUInt16LE(1), 0);

const active = QuestList([
  { id: 1, condition: 3 },
  { id: 151, condition: 2 },
]);
assert.strictEqual(active.readUInt16LE(1), 2);
assert.strictEqual(active.readInt32LE(3), 1);
assert.strictEqual(active.readInt32LE(7), 3);
assert.strictEqual(active.readInt32LE(11), 151);
assert.strictEqual(active.readInt32LE(15), 2);

const sent = [];
const session = {
  questStates: new Map([
    [
      1,
      {
        isStarted: () => true,
        quest: { id: 1 },
        getInt: () => 4,
      },
    ],
  ]),
  dataSendToMe: (packet) => sent.push(packet),
};
QuestService.syncActiveQuests(session);
assert.strictEqual(
  sent[0].readUInt16LE(1),
  1,
  "starting or advancing a quest must refresh the journal",
);
assert.strictEqual(sent[0].readInt32LE(3), 1);
assert.strictEqual(sent[0].readInt32LE(7), 4);
session.questStates.get(1).isStarted = () => false;
QuestService.syncActiveQuests(session);
assert.strictEqual(
  sent[1].readUInt16LE(1),
  0,
  "completing a quest must remove it from the client journal",
);

const received = [];
const rewardSession = { dataSendToMe: (packet) => received.push(packet) };
QuestService.transmitItemReceived(rewardSession, 57, 22500);
assert.strictEqual(
  received[0][0],
  0x64,
  "quest rewards must use C4 SystemMessage",
);
assert.strictEqual(
  received[0].readInt32LE(1),
  52,
  "Adena rewards must show the earned-Adena message",
);
assert.strictEqual(received[0].readInt32LE(5), 1);
assert.strictEqual(received[0].readInt32LE(9), 1);
assert.strictEqual(received[0].readInt32LE(13), 22500);
QuestService.transmitItemReceived(rewardSession, 906, 1);
assert.strictEqual(
  received[1].readInt32LE(1),
  54,
  "single-item rewards must show the earned-item message",
);
assert.strictEqual(received[1].readInt32LE(9), 3);
assert.strictEqual(received[1].readInt32LE(13), 906);

const questState = new (invoke("GameServer/Quest/QuestState"))(
  { dataSendToMe: (packet) => received.push(packet), actor: {} },
  { id: 1 },
);
questState.playSound("ItemSound.quest_finish");
const soundPacket = received[2];
assert.strictEqual(
  soundPacket[0],
  0x98,
  "quest state changes must use the C4 PlaySound packet",
);
assert.strictEqual(
  soundPacket.readInt32LE(1),
  0,
  "quest sounds must be immediate client sounds",
);
assert.strictEqual(
  soundPacket
    .subarray(5, 5 + "ItemSound.quest_finish".length * 2)
    .toString("ucs2"),
  "ItemSound.quest_finish",
);

console.log("quest packets ok");
