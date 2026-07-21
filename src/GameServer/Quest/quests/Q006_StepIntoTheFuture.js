const ROXXY = 7006;
const BAULRO = 7033;
const SIR_COLLIN = 7311;
const BAULRO_LETTER = 7571;
const MARK_OF_TRAVELER = 7570;
const SOE_GIRAN = 7559;
const SOUND_ACCEPT = "ItemSound.quest_accept";
const SOUND_MIDDLE = "ItemSound.quest_middle";
const SOUND_FINISH = "ItemSound.quest_finish";

function service() {
  return invoke("GameServer/Quest/QuestService");
}
function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}
function hasLetter(state) {
  return (
    (state.session.actor.backpack
      .fetchItemFromSelfId(BAULRO_LETTER)
      ?.fetchAmount() || 0) > 0
  );
}

module.exports = {
  id: 6,
  name: "Step into the Future",
  npcs: [ROXXY, BAULRO, SIR_COLLIN],
  startNpcs: [ROXXY],
  eventNpc: (event) => {
    if (event === "start" || event === "reward") return ROXXY;
    if (event === "letter") return BAULRO;
    if (event === "deliver") return SIR_COLLIN;
    return null;
  },

  async onEvent(state, event) {
    const Quest = service();
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchRace()) !== 0 || Number(actor.fetchLevel()) < 3)
        return null;
      await state.setState("started");
      await state.set("cond", 1);
      state.playSound(SOUND_ACCEPT);
      return page("Roxxy", "Speak with Magister Baulro about your journey.");
    }
    if (event === "letter" && state.isStarted() && state.getInt("cond") === 1) {
      await state.set("cond", 2);
      await Quest.giveItem(state.session, BAULRO_LETTER, 1);
      state.playSound(SOUND_MIDDLE);
      return page("Baulro", "Deliver this letter to Sir Collin in Giran.");
    }
    if (
      event === "deliver" &&
      state.isStarted() &&
      state.getInt("cond") === 2
    ) {
      if (!hasLetter(state))
        return page("Sir Collin", "You do not have Baulro’s letter.");
      await Quest.takeItem(state.session, BAULRO_LETTER);
      await state.set("cond", 3);
      state.playSound(SOUND_MIDDLE);
      return page("Sir Collin", "Return to Roxxy.");
    }
    if (event === "reward" && state.isStarted() && state.getInt("cond") === 3) {
      await Quest.giveItem(state.session, MARK_OF_TRAVELER, 1);
      await Quest.giveItem(state.session, SOE_GIRAN, 1);
      state.playSound(SOUND_FINISH);
      await state.exit(false);
      return page("Roxxy", "You are ready to step into the future.");
    }
    return null;
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted()) {
      if (npcId !== ROXXY)
        return page("Quest", "You are not on a quest that involves this NPC.");
      if (Number(actor.fetchRace()) !== 0 || Number(actor.fetchLevel()) < 3)
        return page(
          "Roxxy",
          "This journey is for Humans of level 3 or higher.",
        );
      return page(
        "Roxxy",
        "Would you like to begin your journey?",
        '<a action="bypass -h quest 6 start">Begin.</a>',
      );
    }

    const cond = state.getInt("cond");
    if (npcId === ROXXY) {
      if (cond < 3)
        return page("Roxxy", "Please speak with Baulro and Sir Collin.");
      return page(
        "Roxxy",
        "Welcome back.",
        '<a action="bypass -h quest 6 reward">Receive the traveler’s mark.</a>',
      );
    }
    if (npcId === BAULRO) {
      return cond === 1
        ? page(
            "Baulro",
            "I have a letter for Sir Collin.",
            '<a action="bypass -h quest 6 letter">Take the letter.</a>',
          )
        : page("Baulro", "Please continue to Sir Collin.");
    }
    if (npcId === SIR_COLLIN) {
      return cond === 2
        ? page(
            "Sir Collin",
            "Do you have Baulro’s letter?",
            '<a action="bypass -h quest 6 deliver">Deliver the letter.</a>',
          )
        : page("Sir Collin", "Return to Roxxy.");
    }
    return null;
  },
};
