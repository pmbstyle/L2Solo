const ABERCROMBIE = 8555;
const MONUMENTS = [8661, 8662, 8663, 8664];
const CORPSE_OF_DWARF = 8665;
const KRORIN_JOURNAL = 7252;
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
  id: 31,
  name: "Secret Buried in the Swamp",
  npcs: [ABERCROMBIE, CORPSE_OF_DWARF, ...MONUMENTS],
  startNpcs: [ABERCROMBIE],
  eventNpc(event) {
    if (event === "start" || event === "report" || event === "reward")
      return ABERCROMBIE;
    if (event === "journal") return CORPSE_OF_DWARF;
    const step = Number(String(event).replace("monument", ""));
    return Number.isInteger(step) && step >= 1 && step <= MONUMENTS.length
      ? MONUMENTS[step - 1]
      : null;
  },
  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchLevel()) >= 66) return null;
      await state.setState("started");
      await state.set("cond", 1);
      state.playSound(SOUND_ACCEPT);
      return page("Abercrombie", "Examine the Dwarf’s corpse in the swamp.");
    }
    if (
      event === "journal" &&
      state.isStarted() &&
      state.getInt("cond") === 1
    ) {
      await service().giveItem(state.session, KRORIN_JOURNAL, 1);
      await state.set("cond", 2);
      state.playSound(SOUND_MIDDLE);
      return page("Corpse of a Dwarf", "You find Krorin’s journal.");
    }
    if (event === "report" && state.isStarted() && state.getInt("cond") === 2) {
      await state.set("cond", 3);
      state.playSound(SOUND_MIDDLE);
      return page(
        "Abercrombie",
        "Follow the four forgotten monuments in order.",
      );
    }
    const step = Number(String(event).replace("monument", ""));
    if (
      Number.isInteger(step) &&
      step >= 1 &&
      step <= MONUMENTS.length &&
      state.isStarted() &&
      state.getInt("cond") === step + 2
    ) {
      await state.set("cond", step + 3);
      state.playSound(SOUND_MIDDLE);
      return page(
        `Forgotten Monument ${step}`,
        "The inscription reveals another part of the secret.",
      );
    }
    if (event === "reward" && state.isStarted() && state.getInt("cond") === 7) {
      if (!(await service().takeItem(state.session, KRORIN_JOURNAL)))
        return null;
      await service().rewardAdena(state.session, 40000);
      service().rewardExpSp(state.session, 130000, 0);
      state.playSound(SOUND_FINISH);
      await state.exit(false);
      return page("Abercrombie", "The secret of the swamp is safe again.");
    }
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted())
      return npcId === ABERCROMBIE
        ? Number(actor.fetchLevel()) < 66
          ? page(
              "Abercrombie",
              "There is a secret buried in the swamp.",
              '<a action="bypass -h quest 31 start">Accept.</a>',
            )
          : page("Abercrombie", "This task is for adventurers below level 66.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    const cond = state.getInt("cond");
    if (npcId === ABERCROMBIE) {
      if (cond === 2)
        return page(
          "Abercrombie",
          "Show me the journal.",
          '<a action="bypass -h quest 31 report">Report your discovery.</a>',
        );
      if (cond === 7)
        return page(
          "Abercrombie",
          "You have followed every monument.",
          '<a action="bypass -h quest 31 reward">Receive the reward.</a>',
        );
      return page(
        "Abercrombie",
        cond === 1
          ? "Examine the Dwarf’s corpse."
          : "Continue to the next forgotten monument.",
      );
    }
    if (npcId === CORPSE_OF_DWARF)
      return cond === 1
        ? page(
            "Corpse of a Dwarf",
            "There is a journal in its hand.",
            '<a action="bypass -h quest 31 journal">Take the journal.</a>',
          )
        : page("Corpse of a Dwarf", "You have already examined the corpse.");
    const step = MONUMENTS.indexOf(npcId) + 1;
    if (cond === step + 2)
      return page(
        `Forgotten Monument ${step}`,
        "Read the inscription.",
        `<a action="bypass -h quest 31 monument${step}">Examine the monument.</a>`,
      );
    return page(
      `Forgotten Monument ${step}`,
      cond > step + 2
        ? "You have already examined this monument."
        : "Examine the previous monument first.",
    );
  },
};
