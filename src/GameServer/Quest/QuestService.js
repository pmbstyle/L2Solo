const ServerResponse = invoke("GameServer/Network/Response");
const Database = invoke("Database");
const DataCache = invoke("GameServer/DataCache");
const QuestState = invoke("GameServer/Quest/QuestState");
const ProgressionRates = invoke("GameServer/ProgressionRates");
const ExperienceReward = invoke("GameServer/Actor/Generics/ExperienceReward");
const ConsoleText = invoke("GameServer/ConsoleText");
const World = invoke("GameServer/World/World");
const ClassTransfer = invoke("GameServer/ClassTransfer");

const quests = [
  require("./quests/Q001_LettersOfLove"),
  require("./quests/Q002_WhatWomenWant"),
  require("./quests/Q003_WillTheSealBeBroken"),
  require("./quests/Q004_LongLiveThePaagrioLord"),
  require("./quests/Q005_MinersFavor"),
  require("./quests/Q006_StepIntoTheFuture"),
  require("./quests/Q007_ATripBegins"),
  require("./quests/Q008_AnAdventureBegins"),
  require("./quests/Q009_IntoTheCityOfHumans"),
  require("./quests/Q010_IntoTheWorld"),
  require("./quests/Q034_InSearchOfCloth"),
  require("./quests/Q036_MakeASewingKit"),
  require("./quests/Q042_HelpTheUncle"),
  require("./quests/Q043_HelpTheSister"),
  require("./quests/Q045_ToTalkingIsland"),
  require("./quests/Q046_OnceMoreInTheArmsOfTheMotherTree"),
  require("./quests/Q047_IntoTheDarkForest"),
  require("./quests/Q048_ToTheImmortalPlateau"),
  require("./quests/Q049_TheRoadHome"),
  require("./quests/Q101_SwordOfSolidarity"),
  require("./quests/Q102_FungusFever"),
  require("./quests/Q103_SpiritOfCraftsman"),
  require("./quests/Q104_SpiritOfMirrors"),
  require("./quests/Q105_SkirmishWithTheOrcs"),
  require("./quests/Q106_ForgottenTruth"),
  require("./quests/Q107_MercilessPunishment"),
  require("./quests/Q108_JumbleTumbleDiamondFuss"),
  require("./quests/Q151_CureForFeverDisease"),
  require("./quests/Q152_ShardsOfGolem"),
  require("./quests/Q153_DeliverGoods"),
  require("./quests/Q154_SacrificeToTheSea"),
  require("./quests/Q155_FindSirWindawood"),
  require("./quests/Q156_MillenniumLove"),
  require("./quests/Q157_RecoverSmuggledGoods"),
  require("./quests/Q158_SeedOfEvil"),
  require("./quests/Q159_ProtectTheWaterSource"),
  require("./quests/Q160_NerupasRequest"),
  require("./quests/Q161_FruitOfTheMotherTree"),
  require("./quests/Q162_CurseOfTheUndergroundFortress"),
  require("./quests/Q163_LegacyOfThePoet"),
  require("./quests/Q164_BloodFiend"),
  require("./quests/Q165_ShilensHunt"),
  require("./quests/Q166_MassOfDarkness"),
  require("./quests/Q167_DwarvenKinship"),
  require("./quests/Q168_DeliverSupplies"),
  require("./quests/Q169_OffspringOfNightmares"),
  require("./quests/Q170_DangerousSeduction"),
  require("./quests/Q401_PathToWarrior"),
  require("./quests/Q402_PathToKnight"),
  require("./quests/Q403_PathToRogue"),
  require("./quests/Q404_PathToWizard"),
  require("./quests/Q405_PathToCleric"),
  require("./quests/Q406_PathToElvenKnight"),
  require("./quests/Q407_PathToElvenScout"),
  require("./quests/Q408_PathToElvenWizard"),
  require("./quests/Q409_PathToElvenOracle"),
  require("./quests/Q410_PathToPalusKnight"),
  require("./quests/Q411_PathToAssassin"),
  require("./quests/Q412_PathToDarkWizard"),
];
const byId = new Map(quests.map((quest) => [quest.id, quest]));

function states(session) {
  if (!session.questStates) session.questStates = new Map();
  return session.questStates;
}

// NPC links and kill callbacks can reach the same character back-to-back.
// Keep the read-modify-write quest transition atomic at the session level so
// two kills cannot both observe the same pre-transition inventory/state.
function mutate(session, work) {
  const previous = session.questMutationTail || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  session.questMutationTail = next.catch(() => {});
  return next;
}

async function ensureLoaded(session) {
  if (session.questStatesLoaded) return;
  const rows = await Database.fetchCharacterQuests(session.actor.fetchId());
  rows.forEach((row) => {
    const quest = byId.get(Number(row.questId));
    if (quest)
      states(session).set(quest.id, new QuestState(session, quest, row));
  });
  session.questStatesLoaded = true;
}

function stateFor(session, quest) {
  let state = states(session).get(quest.id);
  if (!state) {
    state = new QuestState(session, quest);
    states(session).set(quest.id, state);
  }
  return state;
}

function questForNpc(npc, session) {
  const npcId = Number(npc.fetchSelfId());
  const candidates = quests.filter((quest) => {
    if (!quest.npcs.includes(npcId)) return false;
    const state = stateFor(session, quest);
    if (
      !state.isStarted() &&
      !state.isCompleted() &&
      !(quest.startNpcs || []).includes(npcId)
    )
      return false;
    return !quest.canTalk || quest.canTalk(state, npc);
  });
  return (
    candidates.find((quest) => stateFor(session, quest).isStarted()) ||
    candidates.find((quest) => !stateFor(session, quest).isCompleted()) ||
    candidates[0]
  );
}

function availableStartQuests(npc, session) {
  const npcId = Number(npc.fetchSelfId());
  return quests.filter(
    (quest) =>
      (quest.startNpcs || []).includes(npcId) &&
      !stateFor(session, quest).isStarted() &&
      !stateFor(session, quest).isCompleted() &&
      (!quest.canTalk || quest.canTalk(stateFor(session, quest), npc)),
  );
}

function handlesNpc(npc) {
  const npcId = Number(npc.fetchSelfId?.() ?? npc);
  return quests.some((quest) => quest.npcs.includes(npcId));
}

// Gatekeepers can offer both travel and quest progress.  The caller needs to
// decide whether to expose the quest branch without opening it (talking to a
// quest NPC may itself advance a quest), so keep this check read-only.
async function hasTalk(session, npc) {
  await ensureLoaded(session);
  return Boolean(questForNpc(npc, session));
}

function render(session, npc, html) {
  session.dataSendToMe(ServerResponse.npcHtml(npc.fetchId(), html));
  session.dataSendToMe(ServerResponse.actionFailed());
}

function syncActiveQuests(session) {
  session.dataSendToMe(ServerResponse.questList(active(session)));
}

function activeQuestSnapshot(session) {
  return JSON.stringify(active(session));
}

// QuestState.giveItems in C4 sends an earned-item SystemMessage after the
// inventory mutation.  Without it the client silently updates its inventory,
// which makes a completed quest look as if it paid nothing.
function transmitItemReceived(session, selfId, amount) {
  const itemId = Number(selfId);
  const count = Math.max(0, Math.floor(Number(amount) || 0));
  if (count <= 0) return;

  if (itemId === 57) {
    ConsoleText.transmit(session, ConsoleText.caption.earnedAdena, [
      { kind: ConsoleText.kind.number, value: count },
    ]);
  } else if (count > 1) {
    ConsoleText.transmit(session, ConsoleText.caption.earnedAmountOf, [
      { kind: ConsoleText.kind.item, value: itemId },
      { kind: ConsoleText.kind.number, value: count },
    ]);
  } else {
    ConsoleText.transmit(session, ConsoleText.caption.earnedItem, [
      { kind: ConsoleText.kind.item, value: itemId },
    ]);
  }
}

async function onTalk(session, npc) {
  return mutate(session, async () => {
    await ensureLoaded(session);
    const quest = questForNpc(npc, session);
    if (!quest) return false;
    const state = stateFor(session, quest);
    const choices = availableStartQuests(npc, session);
    if (!state.isStarted() && choices.length > 1) {
      const html = `<html><body>Available quests:<br><br>${choices.map((quest) => `<a action="bypass -h quest ${quest.id} start">${quest.name}</a><br>`).join("")}</body></html>`;
      render(session, npc, html);
      return true;
    }
    const before = activeQuestSnapshot(session);
    const html = await quest.onTalk(state, npc);
    if (!html) return false;
    if (before !== activeQuestSnapshot(session)) syncActiveQuests(session);
    render(session, npc, html);
    return true;
  });
}

async function onEvent(session, event) {
  return mutate(session, async () => {
    await ensureLoaded(session);
    const quest = byId.get(Number(event.questId));
    const npc = session.activeNpcTalk;
    const eventName = String(event.name);
    if (!quest || !npc || !quest.npcs.includes(Number(npc.selfId)))
      return false;
    if (quest.eventNpc?.(eventName) !== Number(npc.selfId)) return false;
    const state = stateFor(session, quest);
    const before = activeQuestSnapshot(session);
    const html = await quest.onEvent(state, eventName);
    if (!html) return false;
    if (before !== activeQuestSnapshot(session)) syncActiveQuests(session);
    render(session, { fetchId: () => npc.objectId }, html);
    return true;
  });
}

async function giveItem(session, selfId, amount) {
  const backpack = session.actor.backpack;
  const existing = backpack.fetchItemFromSelfId(selfId);
  if (existing?.fetchStackable?.()) {
    const total = existing.fetchAmount() + amount;
    await Database.updateItemAmount(
      session.actor.fetchId(),
      existing.fetchId(),
      total,
    );
    existing.setAmount(total);
  } else {
    const data = await new Promise((resolve) =>
      DataCache.fetchItemFromSelfId(selfId, resolve),
    );
    const result = await Database.setItem(session.actor.fetchId(), {
      selfId,
      name: data.template.name,
      amount,
      equipped: false,
      slot: data.etc.slot,
    });
    backpack.insertItem(Number(result.insertId), selfId, { amount });
  }
  session.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
  transmitItemReceived(session, selfId, amount);
}

async function takeItem(session, selfId, amount = 1) {
  const item = session.actor.backpack.fetchItemFromSelfId(selfId);
  if (!item) return false;
  // L2J's QuestState.takeItems(id, -1) consumes the entire stack. Several
  // source-backed quest hand-ins use that sentinel; subtracting -1 would
  // silently duplicate a quest item instead of clearing it.
  const requested = Number(amount) === -1 ? item.fetchAmount() : Number(amount);
  if (!Number.isFinite(requested) || requested <= 0 || item.fetchAmount() < requested)
    return false;
  const remaining = item.fetchAmount() - requested;
  if (remaining > 0) {
    await Database.updateItemAmount(
      session.actor.fetchId(),
      item.fetchId(),
      remaining,
    );
    item.setAmount(remaining);
  } else {
    await Database.deleteItem(session.actor.fetchId(), item.fetchId());
    session.actor.backpack.items = session.actor.backpack.items.filter(
      (entry) => entry !== item,
    );
  }
  session.dataSendToMe(
    ServerResponse.itemsList(session.actor.backpack.fetchItems()),
  );
  return true;
}

// C4's RateQuestRewardAdena is specific to Adena.  Quest item and equipment
// rewards retain their authored count (for example, one Necklace of Knowledge).
function rewardAdena(session, amount) {
  const rates = questRates();
  return giveItem(
    session,
    57,
    Math.max(0, Math.floor(Number(amount) * rates.questAdena)),
  );
}

function questDropAmount(amount, needed, current) {
  const scaled = Math.floor(
    Math.max(0, Number(amount) || 0) * questRates().questDrop,
  );
  if (scaled <= 0 || current >= needed) return 0;
  return Math.min(scaled, needed - current);
}

function waypointKey(locX, locY, locZ) {
  return `${Number(locX)}:${Number(locY)}:${Number(locZ)}`;
}

// Source QuestState.addRadar sends an arming packet followed by a visible
// waypoint marker. Keep the marker session-local; it is client UI state, not
// durable quest progress.
function addRadar(session, locX, locY, locZ) {
  const coords = [locX, locY, locZ].map(Number);
  if (!session?.dataSendToMe || !coords.every(Number.isFinite)) return false;
  const key = waypointKey(...coords);
  session.questWaypoints ||= new Map();
  session.questWaypoints.set(key, coords);
  session.dataSendToMe(ServerResponse.radarControl(2, 2, ...coords));
  session.dataSendToMe(ServerResponse.radarControl(0, 1, ...coords));
  return true;
}

function removeRadar(session, locX, locY, locZ) {
  const coords = [locX, locY, locZ].map(Number);
  if (!session?.dataSendToMe || !coords.every(Number.isFinite)) return false;
  session.questWaypoints?.delete(waypointKey(...coords));
  session.dataSendToMe(ServerResponse.radarControl(1, 1, ...coords));
  return true;
}

function clearRadars(session) {
  const waypoints = [...(session?.questWaypoints?.values() || [])];
  waypoints.forEach((coords) => removeRadar(session, ...coords));
  return waypoints.length;
}

// Mirrors the source QuestState.addSpawn default: spawn at the player's
// location, with no automatic despawn unless a quest explicitly requests it.
function spawnQuestNpc(state, selfId, options = {}) {
  const actor = state?.session?.actor;
  if (!actor?.fetchId) return null;
  const locX = options.locX ?? actor.fetchLocX?.();
  const locY = options.locY ?? actor.fetchLocY?.();
  const locZ = options.locZ ?? actor.fetchLocZ?.();
  return World.spawnQuestNpc({
    selfId,
    locX,
    locY,
    locZ,
    head: options.head ?? actor.fetchHead?.() ?? 0,
    ownerId: actor.fetchId(),
    questId: state.quest?.id,
    despawnDelay: options.despawnDelay ?? 0,
  });
}

// Profession quests call this only from their verified final hand-in. The
// shared transfer commits classId and target skills before the quest can mark
// itself completed, so a database failure cannot consume the final objective.
function awardFirstProfession(state, targetClassId) {
  return ClassTransfer.transfer(state?.session, targetClassId, {
    firstProfessionOnly: true,
  });
}

function rewardExpSp(session, exp, sp) {
  const rates = questRates();
  // ExperienceReward owns UI, persistence, and level-up. Counter its normal
  // mob-rate input so C4's dedicated RateQuestRewardXp/Sp remains the sole
  // server multiplier for an authored quest reward.
  const baseExp =
    Number(rates.exp) > 0 ? (Number(exp) * rates.questExp) / rates.exp : 0;
  const baseSp =
    Number(rates.sp) > 0 ? (Number(sp) * rates.questSp) / rates.sp : 0;
  ExperienceReward(session, session.actor, baseExp, baseSp);
}

async function onKill(session, npc) {
  return mutate(session, async () => {
    await ensureLoaded(session);
    const ownerId = Number(npc.questSpawn?.ownerId) || 0;
    if (ownerId && ownerId !== Number(session.actor.fetchId())) return;
    const spawnedQuestId = Number(npc.questSpawn?.questId) || 0;
    const before = activeQuestSnapshot(session);
    const npcId = Number(npc.fetchSelfId());
    for (const quest of quests) {
      if (spawnedQuestId && spawnedQuestId !== quest.id) continue;
      if (!quest.killNpcs?.includes(npcId)) continue;
      const state = states(session).get(quest.id);
      if (state?.isStarted()) await quest.onKill(state, npc);
    }
    if (before !== activeQuestSnapshot(session)) syncActiveQuests(session);
  });
}

function active(session) {
  return [...states(session).values()]
    .filter((state) => state.isStarted())
    .map((state) => ({ id: state.quest.id, condition: state.getInt("cond") }));
}

function questRates() {
  return ProgressionRates.profile();
}

module.exports = {
  ensureLoaded,
  onTalk,
  onEvent,
  onKill,
  handlesNpc,
  hasTalk,
  mutate,
  stateFor,
  active,
  syncActiveQuests,
  transmitItemReceived,
  giveItem,
  takeItem,
  rewardAdena,
  rewardExpSp,
  questDropAmount,
  addRadar,
  removeRadar,
  clearRadars,
  spawnQuestNpc,
  awardFirstProfession,
  questRates,
  quests: () => quests,
};
