const FUNDIN = 8274;
const VULCAN = 8539;
const PACKAGE = 7263;
const SOUND_ACCEPT = "ItemSound.quest_accept";
const SOUND_FINISH = "ItemSound.quest_finish";
function service() {
  return invoke("GameServer/Quest/QuestService");
}
function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}
module.exports = {
  id: 13,
  name: "Parcel Delivery",
  npcs: [FUNDIN, VULCAN],
  startNpcs: [FUNDIN],
  eventNpc: (event) => ({ start: FUNDIN, reward: VULCAN })[event] ?? null,
  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchLevel()) >= 74) return null;
      await state.setState("started");
      await state.set("cond", 1);
      await service().giveItem(state.session, PACKAGE, 1);
      state.playSound(SOUND_ACCEPT);
      return page("Fundin", "Deliver this parcel to Vulcan.");
    }
    if (event === "reward" && state.isStarted() && state.getInt("cond") === 1) {
      if (!(await service().takeItem(state.session, PACKAGE))) return null;
      await service().rewardAdena(state.session, 82656);
      state.playSound(SOUND_FINISH);
      await state.exit(false);
      return page("Vulcan", "The parcel has arrived.");
    }
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted())
      return npcId === FUNDIN
        ? Number(actor.fetchLevel()) < 74
          ? page(
              "Fundin",
              "Will you deliver a parcel?",
              '<a action="bypass -h quest 13 start">Accept.</a>',
            )
          : page("Fundin", "This task is for adventurers below level 74.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    return npcId === FUNDIN
      ? page("Fundin", "Deliver the parcel to Vulcan.")
      : page(
          "Vulcan",
          "Have you brought Fundin’s parcel?",
          '<a action="bypass -h quest 13 reward">Deliver the parcel.</a>',
        );
  },
};
