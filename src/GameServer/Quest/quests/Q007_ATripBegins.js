const MIRABEL = 7146;
const ARIEL = 7148;
const ASTERIOS = 7154;
const ARIEL_RECOMMENDATION = 7572;
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
function hasRecommendation(state) {
  return (
    (state.session.actor.backpack
      .fetchItemFromSelfId(ARIEL_RECOMMENDATION)
      ?.fetchAmount() || 0) > 0
  );
}

module.exports = {
  id: 7,
  name: "A Trip Begins",
  npcs: [MIRABEL, ARIEL, ASTERIOS],
  startNpcs: [MIRABEL],
  eventNpc: (event) => {
    if (event === "start" || event === "reward") return MIRABEL;
    if (event === "recommendation") return ARIEL;
    if (event === "deliver") return ASTERIOS;
    return null;
  },

  async onEvent(state, event) {
    const Quest = service();
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchRace()) !== 1 || Number(actor.fetchLevel()) < 3)
        return null;
      await state.setState("started");
      await state.set("cond", 1);
      state.playSound(SOUND_ACCEPT);
      return page("Mirabel", "Speak with Ariel before you begin your journey.");
    }
    if (
      event === "recommendation" &&
      state.isStarted() &&
      state.getInt("cond") === 1
    ) {
      await state.set("cond", 2);
      await Quest.giveItem(state.session, ARIEL_RECOMMENDATION, 1);
      state.playSound(SOUND_MIDDLE);
      return page("Ariel", "Take this recommendation to Asterios.");
    }
    if (
      event === "deliver" &&
      state.isStarted() &&
      state.getInt("cond") === 2
    ) {
      if (!hasRecommendation(state))
        return page("Asterios", "You do not have Ariel’s recommendation.");
      await Quest.takeItem(state.session, ARIEL_RECOMMENDATION);
      await state.set("cond", 3);
      state.playSound(SOUND_MIDDLE);
      return page("Asterios", "Return to Mirabel.");
    }
    if (event === "reward" && state.isStarted() && state.getInt("cond") === 3) {
      await Quest.giveItem(state.session, MARK_OF_TRAVELER, 1);
      await Quest.giveItem(state.session, SOE_GIRAN, 1);
      state.playSound(SOUND_FINISH);
      await state.exit(false);
      return page("Mirabel", "Your journey may now begin.");
    }
    return null;
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted()) {
      if (npcId !== MIRABEL)
        return page("Quest", "You are not on a quest that involves this NPC.");
      if (Number(actor.fetchRace()) !== 1)
        return page("Mirabel", "This journey is for Elves only.");
      if (Number(actor.fetchLevel()) < 3)
        return page("Mirabel", "Come back after reaching level 3.");
      return page(
        "Mirabel",
        "Would you like to begin your journey?",
        '<a action="bypass -h quest 7 start">Begin.</a>',
      );
    }

    const cond = state.getInt("cond");
    if (npcId === MIRABEL) {
      if (cond < 3)
        return page("Mirabel", "Please speak with Ariel and Asterios.");
      return page(
        "Mirabel",
        "Welcome back.",
        '<a action="bypass -h quest 7 reward">Receive the traveler’s mark.</a>',
      );
    }
    if (npcId === ARIEL) {
      return cond === 1
        ? page(
            "Ariel",
            "I can prepare a recommendation for Asterios.",
            '<a action="bypass -h quest 7 recommendation">Take the recommendation.</a>',
          )
        : page("Ariel", "Please continue to Asterios.");
    }
    if (npcId === ASTERIOS) {
      return cond === 2
        ? page(
            "Asterios",
            "Do you have Ariel’s recommendation?",
            '<a action="bypass -h quest 7 deliver">Deliver the recommendation.</a>',
          )
        : page("Asterios", "Return to Mirabel.");
    }
    return null;
  },
};
