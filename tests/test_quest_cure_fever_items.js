require("../src/Global");
const assert = require("assert");

// Q151 Cure for Fever Disease uses the C4 items 703 Poison Sac and
// 704 Fever Medicine (Lisvus Q151_CureForFeverDisease.java).
const QuestService = invoke("GameServer/Quest/QuestService");
const Q151 = require("../src/GameServer/Quest/quests/Q151_CureForFeverDisease");

const calls = [];
const originalGive = QuestService.giveItem;
const originalTake = QuestService.takeItem;
const originalRandom = Math.random;
QuestService.giveItem = async (_, itemId, amount) => calls.push(["give", itemId, amount]);
QuestService.takeItem = async (_, itemId) => calls.push(["take", itemId]);

let cond = 1;
const state = {
  session: { actor: {} },
  isStarted: () => true,
  getInt: () => cond,
  set: async (_, value) => { cond = Number(value); },
  playSound() {},
  exit: async () => {},
};

(async () => {
  try {
    Math.random = () => 0;
    await Q151.onKill(state);
    Math.random = originalRandom;
    await Q151.onTalk(state, { fetchSelfId: () => 7032 });
    await Q151.onTalk(state, { fetchSelfId: () => 7050 });
    assert.deepStrictEqual(calls, [
      ["give", 703, 1],
      ["take", 703],
      ["give", 704, 1],
      ["take", 704],
      ["give", 102, 1],
    ]);
    console.log("Q151 Poison Sac and Fever Medicine item checks passed");
  } finally {
    Math.random = originalRandom;
    QuestService.giveItem = originalGive;
    QuestService.takeItem = originalTake;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
