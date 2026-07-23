const SORIUS = 7327;
const KLUTO = 7317;

const TOPAZ_MOBS = [35, 42, 45, 51, 54, 60];
const OL_MAHUM_NOVICE = 782;

const SORIUS_LETTER = 1202;
const KLUTO_BOX = 1203;
const ELVEN_KNIGHT_BROOCH = 1204;
const TOPAZ_PIECE = 1205;
const EMERALD_PIECE = 1206;
const KLUTO_MEMO = 1276;

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

async function collect(state, selfId, needed, chance) {
  const current = count(state, selfId);
  if (current >= needed || Math.random() >= chance) return false;
  const amount = service().questDropAmount(1, needed, current);
  if (!amount) return false;
  await service().giveItem(state.session, selfId, amount);
  return current + amount >= needed;
}

module.exports = {
  id: 406,
  name: "Path to Elven Knight",
  npcs: [SORIUS, KLUTO],
  startNpcs: [SORIUS],
  killNpcs: [...TOPAZ_MOBS, OL_MAHUM_NOVICE],
  eventNpc: (event) => ({ start: SORIUS, kluto: KLUTO })[event] ?? null,

  async onEvent(state, event) {
    const quest = service();
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchClassId()) !== 18 || Number(actor.fetchLevel()) < 19 || count(state, ELVEN_KNIGHT_BROOCH)) return null;
      await state.setState("started");
      await state.set("cond", 1);
      state.playSound(ACCEPT);
      return page("Sorius", "Hunt skeletons and Spartoi in the Ruins of Agony for twenty Topaz Pieces.");
    }
    if (event === "kluto" && state.getInt("cond") === 3 && count(state, SORIUS_LETTER) && !count(state, KLUTO_MEMO)) {
      if (!(await quest.takeItem(state.session, SORIUS_LETTER))) return null;
      await quest.giveItem(state.session, KLUTO_MEMO, 1);
      await state.set("cond", 4);
      state.playSound(MIDDLE);
      return page("Kluto", "Bring me twenty Emerald Pieces from Ol Mahum Novices.");
    }
    return null;
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const quest = service();
    const cond = state.getInt("cond");

    if (state.isCompleted()) return page("Sorius", "You have already completed the Path to Elven Knight.");
    if (!state.isStarted()) {
      const actor = state.session.actor;
      if (npcId !== SORIUS || Number(actor.fetchClassId()) !== 18) return page("Quest", "This path is not for your current class.");
      if (count(state, ELVEN_KNIGHT_BROOCH)) return page("Sorius", "You have already earned the Elven Knight Brooch.");
      return Number(actor.fetchLevel()) < 19
        ? page("Sorius", "Come back after reaching level 19.")
        : page("Sorius", "Do you seek the path of an Elven Knight?", '<a action="bypass -h quest 406 start">Challenge the test.</a>');
    }

    if (npcId === SORIUS) {
      if (cond === 1) return page("Sorius", `Topaz Pieces: ${count(state, TOPAZ_PIECE)}/20.`);
      if (cond === 2) {
        if (!count(state, SORIUS_LETTER)) await quest.giveItem(state.session, SORIUS_LETTER, 1);
        await state.set("cond", 3);
        state.playSound(MIDDLE);
        return page("Sorius", "Take my letter to Blacksmith Kluto.");
      }
      if ([3, 4, 5].includes(cond)) return page("Sorius", "Complete Kluto's request.");
      if (cond === 6 && count(state, KLUTO_BOX)) {
        const profession = await quest.awardFirstProfession(state, 19);
        if (!profession.ok) {
          return page("Sorius", profession.reason === "level" ? `Reach level ${profession.requiredLevel} to become an Elven Knight.` : "Your profession could not be granted. Keep Kluto's Box and try again.");
        }
        await quest.takeItem(state.session, KLUTO_BOX, -1);
        if (!count(state, ELVEN_KNIGHT_BROOCH)) await quest.giveItem(state.session, ELVEN_KNIGHT_BROOCH, 1);
        state.playSound(FINISH);
        await state.exit(false);
        return page("Sorius", "You have completed the Path to Elven Knight and become an Elven Knight.");
      }
      return page("Sorius", "Continue your trial.");
    }

    if (npcId === KLUTO) {
      if (cond === 3 && count(state, SORIUS_LETTER)) return page("Kluto", "Will you accept my request?", '<a action="bypass -h quest 406 kluto">Ask about the favor.</a>');
      if (cond === 4) return page("Kluto", `Emerald Pieces: ${count(state, EMERALD_PIECE)}/20.`);
      if (cond === 5 && count(state, EMERALD_PIECE) >= 20 && count(state, TOPAZ_PIECE) >= 20 && count(state, KLUTO_MEMO)) {
        await quest.takeItem(state.session, EMERALD_PIECE, -1);
        await quest.takeItem(state.session, TOPAZ_PIECE, -1);
        await quest.takeItem(state.session, KLUTO_MEMO, -1);
        if (!count(state, KLUTO_BOX)) await quest.giveItem(state.session, KLUTO_BOX, 1);
        await state.set("cond", 6);
        state.playSound(MIDDLE);
        return page("Kluto", "Take this box to Sorius.");
      }
      if (cond === 6) return page("Kluto", "Take the box to Sorius.");
    }

    return page("Quest", "Continue your trial.");
  },

  async onKill(state, npc) {
    if (!state.isStarted()) return;
    const npcId = Number(npc.fetchSelfId());
    if (TOPAZ_MOBS.includes(npcId) && state.getInt("cond") === 1) {
      if (await collect(state, TOPAZ_PIECE, 20, 0.7)) {
        await state.set("cond", 2);
        state.playSound(MIDDLE);
      } else if (count(state, TOPAZ_PIECE)) state.playSound(ITEM);
    } else if (npcId === OL_MAHUM_NOVICE && state.getInt("cond") === 4) {
      if (await collect(state, EMERALD_PIECE, 20, 0.5)) {
        await state.set("cond", 5);
        state.playSound(MIDDLE);
      } else if (count(state, EMERALD_PIECE)) state.playSound(ITEM);
    }
  },
};
