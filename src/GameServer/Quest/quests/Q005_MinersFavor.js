const BOLTER = 7554;
const SHARI = 7517;
const GARITA = 7518;
const REED = 7520;
const BRUNON = 7526;
const LIST = 1547;
const BOOTS = 1548;
const PICK = 1549;
const POWDER = 1550;
const BEER = 1551;
const SOCKS = 1552;
const NECKLACE = 906;
const REQUIRED = [BOOTS, PICK, POWDER, BEER];
const SOUND_ACCEPT = "ItemSound.quest_accept";
const SOUND_ITEMGET = "ItemSound.quest_itemget";
const SOUND_MIDDLE = "ItemSound.quest_middle";
const SOUND_FINISH = "ItemSound.quest_finish";

function service() {
  return invoke("GameServer/Quest/QuestService");
}
function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}
function startLink() {
  return '<a action="bypass -h quest 5 start">I will collect the supplies.</a>';
}
function has(state, itemId) {
  return (
    (state.session.actor.backpack.fetchItemFromSelfId(itemId)?.fetchAmount() ||
      0) > 0
  );
}
function hasAll(state, items = REQUIRED) {
  return items.every((itemId) => has(state, itemId));
}

async function takeAll(state, itemId) {
  const item = state.session.actor.backpack.fetchItemFromSelfId(itemId);
  if (item) await service().takeItem(state.session, itemId, item.fetchAmount());
}

async function grantSupply(state, itemId) {
  await service().giveItem(state.session, itemId, 1);
  if (hasAll(state)) {
    await state.set("cond", 2);
    state.playSound(SOUND_MIDDLE);
  } else {
    state.playSound(SOUND_ITEMGET);
  }
}

module.exports = {
  id: 5,
  name: "Miner's Favor",
  npcs: [BOLTER, SHARI, GARITA, REED, BRUNON],
  startNpcs: [BOLTER],
  eventNpc: (event) =>
    event === "start" ? BOLTER : event === "pick" ? BRUNON : null,

  async onEvent(state, event) {
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(state.session.actor.fetchLevel()) < 2) return null;
      await state.setState("started");
      await state.set("cond", 1);
      state.playSound(SOUND_ACCEPT);
      await service().giveItem(state.session, LIST, 1);
      await service().giveItem(state.session, SOCKS, 1);
      return page(
        "Bolter",
        "Bring me mining boots, a miner’s pick, boomboom powder, and Redstone beer.",
      );
    }
    if (
      event === "pick" &&
      state.isStarted() &&
      state.getInt("cond") === 1 &&
      has(state, SOCKS) &&
      !has(state, PICK)
    ) {
      await service().takeItem(state.session, SOCKS);
      await grantSupply(state, PICK);
      return page(
        "Brunon",
        "These socks are unbearable. Take this miner’s pick.",
      );
    }
    return null;
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted()) {
      if (npcId !== BOLTER)
        return page("Quest", "You are not on a quest that involves this NPC.");
      return Number(state.session.actor.fetchLevel()) < 2
        ? page("Bolter", "Come back after reaching level 2.")
        : page("Bolter", "I need a miner’s favor.", startLink());
    }

    const cond = state.getInt("cond");
    if (npcId === BOLTER) {
      if (cond === 1)
        return page("Bolter", "Please bring the four mining supplies.");
      for (const itemId of [LIST, ...REQUIRED]) await takeAll(state, itemId);
      await service().giveItem(state.session, NECKLACE, 1);
      state.playSound(SOUND_FINISH);
      await state.exit(false);
      return page(
        "Bolter",
        "Thank you. Please accept this Necklace of Knowledge.",
      );
    }
    if (cond !== 1) return page("Quest", "Return to Bolter.");

    if (npcId === SHARI) {
      if (has(state, POWDER))
        return page("Shari", "You already have the boomboom powder.");
      await grantSupply(state, POWDER);
      return page("Shari", "Here is the boomboom powder.");
    }
    if (npcId === GARITA) {
      if (has(state, BOOTS))
        return page("Garita", "You already have the mining boots.");
      await grantSupply(state, BOOTS);
      return page("Garita", "Here are the mining boots.");
    }
    if (npcId === REED) {
      if (has(state, BEER))
        return page("Reed", "You already have the Redstone beer.");
      await grantSupply(state, BEER);
      return page("Reed", "Here is the Redstone beer.");
    }
    if (npcId === BRUNON) {
      return has(state, PICK)
        ? page("Brunon", "You already have the miner’s pick.")
        : page(
            "Brunon",
            "I will trade a miner’s pick for Bolter’s smelly socks.",
            '<a action="bypass -h quest 5 pick">Give him the socks.</a>',
          );
    }
    return null;
  },
};
