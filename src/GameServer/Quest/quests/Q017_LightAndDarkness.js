const HIERARCH = 8517;
const ALTARS = [8508, 8509, 8510, 8511];
const BLOOD = 7168;
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
  id: 17,
  name: "Light and Darkness",
  npcs: [HIERARCH, ...ALTARS],
  startNpcs: [HIERARCH],
  eventNpc(event) {
    if (event === "start") return HIERARCH;
    const step = Number(String(event).replace("altar", ""));
    return Number.isInteger(step) && step >= 1 && step <= ALTARS.length
      ? ALTARS[step - 1]
      : null;
  },
  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchLevel()) >= 61) return null;
      await state.setState("started");
      await state.set("cond", 1);
      await service().giveItem(state.session, BLOOD, 4);
      state.playSound(SOUND_ACCEPT);
      return page("Hierarch", "Consecrate the four Saint Altars in order.");
    }
    const step = Number(String(event).replace("altar", ""));
    if (
      Number.isInteger(step) &&
      step >= 1 &&
      step <= ALTARS.length &&
      state.isStarted() &&
      state.getInt("cond") === step
    ) {
      if (!(await service().takeItem(state.session, BLOOD))) return null;
      await state.set("cond", step + 1);
      state.playSound(SOUND_MIDDLE);
      return page(`Saint Altar ${step}`, "The altar has been consecrated.");
    }
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted())
      return npcId === HIERARCH
        ? Number(actor.fetchLevel()) < 61
          ? page(
              "Hierarch",
              "Will you bring light to the Saint Altars?",
              '<a action="bypass -h quest 17 start">Accept.</a>',
            )
          : page("Hierarch", "This task is for adventurers below level 61.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    const cond = state.getInt("cond");
    if (npcId === HIERARCH) {
      if (cond !== 5)
        return page("Hierarch", "Continue to the next Saint Altar.");
      service().rewardExpSp(state.session, 105527, 0);
      state.playSound(SOUND_FINISH);
      await state.exit(false);
      return page("Hierarch", "The Saint Altars shine again.");
    }
    const step = ALTARS.indexOf(npcId) + 1;
    if (cond === step)
      return page(
        `Saint Altar ${step}`,
        "Offer the Blood of a Saint.",
        `<a action="bypass -h quest 17 altar${step}">Consecrate the altar.</a>`,
      );
    return page(
      `Saint Altar ${step}`,
      cond > step
        ? "This altar is already consecrated."
        : "Consecrate the previous altar first.",
    );
  },
};
