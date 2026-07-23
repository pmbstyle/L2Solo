const REISA = 7328;
const BABENCO = 7334;
const MORETTI = 7337;
const PRIAS = 7426;

const OL_MAHUM_PATROL = 53;
const OL_MAHUM_SENTRY = 5031;

const REISAS_LETTER = 1207;
const TORN_LETTERS = [1208, 1209, 1210, 1211];
const MORETTIS_HERB = 1212;
const MORETTIS_LETTER = 1214;
const PRIAS_LETTER = 1215;
const HONORARY_GUARD = 1216;
const REISAS_RECOMMENDATION = 1217;
const RUSTED_KEY = 1293;

const ACCEPT = "ItemSound.quest_accept";
const ITEM = "ItemSound.quest_itemget";
const MIDDLE = "ItemSound.quest_middle";
const FINISH = "ItemSound.quest_finish";

function service() {
  return invoke("GameServer/Quest/QuestService");
}

function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}

function count(state, selfId) {
  return state.session.actor.backpack.fetchItemFromSelfId(selfId)?.fetchAmount() || 0;
}

function tornLetterCount(state) {
  return TORN_LETTERS.reduce((total, item) => total + Number(count(state, item) > 0), 0);
}

module.exports = {
  id: 407,
  name: "Path to Elven Scout",
  npcs: [REISA, BABENCO, MORETTI, PRIAS],
  startNpcs: [REISA],
  killNpcs: [OL_MAHUM_PATROL, OL_MAHUM_SENTRY],
  eventNpc: (event) => ({ start: REISA, moretti: MORETTI })[event] ?? null,

  async onEvent(state, event) {
    const quest = service();
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchClassId()) !== 18 || Number(actor.fetchLevel()) < 19 || count(state, REISAS_RECOMMENDATION)) return null;
      await state.setState("started");
      await state.set("cond", 1);
      await quest.giveItem(state.session, REISAS_LETTER, 1);
      state.playSound(ACCEPT);
      return page("Reisa", "Take my letter to Moretti.");
    }
    if (event === "moretti" && state.getInt("cond") === 1 && count(state, REISAS_LETTER) && tornLetterCount(state) === 0) {
      if (!(await quest.takeItem(state.session, REISAS_LETTER))) return null;
      await state.set("cond", 2);
      return page("Moretti", "Recover my four torn letters from Ol Mahum Patrols.");
    }
    return null;
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const quest = service();
    const cond = state.getInt("cond");

    if (state.isCompleted()) return page("Reisa", "You have already completed the Path to Elven Scout.");
    if (!state.isStarted()) {
      const actor = state.session.actor;
      if (npcId !== REISA || Number(actor.fetchClassId()) !== 18) return page("Quest", "This path is not for your current class.");
      if (count(state, REISAS_RECOMMENDATION)) return page("Reisa", "You have already earned my recommendation.");
      return Number(actor.fetchLevel()) < 19
        ? page("Reisa", "Come back after reaching level 19.")
        : page("Reisa", "Do you seek the path of an Elven Scout?", '<a action="bypass -h quest 407 start">Accept the trial.</a>');
    }

    if (npcId === REISA) {
      if (count(state, REISAS_LETTER)) return page("Reisa", "Take my letter to Moretti.");
      if (count(state, HONORARY_GUARD)) {
        const profession = await quest.awardFirstProfession(state, 22);
        if (!profession.ok) {
          return page("Reisa", profession.reason === "level" ? `Reach level ${profession.requiredLevel} to become an Elven Scout.` : "Your profession could not be granted. Keep the Honorary Guard and try again.");
        }
        await quest.takeItem(state.session, HONORARY_GUARD);
        await quest.giveItem(state.session, REISAS_RECOMMENDATION, 1);
        state.playSound(FINISH);
        await state.exit(false);
        return page("Reisa", "You have completed the Path to Elven Scout and become an Elven Scout.");
      }
      return page("Reisa", "Continue Moretti's trial.");
    }

    if (npcId === MORETTI) {
      if (count(state, REISAS_LETTER) && tornLetterCount(state) === 0) return page("Moretti", "Reisa sent you?", '<a action="bypass -h quest 407 moretti">Accept Moretti’s request.</a>');
      if (!count(state, MORETTIS_LETTER) && !count(state, PRIAS_LETTER) && !count(state, HONORARY_GUARD)) {
        const letters = tornLetterCount(state);
        if (!letters) return page("Moretti", "Recover my four torn letters from Ol Mahum Patrols.");
        if (letters < 4) return page("Moretti", `Torn letters: ${letters}/4.`);
        for (const item of TORN_LETTERS) await quest.takeItem(state.session, item);
        await quest.giveItem(state.session, MORETTIS_HERB, 1);
        await quest.giveItem(state.session, MORETTIS_LETTER, 1);
        await state.set("cond", 4);
        state.playSound(MIDDLE);
        return page("Moretti", "Take my herb and letter to Prias.");
      }
      if (count(state, PRIAS_LETTER)) {
        if (count(state, MORETTIS_HERB)) return page("Moretti", "Take the herb to Prias before returning.");
        await quest.takeItem(state.session, PRIAS_LETTER);
        await quest.giveItem(state.session, HONORARY_GUARD, 1);
        await state.set("cond", 8);
        state.playSound(MIDDLE);
        return page("Moretti", "Take this Honorary Guard to Reisa.");
      }
      if (count(state, HONORARY_GUARD)) return page("Moretti", "Take the Honorary Guard to Reisa.");
      return page("Moretti", "Continue your trial.");
    }

    if (npcId === BABENCO) return page("Babenco", "Ol Mahum Patrols roam east of Gludio.");

    if (npcId === PRIAS && count(state, MORETTIS_LETTER) && count(state, MORETTIS_HERB)) {
      if (!count(state, RUSTED_KEY)) {
        await state.set("cond", 5);
        return page("Prias", "Find the Rusted Key from an Ol Mahum Sentry.");
      }
      await quest.takeItem(state.session, RUSTED_KEY);
      await quest.takeItem(state.session, MORETTIS_HERB);
      await quest.takeItem(state.session, MORETTIS_LETTER);
      await quest.giveItem(state.session, PRIAS_LETTER, 1);
      await state.set("cond", 7);
      state.playSound(MIDDLE);
      return page("Prias", "Take my letter to Moretti.");
    }
    if (npcId === PRIAS && count(state, PRIAS_LETTER)) return page("Prias", "Take my letter to Moretti.");

    return page("Quest", "Continue your trial.");
  },

  async onKill(state, npc) {
    if (!state.isStarted() || state.getInt("cond") <= 0) return;
    const npcId = Number(npc.fetchSelfId());
    const quest = service();
    if (npcId === OL_MAHUM_PATROL && tornLetterCount(state) < 4) {
      const letter = TORN_LETTERS.find((item) => !count(state, item));
      if (!letter) return;
      await quest.giveItem(state.session, letter, 1);
      if (tornLetterCount(state) === 4) {
        await state.set("cond", 3);
        state.playSound(MIDDLE);
      } else state.playSound(ITEM);
    } else if (npcId === OL_MAHUM_SENTRY && count(state, MORETTIS_HERB) && count(state, MORETTIS_LETTER) && !count(state, RUSTED_KEY) && Math.random() < 0.6) {
      await quest.giveItem(state.session, RUSTED_KEY, 1);
      await state.set("cond", 6);
      state.playSound(MIDDLE);
    }
  },
};
