const MANUEL = 7293;
const ALLANA = 7424;
const PERRIN = 7428;

const LIZARDMAN_WARRIOR = 5032;
const LIZARDMAN_SCOUT = 5033;
const LIZARDMAN = 5034;
const TAMATO = 5035;

const CRYSTAL_MEDALLION = 1231;
const MONEY_OF_SWINDLER = 1232;
const DIARY_OF_ALLANA = 1233;
const LIZARD_CAPTAIN_ORDER = 1234;
const LEAF_OF_ORACLE = 1235;
const HALF_OF_DIARY = 1236;
const TAMATOS_NECKLACE = 1275;

const ACCEPT = "ItemSound.quest_accept";
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

module.exports = {
  id: 409,
  name: "Path to Elven Oracle",
  npcs: [MANUEL, ALLANA, PERRIN],
  startNpcs: [MANUEL],
  killNpcs: [LIZARDMAN_WARRIOR, LIZARDMAN_SCOUT, LIZARDMAN, TAMATO],
  questSpawns: [LIZARDMAN_WARRIOR, LIZARDMAN_SCOUT, LIZARDMAN, TAMATO],
  eventNpc: (event) => ({ start: MANUEL, lizardmen: ALLANA, tamato: PERRIN })[event] ?? null,

  async onEvent(state, event) {
    const quest = service();
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchClassId()) !== 25 || Number(actor.fetchLevel()) < 19 || count(state, LEAF_OF_ORACLE)) return null;
      await state.setState("started");
      await state.set("cond", 1);
      await quest.giveItem(state.session, CRYSTAL_MEDALLION, 1);
      state.playSound(ACCEPT);
      return page("Manuel", "Investigate the false prophet Allana.");
    }
    // The spawned captain can be killed by another player before its owner
    // reaches it.  Keep the encounter retryable until the captain's order is
    // actually obtained (as in the source quest), rather than stranding the
    // owner at condition 2.
    if (event === "lizardmen" && state.isStarted() && count(state, CRYSTAL_MEDALLION) && !count(state, LIZARD_CAPTAIN_ORDER)) {
      for (const selfId of [LIZARDMAN_WARRIOR, LIZARDMAN_SCOUT, LIZARDMAN]) state.addSpawn(selfId);
      await state.set("cond", 2);
      return page("Allana", "The lizardmen have appeared. Defend Allana.");
    }
    if (event === "tamato" && state.getInt("cond") >= 4 && count(state, LIZARD_CAPTAIN_ORDER) && !count(state, TAMATOS_NECKLACE)) {
      state.addSpawn(TAMATO);
      return page("Perrin", "Tamato is coming to defend Perrin.");
    }
    return null;
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const quest = service();
    const cond = state.getInt("cond");

    if (state.isCompleted()) return page("Manuel", "You have already completed the Path to Elven Oracle.");
    if (!state.isStarted()) {
      const actor = state.session.actor;
      if (npcId !== MANUEL || Number(actor.fetchClassId()) !== 25) return page("Quest", "This path is not for your current class.");
      if (count(state, LEAF_OF_ORACLE)) return page("Manuel", "You have already earned the Leaf of Oracle.");
      return Number(actor.fetchLevel()) < 19
        ? page("Manuel", "Come back after reaching level 19.")
        : page("Manuel", "Do you seek the path of an Elven Oracle?", '<a action="bypass -h quest 409 start">Accept the trial.</a>');
    }

    if (npcId === MANUEL) {
      if (count(state, MONEY_OF_SWINDLER) && count(state, DIARY_OF_ALLANA) && count(state, LIZARD_CAPTAIN_ORDER) && !count(state, HALF_OF_DIARY)) {
        const profession = await quest.awardFirstProfession(state, 29);
        if (!profession.ok) return page("Manuel", profession.reason === "level" ? `Reach level ${profession.requiredLevel} to become an Elven Oracle.` : "Your profession could not be granted. Keep the evidence and try again.");
        for (const item of [MONEY_OF_SWINDLER, DIARY_OF_ALLANA, LIZARD_CAPTAIN_ORDER, CRYSTAL_MEDALLION]) await quest.takeItem(state.session, item);
        await quest.giveItem(state.session, LEAF_OF_ORACLE, 1);
        state.playSound(FINISH);
        await state.exit(false);
        return page("Manuel", "You have completed the Path to Elven Oracle and become an Elven Oracle.");
      }
      return page("Manuel", "Bring me Allana's diary, Perrin's money, and the Lizard Captain's Order.");
    }

    if (npcId === ALLANA && count(state, CRYSTAL_MEDALLION)) {
      if (!count(state, LIZARD_CAPTAIN_ORDER) && !count(state, HALF_OF_DIARY)) {
        if (cond > 2) return page("Allana", "You have driven the lizardmen away.");
        return page("Allana", "The lizardmen are threatening me.", '<a action="bypass -h quest 409 lizardmen">Defend Allana.</a>');
      }
      if (count(state, LIZARD_CAPTAIN_ORDER) && !count(state, HALF_OF_DIARY)) {
        await quest.giveItem(state.session, HALF_OF_DIARY, 1);
        await state.set("cond", 4);
        state.playSound(MIDDLE);
        return page("Allana", "Take this half of my diary and confront Perrin.");
      }
      if (count(state, MONEY_OF_SWINDLER) && count(state, LIZARD_CAPTAIN_ORDER) && count(state, HALF_OF_DIARY) && !count(state, DIARY_OF_ALLANA)) {
        await quest.takeItem(state.session, HALF_OF_DIARY);
        await quest.giveItem(state.session, DIARY_OF_ALLANA, 1);
        await state.set("cond", 7);
        state.playSound(MIDDLE);
        return page("Allana", "Take my complete diary to Manuel.");
      }
      if (count(state, LIZARD_CAPTAIN_ORDER) && count(state, HALF_OF_DIARY) && !count(state, TAMATOS_NECKLACE)) return page("Allana", "Perrin owes me money. Please find him.");
      return page("Allana", "Continue your investigation.");
    }

    if (npcId === PERRIN && count(state, CRYSTAL_MEDALLION) && count(state, LIZARD_CAPTAIN_ORDER)) {
      if (count(state, TAMATOS_NECKLACE)) {
        await quest.giveItem(state.session, MONEY_OF_SWINDLER, 1);
        await quest.takeItem(state.session, TAMATOS_NECKLACE);
        await state.set("cond", 6);
        state.playSound(MIDDLE);
        return page("Perrin", "Take the money to Allana.");
      }
      if (count(state, MONEY_OF_SWINDLER)) return page("Perrin", "I have already paid Allana.");
      return page("Perrin", "You will not get Allana's money.", '<a action="bypass -h quest 409 tamato">Challenge Tamato.</a>');
    }

    return page("Quest", "Continue your trial.");
  },

  async onKill(state, npc) {
    if (!state.isStarted()) return;
    const npcId = Number(npc.fetchSelfId());
    const quest = service();
    if (npcId === LIZARDMAN_WARRIOR && !count(state, LIZARD_CAPTAIN_ORDER)) {
      await quest.giveItem(state.session, LIZARD_CAPTAIN_ORDER, 1);
      await state.set("cond", 3);
      state.playSound(MIDDLE);
    } else if (npcId === TAMATO && !count(state, TAMATOS_NECKLACE)) {
      await quest.giveItem(state.session, TAMATOS_NECKLACE, 1);
      await state.set("cond", 5);
      state.playSound(MIDDLE);
    }
  },
};
