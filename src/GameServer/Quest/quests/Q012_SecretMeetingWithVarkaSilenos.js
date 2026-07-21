const CADMON = 8296;
const HELMUT = 8258;
const NARAN_ASHANUK = 8378;
const MUNITIONS_BOX = 7232;
const SOUND_ACCEPT = "ItemSound.quest_accept";
const SOUND_MIDDLE = "ItemSound.quest_middle";
const SOUND_FINISH = "ItemSound.quest_finish";
function service() {
  return invoke("GameServer/Quest/QuestService");
}
function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}
module.exports = {
  id: 12,
  name: "Secret Meeting With Varka Silenos",
  npcs: [CADMON, HELMUT, NARAN_ASHANUK],
  startNpcs: [CADMON],
  eventNpc: (event) =>
    ({ start: CADMON, supplies: HELMUT, reward: NARAN_ASHANUK })[event] ?? null,
  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchLevel()) >= 74) return null;
      await state.setState("started");
      await state.set("cond", 1);
      state.playSound(SOUND_ACCEPT);
      return page("Cadmon", "Meet Helmut to collect the munitions.");
    }
    if (
      event === "supplies" &&
      state.isStarted() &&
      state.getInt("cond") === 1
    ) {
      await service().giveItem(state.session, MUNITIONS_BOX, 1);
      await state.set("cond", 2);
      state.playSound(SOUND_MIDDLE);
      return page("Helmut", "Deliver the box to Naran Ashanuk.");
    }
    if (event === "reward" && state.isStarted() && state.getInt("cond") === 2) {
      if (!(await service().takeItem(state.session, MUNITIONS_BOX)))
        return null;
      service().rewardExpSp(state.session, 79761, 0);
      state.playSound(SOUND_FINISH);
      await state.exit(false);
      return page("Naran Ashanuk", "The Varka Silenos thank you.");
    }
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted())
      return npcId === CADMON
        ? Number(actor.fetchLevel()) < 74
          ? page(
              "Cadmon",
              "I need a discreet courier.",
              '<a action="bypass -h quest 12 start">Accept.</a>',
            )
          : page("Cadmon", "This task is for adventurers below level 74.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    const cond = state.getInt("cond");
    if (npcId === CADMON) return page("Cadmon", "Meet Helmut.");
    if (npcId === HELMUT)
      return cond === 1
        ? page(
            "Helmut",
            "Take this munitions box.",
            '<a action="bypass -h quest 12 supplies">Receive the box.</a>',
          )
        : page("Helmut", "Deliver it to Naran Ashanuk.");
    return cond === 2
      ? page(
          "Naran Ashanuk",
          "Have you brought the box?",
          '<a action="bypass -h quest 12 reward">Deliver the box.</a>',
        )
      : page("Naran Ashanuk", "Speak with Helmut first.");
  },
};
