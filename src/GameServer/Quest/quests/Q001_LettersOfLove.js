const DARIN = 7048;
const ROXXY = 7006;
const BAULRO = 7033;
const LETTER = 687;
const KERCHIEF = 688;
const RECEIPT = 1079;
const POTION = 1080;
const NECKLACE = 906;
const SOUND_ACCEPT = "ItemSound.quest_accept";
const SOUND_MIDDLE = "ItemSound.quest_middle";
const SOUND_FINISH = "ItemSound.quest_finish";

function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}

function startLink() {
  return '<a action="bypass -h quest 1 start">I will deliver the letter.</a>';
}

function service() {
  return invoke("GameServer/Quest/QuestService");
}

module.exports = {
  id: 1,
  name: "Letters of Love",
  npcs: [DARIN, ROXXY, BAULRO],
  startNpcs: [DARIN],
  eventNpc: (event) => (event === "start" ? DARIN : null),

  async onEvent(state, event) {
    if (event !== "start" || state.isCompleted() || state.isStarted())
      return null;
    if (Number(state.session.actor.fetchLevel()) < 2) return null;
    await state.setState("started");
    await state.set("cond", 1);
    state.playSound(SOUND_ACCEPT);
    await service().giveItem(state.session, LETTER, 1);
    return page("Darin", "Please deliver this letter to Gatekeeper Roxxy.");
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const level = Number(state.session.actor.fetchLevel());
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");

    if (!state.isStarted()) {
      return npcId === DARIN
        ? level < 2
          ? page("Darin", "Come back after reaching level 2.")
          : page("Darin", "Could you help me deliver a letter?", startLink())
        : page("Quest", "You are not on a quest that involves this NPC.");
    }

    const cond = state.getInt("cond");
    if (npcId === ROXXY) {
      if (cond === 1) {
        await service().takeItem(state.session, LETTER);
        await service().giveItem(state.session, KERCHIEF, 1);
        await state.set("cond", 2);
        state.playSound(SOUND_MIDDLE);
        return page("Roxxy", "Please give this handkerchief to Darin.");
      }
      return page("Roxxy", "Please return to Darin.");
    }
    if (npcId === DARIN) {
      if (cond === 1)
        return page("Darin", "Please deliver my letter to Roxxy.");
      if (cond === 2) {
        await service().takeItem(state.session, KERCHIEF);
        await service().giveItem(state.session, RECEIPT, 1);
        await state.set("cond", 3);
        state.playSound(SOUND_MIDDLE);
        return page("Darin", "Please take this receipt to Baulro.");
      }
      if (cond === 3) return page("Darin", "Please see Baulro.");
      if (cond === 4) {
        await service().takeItem(state.session, POTION);
        await service().giveItem(state.session, NECKLACE, 1);
        state.playSound(SOUND_FINISH);
        await state.exit(false);
        return page(
          "Darin",
          "Thank you. Please accept this Necklace of Knowledge.",
        );
      }
    }
    if (npcId === BAULRO) {
      if (cond === 3) {
        await service().takeItem(state.session, RECEIPT);
        await service().giveItem(state.session, POTION, 1);
        await state.set("cond", 4);
        state.playSound(SOUND_MIDDLE);
        return page("Baulro", "Please take this potion back to Darin.");
      }
      return page("Baulro", "Please deliver the potion to Darin.");
    }
    return null;
  },
};
