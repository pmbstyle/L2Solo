const ZIGAUNT = 7022;
const GALLINT = 7017;
const VIVYAN = 7030;
const SIMPLON = 7253;
const PRAGA = 7333;
const LIONEL = 7408;

const RUIN_ZOMBIE = 26;
const RUIN_ZOMBIE_LEADER = 29;

const LETTER_OF_ORDER_1 = 1191;
const LETTER_OF_ORDER_2 = 1192;
const BOOK_OF_LIONEL = 1193;
const BOOK_OF_VIVYAN = 1194;
const BOOK_OF_SIMPLON = 1195;
const BOOK_OF_PRAGA = 1196;
const CERTIFICATE_OF_GALLINT = 1197;
const PENDANT_OF_MOTHER = 1198;
const NECKLACE_OF_MOTHER = 1199;
const LIONEL_COVENANT = 1200;
const MARK_OF_FAITH = 1201;

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

async function replace(state, remove, give, condition) {
  const quest = service();
  for (const item of remove) {
    if (!(await quest.takeItem(state.session, item))) return false;
  }
  await quest.giveItem(state.session, give, 1);
  await state.set("cond", condition);
  state.playSound(MIDDLE);
  return true;
}

module.exports = {
  id: 405,
  name: "Path to Cleric",
  npcs: [ZIGAUNT, GALLINT, VIVYAN, SIMPLON, PRAGA, LIONEL],
  startNpcs: [ZIGAUNT],
  killNpcs: [RUIN_ZOMBIE, RUIN_ZOMBIE_LEADER],
  eventNpc: (event) => (event === "start" ? ZIGAUNT : null),

  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event !== "start" || state.isStarted() || state.isCompleted()) return null;
    if (Number(actor.fetchClassId()) !== 10 || Number(actor.fetchLevel()) < 19 || count(state, MARK_OF_FAITH)) return null;
    await state.setState("started");
    await state.set("cond", 1);
    await service().giveItem(state.session, LETTER_OF_ORDER_1, 1);
    state.playSound(ACCEPT);
    return page("Zigaunt", "Bring books from Vivyan, Simplon, and Praga.");
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const quest = service();
    const cond = state.getInt("cond");

    if (state.isCompleted()) return page("Zigaunt", "You have already completed the Path to Cleric.");
    if (!state.isStarted()) {
      const actor = state.session.actor;
      if (npcId !== ZIGAUNT || Number(actor.fetchClassId()) !== 10) return page("Quest", "This path is not for your current class.");
      if (count(state, MARK_OF_FAITH)) return page("Zigaunt", "You have already earned the Mark of Faith.");
      return Number(actor.fetchLevel()) < 19
        ? page("Zigaunt", "Come back after reaching level 19.")
        : page("Zigaunt", "Do you seek the path of a Cleric?", '<a action="bypass -h quest 405 start">Accept the trial.</a>');
    }

    if (npcId === ZIGAUNT) {
      if (count(state, LETTER_OF_ORDER_2) && !count(state, LIONEL_COVENANT)) return page("Zigaunt", "Take the second Letter of Order to Lionel.");
      if (count(state, LETTER_OF_ORDER_1)) {
        const allBooks = count(state, BOOK_OF_VIVYAN) && count(state, BOOK_OF_SIMPLON) >= 3 && count(state, BOOK_OF_PRAGA);
        if (!allBooks) return page("Zigaunt", "Bring me the books of Vivyan, Simplon, and Praga.");
        await replace(state, [LETTER_OF_ORDER_1, BOOK_OF_VIVYAN, BOOK_OF_SIMPLON, BOOK_OF_SIMPLON, BOOK_OF_SIMPLON, BOOK_OF_PRAGA], LETTER_OF_ORDER_2, 3);
        return page("Zigaunt", "Take this second Letter of Order to Lionel.");
      }
      if (count(state, LETTER_OF_ORDER_2) && count(state, LIONEL_COVENANT)) {
        const profession = await quest.awardFirstProfession(state, 15);
        if (!profession.ok) {
          return page("Zigaunt", profession.reason === "level" ? `Reach level ${profession.requiredLevel} to become a Cleric.` : "Your profession could not be granted. Keep Lionel's Covenant and try again.");
        }
        await quest.takeItem(state.session, LETTER_OF_ORDER_2);
        await quest.takeItem(state.session, LIONEL_COVENANT);
        await quest.giveItem(state.session, MARK_OF_FAITH, 1);
        state.playSound(FINISH);
        await state.exit(false);
        return page("Zigaunt", "You have completed the Path to Cleric and become a Cleric.");
      }
      return page("Zigaunt", "Continue your trial.");
    }

    if (npcId === SIMPLON && cond > 0 && count(state, LETTER_OF_ORDER_1)) {
      if (!count(state, BOOK_OF_SIMPLON)) {
        await quest.giveItem(state.session, BOOK_OF_SIMPLON, 3);
        state.playSound(MIDDLE);
        return page("Simplon", "Take these books to Zigaunt.");
      }
      return page("Simplon", "You already have my books.");
    }

    if (npcId === VIVYAN && cond > 0 && count(state, LETTER_OF_ORDER_1)) {
      if (!count(state, BOOK_OF_VIVYAN)) {
        await quest.giveItem(state.session, BOOK_OF_VIVYAN, 1);
        state.playSound(MIDDLE);
        return page("Vivyan", "Take my book to Zigaunt.");
      }
      return page("Vivyan", "You already have my book.");
    }

    if (npcId === PRAGA && cond > 0 && count(state, LETTER_OF_ORDER_1)) {
      if (!count(state, BOOK_OF_PRAGA) && !count(state, NECKLACE_OF_MOTHER)) {
        await quest.giveItem(state.session, NECKLACE_OF_MOTHER, 1);
        state.playSound(MIDDLE);
        return page("Praga", "Find the Pendant of Mother from Ruin Zombies.");
      }
      if (!count(state, BOOK_OF_PRAGA) && count(state, NECKLACE_OF_MOTHER) && !count(state, PENDANT_OF_MOTHER)) return page("Praga", "Bring me the Pendant of Mother.");
      if (!count(state, BOOK_OF_PRAGA) && count(state, NECKLACE_OF_MOTHER) && count(state, PENDANT_OF_MOTHER)) {
        await replace(state, [NECKLACE_OF_MOTHER, PENDANT_OF_MOTHER], BOOK_OF_PRAGA, 2);
        return page("Praga", "Take my book to Zigaunt.");
      }
      return page("Praga", "You already have my book.");
    }

    if (npcId === LIONEL && cond > 0) {
      if (!count(state, LETTER_OF_ORDER_2)) return page("Lionel", "Return after receiving Zigaunt's second Letter of Order.");
      if (!count(state, BOOK_OF_LIONEL) && !count(state, LIONEL_COVENANT) && !count(state, CERTIFICATE_OF_GALLINT)) {
        await quest.giveItem(state.session, BOOK_OF_LIONEL, 1);
        await state.set("cond", 4);
        state.playSound(MIDDLE);
        return page("Lionel", "Bring this book to Gallint.");
      }
      if (count(state, BOOK_OF_LIONEL)) return page("Lionel", "Take my book to Gallint.");
      if (!count(state, LIONEL_COVENANT) && count(state, CERTIFICATE_OF_GALLINT)) {
        await replace(state, [CERTIFICATE_OF_GALLINT], LIONEL_COVENANT, 6);
        return page("Lionel", "Take my covenant to Zigaunt.");
      }
      return page("Lionel", "Take my covenant to Zigaunt.");
    }

    if (npcId === GALLINT && cond > 0 && count(state, LETTER_OF_ORDER_2) && !count(state, LIONEL_COVENANT)) {
      if (count(state, BOOK_OF_LIONEL) && !count(state, CERTIFICATE_OF_GALLINT)) {
        await replace(state, [BOOK_OF_LIONEL], CERTIFICATE_OF_GALLINT, 5);
        return page("Gallint", "Take this certificate back to Lionel.");
      }
      if (count(state, CERTIFICATE_OF_GALLINT)) return page("Gallint", "Take the certificate back to Lionel.");
    }

    return page("Quest", "Continue your trial.");
  },

  async onKill(state, npc) {
    if (!state.isStarted() || state.getInt("cond") <= 0 || count(state, PENDANT_OF_MOTHER)) return;
    if (![RUIN_ZOMBIE, RUIN_ZOMBIE_LEADER].includes(Number(npc.fetchSelfId()))) return;
    await service().giveItem(state.session, PENDANT_OF_MOTHER, 1);
    state.playSound(MIDDLE);
  },
};
