const assert = require("assert");

require("../src/Global");

const QuestService = invoke("GameServer/Quest/QuestService");
const Q001 = require("../src/GameServer/Quest/quests/Q001_LettersOfLove");
const Q002 = require("../src/GameServer/Quest/quests/Q002_WhatWomenWant");
const Q003 = require("../src/GameServer/Quest/quests/Q003_WillTheSealBeBroken");
const Q004 = require("../src/GameServer/Quest/quests/Q004_LongLiveThePaagrioLord");
const Q005 = require("../src/GameServer/Quest/quests/Q005_MinersFavor");
const Q006 = require("../src/GameServer/Quest/quests/Q006_StepIntoTheFuture");
const Q007 = require("../src/GameServer/Quest/quests/Q007_ATripBegins");
const Q008 = require("../src/GameServer/Quest/quests/Q008_AnAdventureBegins");
const Q009 = require("../src/GameServer/Quest/quests/Q009_IntoTheCityOfHumans");
const Q010 = require("../src/GameServer/Quest/quests/Q010_IntoTheWorld");
const Q011 = require("../src/GameServer/Quest/quests/Q011_SecretMeetingWithKetraOrcs");
const Q012 = require("../src/GameServer/Quest/quests/Q012_SecretMeetingWithVarkaSilenos");
const Q013 = require("../src/GameServer/Quest/quests/Q013_ParcelDelivery");
const Q014 = require("../src/GameServer/Quest/quests/Q014_WhereaboutsOfTheArchaeologist");
const Q015 = require("../src/GameServer/Quest/quests/Q015_SweetWhispers");
const Q016 = require("../src/GameServer/Quest/quests/Q016_TheComingDarkness");
const Q017 = require("../src/GameServer/Quest/quests/Q017_LightAndDarkness");
const Q018 = require("../src/GameServer/Quest/quests/Q018_MeetingWithTheGoldenRam");
const Q019 = require("../src/GameServer/Quest/quests/Q019_GoToThePastureland");
const Q031 = require("../src/GameServer/Quest/quests/Q031_SecretBuriedInTheSwamp");
const Q032 = require("../src/GameServer/Quest/quests/Q032_AnObviousLie");
const Q033 = require("../src/GameServer/Quest/quests/Q033_MakeAPairOfDressShoes");
const Q034 = require("../src/GameServer/Quest/quests/Q034_InSearchOfCloth");
const Q035 = require("../src/GameServer/Quest/quests/Q035_FindGlitteringJewelry");
const Q036 = require("../src/GameServer/Quest/quests/Q036_MakeASewingKit");
const Q037 = require("../src/GameServer/Quest/quests/Q037_MakeFormalWear");
const Q042 = require("../src/GameServer/Quest/quests/Q042_HelpTheUncle");
const Q043 = require("../src/GameServer/Quest/quests/Q043_HelpTheSister");
const Q044 = require("../src/GameServer/Quest/quests/Q044_HelpTheSon");
const Q045 = require("../src/GameServer/Quest/quests/Q045_ToTalkingIsland");
const Q046 = require("../src/GameServer/Quest/quests/Q046_OnceMoreInTheArmsOfTheMotherTree");
const Q047 = require("../src/GameServer/Quest/quests/Q047_IntoTheDarkForest");
const Q048 = require("../src/GameServer/Quest/quests/Q048_ToTheImmortalPlateau");
const Q049 = require("../src/GameServer/Quest/quests/Q049_TheRoadHome");
const Q101 = require("../src/GameServer/Quest/quests/Q101_SwordOfSolidarity");
const Q104 = require("../src/GameServer/Quest/quests/Q104_SpiritOfMirrors");
const Q157 = require("../src/GameServer/Quest/quests/Q157_RecoverSmuggledGoods");
const Q160 = require("../src/GameServer/Quest/quests/Q160_NerupasRequest");
const Q105 = require("../src/GameServer/Quest/quests/Q105_SkirmishWithTheOrcs");
const Q107 = require("../src/GameServer/Quest/quests/Q107_MercilessPunishment");
const Q152 = require("../src/GameServer/Quest/quests/Q152_ShardsOfGolem");
const Q159 = require("../src/GameServer/Quest/quests/Q159_ProtectTheWaterSource");
const Q162 = require("../src/GameServer/Quest/quests/Q162_CurseOfTheUndergroundFortress");
const Q163 = require("../src/GameServer/Quest/quests/Q163_LegacyOfThePoet");

async function main() {
  assert.strictEqual(Q001.eventNpc("start"), 7048);
  assert.strictEqual(Q002.eventNpc("reward"), 7223);
  assert.strictEqual(Q003.eventNpc("start"), 7141);
  assert.strictEqual(Q004.eventNpc("start"), 7578);
  assert.strictEqual(Q005.eventNpc("start"), 7554);
  assert.strictEqual(Q005.eventNpc("pick"), 7526);
  assert.strictEqual(Q006.eventNpc("start"), 7006);
  assert.strictEqual(Q006.eventNpc("letter"), 7033);
  assert.strictEqual(Q006.eventNpc("deliver"), 7311);
  assert.strictEqual(Q006.eventNpc("reward"), 7006);
  assert.strictEqual(Q007.eventNpc("start"), 7146);
  assert.strictEqual(Q007.eventNpc("recommendation"), 7148);
  assert.strictEqual(Q007.eventNpc("deliver"), 7154);
  assert.strictEqual(Q007.eventNpc("reward"), 7146);
  assert.strictEqual(Q008.eventNpc("start"), 7134);
  assert.strictEqual(Q008.eventNpc("note"), 7355);
  assert.strictEqual(Q008.eventNpc("deliver"), 7144);
  assert.strictEqual(Q008.eventNpc("reward"), 7134);
  assert.strictEqual(Q009.eventNpc("start"), 7583);
  assert.strictEqual(Q009.eventNpc("council"), 7571);
  assert.strictEqual(Q009.eventNpc("reward"), 7576);
  assert.strictEqual(Q010.eventNpc("necklace"), 7520);
  assert.strictEqual(Q010.eventNpc("appraise"), 7650);
  assert.strictEqual(Q011.eventNpc("supplies"), 8256);
  assert.strictEqual(Q012.eventNpc("reward"), 8378);
  assert.strictEqual(Q013.eventNpc("start"), 8274);
  assert.strictEqual(Q014.eventNpc("reward"), 8538);
  assert.strictEqual(Q015.eventNpc("message"), 8518);
  assert.strictEqual(Q016.eventNpc("altar5"), 8516);
  assert.strictEqual(Q017.eventNpc("altar4"), 8511);
  assert.strictEqual(Q018.eventNpc("supplies"), 8315);
  assert.strictEqual(Q019.eventNpc("reward"), 8537);
  assert.strictEqual(Q031.eventNpc("monument4"), 8664);
  assert.strictEqual(Q032.eventNpc("racoon"), 7094);
  assert.strictEqual(Q033.eventNpc("payment"), 7164);
  assert.strictEqual(Q034.eventNpc("silk"), 7165);
  assert.strictEqual(Q035.eventNpc("felton"), 7879);
  assert.strictEqual(Q036.eventNpc("steel"), 7847);
  assert.strictEqual(Q037.eventNpc("components"), 8520);
  assert.strictEqual(Q042.eventNpc("partner"), 7735);
  assert.strictEqual(Q043.eventNpc("weapon"), 7829);
  assert.strictEqual(Q044.eventNpc("map"), 7827);
  assert.strictEqual(Q045.eventNpc("necklace"), 7116);
  assert.strictEqual(Q046.eventNpc("reward"), 7097);
  assert.strictEqual(Q047.eventNpc("hilt"), 7094);
  assert.strictEqual(Q048.eventNpc("powder"), 7090);
  assert.strictEqual(Q049.eventNpc("necklace"), 7116);
  assert.strictEqual(Q101.eventNpc("start"), 7008);
  assert.strictEqual(Q104.eventNpc("start"), 7017);
  assert.strictEqual(Q157.eventNpc("start"), 7005);
  assert.strictEqual(Q160.eventNpc("start"), 7370);
  assert.strictEqual(Q002.eventNpc("unknown"), null);
  assert.strictEqual(Q004.eventNpc("unknown"), null);
  assert.strictEqual(Q005.eventNpc("unknown"), null);
  assert.strictEqual(Q006.eventNpc("unknown"), null);
  assert.strictEqual(Q007.eventNpc("unknown"), null);
  assert.strictEqual(Q008.eventNpc("unknown"), null);
  assert.strictEqual(Q009.eventNpc("unknown"), null);
  assert.strictEqual(Q010.eventNpc("unknown"), null);
  assert.strictEqual(Q011.eventNpc("unknown"), null);
  assert.strictEqual(Q012.eventNpc("unknown"), null);
  assert.strictEqual(Q013.eventNpc("unknown"), null);
  assert.strictEqual(Q014.eventNpc("unknown"), null);
  assert.strictEqual(Q015.eventNpc("unknown"), null);
  assert.strictEqual(Q016.eventNpc("altar6"), null);
  assert.strictEqual(Q017.eventNpc("altar0"), null);
  assert.strictEqual(Q018.eventNpc("unknown"), null);
  assert.strictEqual(Q019.eventNpc("unknown"), null);
  assert.strictEqual(Q031.eventNpc("monument5"), null);
  assert.strictEqual(Q032.eventNpc("unknown"), null);
  assert.strictEqual(Q033.eventNpc("unknown"), null);
  assert.strictEqual(Q034.eventNpc("unknown"), null);
  assert.strictEqual(Q035.eventNpc("unknown"), null);
  assert.strictEqual(Q036.eventNpc("unknown"), null);
  assert.strictEqual(Q037.eventNpc("unknown"), null);
  assert.strictEqual(Q042.eventNpc("unknown"), null);
  assert.strictEqual(Q043.eventNpc("unknown"), null);
  assert.strictEqual(Q044.eventNpc("unknown"), null);
  assert.strictEqual(Q045.eventNpc("unknown"), null);
  assert.strictEqual(Q046.eventNpc("unknown"), null);
  assert.strictEqual(Q047.eventNpc("unknown"), null);
  assert.strictEqual(Q048.eventNpc("unknown"), null);
  assert.strictEqual(Q049.eventNpc("unknown"), null);

  const session = {};
  const order = [];
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const first = QuestService.mutate(session, async () => {
    order.push("first-start");
    markStarted();
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    order.push("first-end");
  });
  const second = QuestService.mutate(session, async () => {
    order.push("second");
  });
  await started;
  assert.deepStrictEqual(
    order,
    ["first-start"],
    "the second quest mutation must wait for the first",
  );
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepStrictEqual(order, ["first-start", "first-end", "second"]);

  const state = {
    session: {
      actor: {
        backpack: { fetchItemFromSelfId: () => null },
      },
    },
    isCompleted: () => false,
    isStarted: () => true,
    getInt: () => 2,
  };
  const html = await Q003.onTalk(state, { fetchSelfId: () => 7141 });
  assert.match(
    html,
    /all three ritual ingredients/,
    "Q003 must not reward a player whose hand-in items disappeared",
  );

  const originalTake = QuestService.takeItem;
  const originalGive = QuestService.giveItem;
  const originalRewardAdena = QuestService.rewardAdena;
  const calls = [];
  QuestService.takeItem = async (_, itemId) => calls.push(["take", itemId]);
  QuestService.giveItem = async (_, itemId, amount) =>
    calls.push(["give", itemId, amount]);
  QuestService.rewardAdena = async (_, amount) => calls.push(["adena", amount]);
  try {
    let q002Condition = 1;
    const q002State = {
      session: { actor: { fetchLevel: () => 2, fetchRace: () => 1 } },
      isCompleted: () => false,
      isStarted: () => true,
      getInt: () => q002Condition,
      set: async (key, value) => {
        assert.strictEqual(key, "cond");
        q002Condition = Number(value);
      },
      playSound: (sound) => calls.push(["sound", sound]),
    };
    await Q002.onTalk(q002State, { fetchSelfId: () => 7146 });
    await Q002.onTalk(q002State, { fetchSelfId: () => 7150 });
    assert.deepStrictEqual(
      calls,
      [
        ["take", 1092],
        ["give", 1093, 1],
        ["sound", "ItemSound.quest_middle"],
        ["take", 1093],
        ["give", 1094, 1],
        ["sound", "ItemSound.quest_middle"],
      ],
      "Q002 must replace the gatekeeper letter and issue Herbiel's church letter",
    );
    calls.length = 0;

    let completed = false;
    await Q001.onTalk(
      {
        session: { actor: { fetchLevel: () => 2 } },
        isCompleted: () => completed,
        isStarted: () => true,
        getInt: () => 4,
        playSound: (sound) => calls.push(["sound", sound]),
        exit: async () => {
          completed = true;
        },
      },
      { fetchSelfId: () => 7048 },
    );
    assert.deepStrictEqual(
      calls,
      [
        ["take", 1080],
        ["give", 906, 1],
        ["sound", "ItemSound.quest_finish"],
      ],
      "Q001 must grant one unscaled Necklace of Knowledge and the completion sound",
    );
  } finally {
    QuestService.takeItem = originalTake;
    QuestService.giveItem = originalGive;
    QuestService.rewardAdena = originalRewardAdena;
  }

  const deleted = [];
  const allStackItem = {
    fetchId: () => 41,
    fetchAmount: () => 7,
  };
  const allStackSession = {
    actor: {
      fetchId: () => 8,
      backpack: {
        items: [allStackItem],
        fetchItemFromSelfId: () => allStackItem,
        fetchItems: () => [],
      },
    },
    dataSendToMe: () => {},
  };
  const originalDeleteItem = invoke("Database").deleteItem;
  invoke("Database").deleteItem = async (...args) => deleted.push(args);
  try {
    assert.strictEqual(
      await QuestService.takeItem(allStackSession, 1094, -1),
      true,
      "takeItem(-1) must consume an existing quest-item stack",
    );
    assert.deepStrictEqual(deleted, [[8, 41]]);
    assert.deepStrictEqual(allStackSession.actor.backpack.items, []);
  } finally {
    invoke("Database").deleteItem = originalDeleteItem;
  }
}

main()
  .then(() => console.log("quest runtime checks passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
