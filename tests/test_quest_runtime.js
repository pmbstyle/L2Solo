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
const Q401 = require("../src/GameServer/Quest/quests/Q401_PathToWarrior");
const Q402 = require("../src/GameServer/Quest/quests/Q402_PathToKnight");
const Q403 = require("../src/GameServer/Quest/quests/Q403_PathToRogue");
const Q404 = require("../src/GameServer/Quest/quests/Q404_PathToWizard");
const Q405 = require("../src/GameServer/Quest/quests/Q405_PathToCleric");
const Q406 = require("../src/GameServer/Quest/quests/Q406_PathToElvenKnight");
const Q407 = require("../src/GameServer/Quest/quests/Q407_PathToElvenScout");
const Q408 = require("../src/GameServer/Quest/quests/Q408_PathToElvenWizard");

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
  assert.strictEqual(Q401.eventNpc("start"), 7010);
  assert.strictEqual(Q401.eventNpc("guild"), 7253);
  assert.strictEqual(Q401.eventNpc("forge"), 7010);
  assert.strictEqual(Q402.eventNpc("start"), 7417);
  assert.strictEqual(Q402.eventNpc("aron"), 7332);
  assert.strictEqual(Q402.eventNpc("herod"), 7031);
  assert.strictEqual(Q403.eventNpc("start"), 7379);
  assert.strictEqual(Q403.eventNpc("neti"), 7425);
  assert.strictEqual(Q404.eventNpc("start"), 7391);
  assert.strictEqual(Q404.eventNpc("feather"), 7410);
  assert.strictEqual(Q405.eventNpc("start"), 7022);
  assert.strictEqual(Q406.eventNpc("start"), 7327);
  assert.strictEqual(Q406.eventNpc("kluto"), 7317);
  assert.strictEqual(Q407.eventNpc("start"), 7328);
  assert.strictEqual(Q407.eventNpc("moretti"), 7337);
  assert.strictEqual(Q408.eventNpc("start"), 7414);
  assert.strictEqual(Q408.eventNpc("grain"), 7157);
  assert.strictEqual(Q408.eventNpc("sap"), 7371);
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
  const originalAwardFirstProfession = QuestService.awardFirstProfession;
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

    calls.length = 0;
    const items = new Map();
    let equippedWeapon = 0;
    let classId = 0;
    const setItem = (id, amount) => items.set(id, Math.max(0, amount));
    const questState = {
      session: {
        actor: {
          fetchClassId: () => classId,
          fetchLevel: () => 20,
          backpack: {
            fetchItemFromSelfId: (id) => {
              const amount = items.get(id) || 0;
              return amount ? { fetchAmount: () => amount } : null;
            },
            fetchPaperdollSelfId: () => equippedWeapon,
          },
        },
      },
      isStarted: () => questState.started,
      isCompleted: () => questState.completed,
      started: false,
      completed: false,
      cond: 0,
      getInt: () => questState.cond,
      setState: async () => { questState.started = true; },
      set: async (key, value) => { if (key === "cond") questState.cond = Number(value); },
      exit: async () => { questState.completed = true; },
      playSound: (sound) => calls.push(["sound", sound]),
    };
    QuestService.giveItem = async (_, id, amount) => setItem(id, (items.get(id) || 0) + amount);
    QuestService.takeItem = async (_, id, amount = 1) => {
      const current = items.get(id) || 0;
      const remove = amount === -1 ? current : amount;
      if (current < remove) return false;
      setItem(id, current - remove);
      return true;
    };
    QuestService.awardFirstProfession = async () => ({ ok: true, targetClassId: 1 });
    await Q401.onEvent(questState, "start");
    assert.strictEqual(items.get(1138), 1, "Q401 must issue Auron's Letter");
    await Q401.onEvent(questState, "guild");
    assert.strictEqual(items.get(1139), 1, "Q401 must issue the Warrior Guild Mark");
    setItem(1140, 9);
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      await Q401.onKill(questState, { fetchSelfId: () => 35 });
    } finally {
      Math.random = originalRandom;
    }
    assert.strictEqual(items.get(1140), 10, "Q401 must drop the tenth rusted sword from a Tracker Skeleton");
    assert.strictEqual(questState.cond, 3, "Q401 must advance when all ten rusted swords are collected");
    await Q401.onTalk(questState, { fetchSelfId: () => 7253 });
    assert.strictEqual(items.get(1143), 1, "Q401 must issue Simplon's Letter after the sword hand-in");
    await Q401.onEvent(questState, "forge");
    assert.strictEqual(items.get(1142), 1, "Q401 must issue the equipped Rusted Bronze Sword");
    setItem(1144, 19);
    await Q401.onKill(questState, { fetchSelfId: () => 38 });
    assert.strictEqual(items.get(1144), 19, "Q401 must not drop spider legs while the Rusted Bronze Sword is unequipped");
    equippedWeapon = 1142;
    await Q401.onKill(questState, { fetchSelfId: () => 38 });
    assert.strictEqual(items.get(1144), 20, "Q401 must drop spider legs with the Rusted Bronze Sword equipped");
    await Q401.onTalk(questState, { fetchSelfId: () => 7010 });
    assert.strictEqual(questState.completed, true, "Q401 must complete after the final spider-leg hand-in");
    assert.strictEqual(items.get(1145), 1, "Q401 must retain the source Medallion of Warrior reward");
    assert.strictEqual(items.get(1144), 0, "Q401 must consume all collected Poison Spider's Legs");
    assert.strictEqual(items.get(1142), 0, "Q401 must consume the Rusted Bronze Sword");

    items.clear();
    questState.started = false;
    questState.completed = false;
    questState.cond = 0;
    QuestService.awardFirstProfession = async () => ({ ok: true, targetClassId: 4 });
    await Q402.onEvent(questState, "start");
    assert.strictEqual(items.get(1271), 1, "Q402 must issue the Mark of Esquire");
    const knightAssignments = [
      ["aron", 7332, 1169, 10, 1162],
      ["collin", 7289, 1171, 12, 1163],
      ["kyle", 7379, 1173, 20, 1164],
      ["drystan", 7037, 1175, 20, 1165],
      ["jeremy", 7039, 1177, 20, 1166],
      ["herod", 7031, 1179, 10, 1167],
    ];
    for (const [event, npcId, trophy, needed, coin] of knightAssignments) {
      await Q402.onEvent(questState, event);
      if (event === "drystan") {
        setItem(trophy, needed - 1);
        const originalRandom = Math.random;
        Math.random = () => 0;
        try {
          await Q402.onKill(questState, { fetchSelfId: () => 24 });
        } finally {
          Math.random = originalRandom;
        }
        assert.strictEqual(items.get(trophy), needed, "Q402 must drop the final Lizardman Totem from its source mob");
      } else if (event === "jeremy") {
        setItem(trophy, needed - 1);
        const originalRandom = Math.random;
        Math.random = () => 0.5;
        try {
          await Q402.onKill(questState, { fetchSelfId: () => 103 });
          assert.strictEqual(items.get(trophy), needed - 1, "Q402 must preserve the source 40% Giant Spider Husk drop chance");
          Math.random = () => 0;
          await Q402.onKill(questState, { fetchSelfId: () => 103 });
        } finally {
          Math.random = originalRandom;
        }
        assert.strictEqual(items.get(trophy), needed, "Q402 must collect the final Giant Spider Husk on a successful roll");
      } else setItem(trophy, needed);
      await Q402.onTalk(questState, { fetchSelfId: () => npcId });
      assert.strictEqual(items.get(coin), 1, `Q402 must exchange ${event}'s trophies for its Coin of Lords`);
    }
    await Q402.onTalk(questState, { fetchSelfId: () => 7417 });
    assert.strictEqual(questState.completed, true, "Q402 must complete after all six Coins of Lords are returned");
    assert.strictEqual(items.get(1161), 1, "Q402 must retain the source Sword of Ritual reward");
    assert.strictEqual(items.get(1271), 0, "Q402 must consume the Mark of Esquire at completion");
    assert.deepStrictEqual([1162, 1163, 1164, 1165, 1166, 1167].map((id) => items.get(id) || 0), [0, 0, 0, 0, 0, 0], "Q402 must consume every Coin of Lords");

    items.clear();
    questState.started = false;
    questState.completed = false;
    questState.cond = 0;
    equippedWeapon = 0;
    QuestService.awardFirstProfession = async () => ({ ok: true, targetClassId: 7 });
    await Q403.onEvent(questState, "start");
    assert.strictEqual(items.get(1180), 1, "Q403 must issue Bezique's Letter");
    await Q403.onEvent(questState, "neti");
    assert.strictEqual(items.get(1181), 1, "Q403 must issue Neti's Bow");
    assert.strictEqual(items.get(1182), 1, "Q403 must issue Neti's Dagger");
    setItem(1183, 9);
    equippedWeapon = 1181;
    const originalRandomForRogue = Math.random;
    Math.random = () => 0;
    try {
      await Q403.onKill(questState, { fetchSelfId: () => 54 });
    } finally {
      Math.random = originalRandomForRogue;
    }
    assert.strictEqual(items.get(1183), 10, "Q403 must drop the tenth Spartoi Bone with Neti's weapon equipped");
    assert.strictEqual(questState.cond, 3, "Q403 must advance after all Spartoi Bones are collected");
    await Q403.onTalk(questState, { fetchSelfId: () => 7425 });
    assert.strictEqual(items.get(1184), 1, "Q403 must exchange bones for the Horseshoe of Light");
    await Q403.onTalk(questState, { fetchSelfId: () => 7379 });
    assert.strictEqual(items.get(1185), 1, "Q403 must issue the Wanted Bill after the Horseshoe hand-in");
    const stolenRolls = [0, 0, 0.25, 0.5, 0.75];
    for (const roll of stolenRolls) {
      const originalRandom = Math.random;
      Math.random = () => roll;
      try {
        await Q403.onKill(questState, { fetchSelfId: () => 5038 });
      } finally {
        Math.random = originalRandom;
      }
    }
    assert.deepStrictEqual([1186, 1187, 1188, 1189].map((id) => items.get(id) || 0), [1, 1, 1, 1], "Q403 must award each stolen item only when Cat's Eye Bandit's source roll selects it");
    await Q403.onTalk(questState, { fetchSelfId: () => 7379 });
    assert.strictEqual(questState.completed, true, "Q403 must complete after all stolen items are returned");
    assert.strictEqual(items.get(1190), 1, "Q403 must retain Bezique's Recommendation as the source reward");
    assert.strictEqual(items.get(1185), 0, "Q403 must consume the Wanted Bill at completion");

    items.clear();
    questState.started = false;
    questState.completed = false;
    questState.cond = 0;
    classId = 10;
    QuestService.awardFirstProfession = async () => ({ ok: true, targetClassId: 11 });
    await Q404.onEvent(questState, "start");
    await Q404.onTalk(questState, { fetchSelfId: () => 7411 });
    assert.strictEqual(items.get(1280), 1, "Q404 must issue the Map of Luster");
    await Q404.onKill(questState, { fetchSelfId: () => 359 });
    assert.strictEqual(items.get(1281), 1, "Q404 must drop the Key of Flame from Ratman Warriors");
    await Q404.onTalk(questState, { fetchSelfId: () => 7411 });
    assert.strictEqual(items.get(1282), 1, "Q404 must exchange the fire proof for the Flame Earring");
    await Q404.onTalk(questState, { fetchSelfId: () => 7412 });
    assert.strictEqual(items.get(1283), 1, "Q404 must issue the Broken Bronze Mirror");
    await Q404.onEvent(questState, "feather");
    assert.strictEqual(items.get(1284), 1, "Q404 must issue the Wind Feather after the mirror dialogue");
    await Q404.onTalk(questState, { fetchSelfId: () => 7412 });
    assert.strictEqual(items.get(1285), 1, "Q404 must exchange the wind proof for the Wind Bangle");
    await Q404.onTalk(questState, { fetchSelfId: () => 7413 });
    assert.strictEqual(items.get(1286), 1, "Q404 must issue Rama's Diary");
    await Q404.onKill(questState, { fetchSelfId: () => 5030 });
    await Q404.onKill(questState, { fetchSelfId: () => 5030 });
    assert.strictEqual(items.get(1287), 2, "Q404 must collect two Sparkle Pebbles from Water Seers");
    await Q404.onTalk(questState, { fetchSelfId: () => 7413 });
    assert.strictEqual(items.get(1288), 1, "Q404 must exchange the water proof for the Water Necklace");
    await Q404.onTalk(questState, { fetchSelfId: () => 7409 });
    assert.strictEqual(items.get(1289), 1, "Q404 must issue the Rust Gold Coin");
    await Q404.onKill(questState, { fetchSelfId: () => 21 });
    assert.strictEqual(items.get(1290), 1, "Q404 must drop Red Soil from Red Bears");
    await Q404.onTalk(questState, { fetchSelfId: () => 7409 });
    assert.strictEqual(items.get(1291), 1, "Q404 must exchange the earth proof for the Earth Ring");
    await Q404.onTalk(questState, { fetchSelfId: () => 7391 });
    assert.strictEqual(questState.completed, true, "Q404 must complete after all four elemental signs are returned");
    assert.strictEqual(items.get(1292), 1, "Q404 must retain the source Bead of Season reward");
    assert.deepStrictEqual([1282, 1285, 1288, 1291].map((id) => items.get(id) || 0), [0, 0, 0, 0], "Q404 must consume every elemental sign at completion");

    items.clear();
    questState.started = false;
    questState.completed = false;
    questState.cond = 0;
    classId = 10;
    let awardedClassId = null;
    QuestService.awardFirstProfession = async (_, targetClassId) => {
      awardedClassId = targetClassId;
      return { ok: true, targetClassId };
    };
    await Q405.onEvent(questState, "start");
    assert.strictEqual(items.get(1191), 1, "Q405 must issue the first Letter of Order");
    await Q405.onTalk(questState, { fetchSelfId: () => 7253 });
    assert.strictEqual(items.get(1195), 3, "Q405 must issue all three Books of Simplon");
    await Q405.onTalk(questState, { fetchSelfId: () => 7030 });
    assert.strictEqual(items.get(1194), 1, "Q405 must issue the Book of Vivyan");
    await Q405.onTalk(questState, { fetchSelfId: () => 7333 });
    assert.strictEqual(items.get(1199), 1, "Q405 must issue the Necklace of Mother");
    await Q405.onKill(questState, { fetchSelfId: () => 26 });
    assert.strictEqual(items.get(1198), 1, "Q405 must drop the Pendant of Mother from Ruin Zombies");
    await Q405.onTalk(questState, { fetchSelfId: () => 7333 });
    assert.strictEqual(items.get(1196), 1, "Q405 must exchange Praga's pendant and necklace for her book");
    await Q405.onTalk(questState, { fetchSelfId: () => 7022 });
    assert.strictEqual(items.get(1192), 1, "Q405 must exchange the three books for the second Letter of Order");
    await Q405.onTalk(questState, { fetchSelfId: () => 7408 });
    assert.strictEqual(items.get(1193), 1, "Q405 must issue Lionel's Book");
    await Q405.onTalk(questState, { fetchSelfId: () => 7017 });
    assert.strictEqual(items.get(1197), 1, "Q405 must exchange Lionel's Book for Gallint's certificate");
    await Q405.onTalk(questState, { fetchSelfId: () => 7408 });
    assert.strictEqual(items.get(1200), 1, "Q405 must exchange Gallint's certificate for Lionel's Covenant");
    await Q405.onTalk(questState, { fetchSelfId: () => 7022 });
    assert.strictEqual(awardedClassId, 15, "Q405 must award the Human Cleric class");
    assert.strictEqual(questState.completed, true, "Q405 must complete after Lionel's Covenant is returned");
    assert.strictEqual(items.get(1201), 1, "Q405 must retain the source Mark of Faith reward");
    assert.strictEqual(items.get(1192), 0, "Q405 must consume the second Letter of Order at completion");
    assert.strictEqual(items.get(1200), 0, "Q405 must consume Lionel's Covenant at completion");

    items.clear();
    questState.started = false;
    questState.completed = false;
    questState.cond = 0;
    classId = 18;
    awardedClassId = null;
    QuestService.awardFirstProfession = async (_, targetClassId) => {
      awardedClassId = targetClassId;
      return { ok: true, targetClassId };
    };
    await Q406.onEvent(questState, "start");
    setItem(1205, 19);
    const originalRandomForKnight = Math.random;
    Math.random = () => 0;
    try {
      await Q406.onKill(questState, { fetchSelfId: () => 35 });
    } finally {
      Math.random = originalRandomForKnight;
    }
    assert.strictEqual(items.get(1205), 20, "Q406 must drop the final Topaz Piece from the source skeletons");
    await Q406.onTalk(questState, { fetchSelfId: () => 7327 });
    assert.strictEqual(items.get(1202), 1, "Q406 must issue Sorius's Letter after the topaz hand-in");
    await Q406.onEvent(questState, "kluto");
    assert.strictEqual(items.get(1276), 1, "Q406 must issue Kluto's Memo after accepting his request");
    setItem(1206, 19);
    const originalRandomForEmerald = Math.random;
    Math.random = () => 0;
    try {
      await Q406.onKill(questState, { fetchSelfId: () => 782 });
    } finally {
      Math.random = originalRandomForEmerald;
    }
    assert.strictEqual(items.get(1206), 20, "Q406 must drop the final Emerald Piece from Ol Mahum Novices");
    await Q406.onTalk(questState, { fetchSelfId: () => 7317 });
    assert.strictEqual(items.get(1203), 1, "Q406 must exchange both gem sets for Kluto's Box");
    await Q406.onTalk(questState, { fetchSelfId: () => 7327 });
    assert.strictEqual(awardedClassId, 19, "Q406 must award the Elven Knight class");
    assert.strictEqual(questState.completed, true, "Q406 must complete after Kluto's Box is returned");
    assert.strictEqual(items.get(1204), 1, "Q406 must retain the source Elven Knight Brooch reward");
    assert.strictEqual(items.get(1203), 0, "Q406 must consume Kluto's Box at completion");

    items.clear();
    questState.started = false;
    questState.completed = false;
    questState.cond = 0;
    classId = 18;
    awardedClassId = null;
    QuestService.awardFirstProfession = async (_, targetClassId) => {
      awardedClassId = targetClassId;
      return { ok: true, targetClassId };
    };
    await Q407.onEvent(questState, "start");
    assert.strictEqual(items.get(1207), 1, "Q407 must issue Reisa's Letter");
    await Q407.onEvent(questState, "moretti");
    for (let i = 0; i < 4; i += 1) await Q407.onKill(questState, { fetchSelfId: () => 53 });
    assert.deepStrictEqual([1208, 1209, 1210, 1211].map((id) => items.get(id) || 0), [1, 1, 1, 1], "Q407 must recover each distinct torn letter from Ol Mahum Patrols");
    await Q407.onTalk(questState, { fetchSelfId: () => 7337 });
    assert.strictEqual(items.get(1212), 1, "Q407 must exchange the torn letters for Moretti's Herb");
    assert.strictEqual(items.get(1214), 1, "Q407 must issue Moretti's Letter");
    await Q407.onTalk(questState, { fetchSelfId: () => 7426 });
    const originalRandomForScout = Math.random;
    Math.random = () => 0.9;
    try {
      await Q407.onKill(questState, { fetchSelfId: () => 5031 });
      assert.strictEqual(items.get(1293) || 0, 0, "Q407 must preserve the source 60% Rusted Key drop chance");
      Math.random = () => 0;
      await Q407.onKill(questState, { fetchSelfId: () => 5031 });
    } finally {
      Math.random = originalRandomForScout;
    }
    assert.strictEqual(items.get(1293), 1, "Q407 must drop the Rusted Key from Ol Mahum Sentries");
    await Q407.onTalk(questState, { fetchSelfId: () => 7426 });
    assert.strictEqual(items.get(1215), 1, "Q407 must exchange the Rusted Key for Prias's Letter");
    await Q407.onTalk(questState, { fetchSelfId: () => 7337 });
    assert.strictEqual(items.get(1216), 1, "Q407 must exchange Prias's Letter for the Honorary Guard");
    await Q407.onTalk(questState, { fetchSelfId: () => 7328 });
    assert.strictEqual(awardedClassId, 22, "Q407 must award the Elven Scout class");
    assert.strictEqual(questState.completed, true, "Q407 must complete after the Honorary Guard is returned");
    assert.strictEqual(items.get(1217), 1, "Q407 must retain Reisa's Recommendation as the source reward");
    assert.strictEqual(items.get(1216), 0, "Q407 must consume the Honorary Guard at completion");

    items.clear();
    questState.started = false;
    questState.completed = false;
    questState.cond = 0;
    classId = 25;
    awardedClassId = null;
    QuestService.awardFirstProfession = async (_, targetClassId) => {
      awardedClassId = targetClassId;
      return { ok: true, targetClassId };
    };
    await Q408.onEvent(questState, "start");
    assert.strictEqual(items.get(1229), 1, "Q408 must issue the Fertility Peridot");
    await Q408.onEvent(questState, "ruby");
    await Q408.onEvent(questState, "grain");
    setItem(1219, 4);
    const originalRandomForRuby = Math.random;
    Math.random = () => 0;
    try {
      await Q408.onKill(questState, { fetchSelfId: () => 466 });
    } finally {
      Math.random = originalRandomForRuby;
    }
    await Q408.onTalk(questState, { fetchSelfId: () => 7157 });
    assert.strictEqual(items.get(1220), 1, "Q408 must exchange Red Down for the Magical Powers Ruby");
    await Q408.onEvent(questState, "aquamarine");
    await Q408.onEvent(questState, "sap");
    setItem(1223, 4);
    const originalRandomForAquamarine = Math.random;
    Math.random = () => 0;
    try {
      await Q408.onKill(questState, { fetchSelfId: () => 19 });
    } finally {
      Math.random = originalRandomForAquamarine;
    }
    await Q408.onTalk(questState, { fetchSelfId: () => 7371 });
    assert.strictEqual(items.get(1221), 1, "Q408 must exchange Gold Leaves for the Pure Aquamarine");
    await Q408.onEvent(questState, "amethyst");
    await Q408.onTalk(questState, { fetchSelfId: () => 7423 });
    setItem(1225, 1);
    const originalRandomForAmethyst = Math.random;
    Math.random = () => 0;
    try {
      await Q408.onKill(questState, { fetchSelfId: () => 47 });
    } finally {
      Math.random = originalRandomForAmethyst;
    }
    await Q408.onTalk(questState, { fetchSelfId: () => 7423 });
    assert.strictEqual(items.get(1226), 1, "Q408 must exchange Amethysts for the Nobility Amethyst");
    await Q408.onTalk(questState, { fetchSelfId: () => 7414 });
    assert.strictEqual(awardedClassId, 26, "Q408 must award the Elven Wizard class");
    assert.strictEqual(questState.completed, true, "Q408 must complete after all three gems are returned");
    assert.strictEqual(items.get(1230), 1, "Q408 must retain the source Eternity Diamond reward");
    assert.deepStrictEqual([1220, 1221, 1226, 1229].map((id) => items.get(id) || 0), [0, 0, 0, 0], "Q408 must consume every required gem and the Fertility Peridot");
  } finally {
    QuestService.takeItem = originalTake;
    QuestService.giveItem = originalGive;
    QuestService.rewardAdena = originalRewardAdena;
    QuestService.awardFirstProfession = originalAwardFirstProfession;
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
