const VIRGIL = 7329, KALINTA = 7422;
const LYCANTHROPE = 49, POISON_SPIDER = 38, ARACHNID_TRACKER = 43;
const PALUS_TALISMAN = 1237, LYCANTHROPE_SKULL = 1238, VIRGILS_LETTER = 1239, MORTE_TALISMAN = 1240, PREDATOR_CARAPACE = 1241, TRIMDEN_SILK = 1242, COFFIN_ETERNAL_REST = 1243, GAZE_OF_ABYSS = 1244;
const ACCEPT = "ItemSound.quest_accept", ITEM = "ItemSound.quest_itemget", MIDDLE = "ItemSound.quest_middle", FINISH = "ItemSound.quest_finish";
const service = () => invoke("GameServer/Quest/QuestService");
const page = (title, text, action = "") => `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
const count = (state, id) => state.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;

module.exports = {
  id: 410, name: "Path to Palus Knight", npcs: [VIRGIL, KALINTA], startNpcs: [VIRGIL], killNpcs: [LYCANTHROPE, POISON_SPIDER, ARACHNID_TRACKER],
  eventNpc: (event) => ({ start: VIRGIL, skulls: VIRGIL, morte: KALINTA, coffin: KALINTA })[event] ?? null,
  async onEvent(state, event) {
    const quest = service(), actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchClassId()) !== 31 || Number(actor.fetchLevel()) < 19 || count(state, GAZE_OF_ABYSS)) return null;
      await state.setState("started"); await state.set("cond", 1); await quest.giveItem(state.session, PALUS_TALISMAN, 1); state.playSound(ACCEPT);
      return page("Virgil", "Bring me thirteen Lycanthrope Skulls.");
    }
    if (event === "skulls" && state.getInt("cond") === 2 && count(state, PALUS_TALISMAN) && count(state, LYCANTHROPE_SKULL) >= 13) {
      await quest.takeItem(state.session, PALUS_TALISMAN); await quest.takeItem(state.session, LYCANTHROPE_SKULL, -1); await quest.giveItem(state.session, VIRGILS_LETTER, 1); await state.set("cond", 3); state.playSound(MIDDLE);
      return page("Virgil", "Take my letter to Kalinta.");
    }
    if (event === "morte" && state.getInt("cond") === 3 && count(state, VIRGILS_LETTER)) {
      await quest.takeItem(state.session, VIRGILS_LETTER); await quest.giveItem(state.session, MORTE_TALISMAN, 1); await state.set("cond", 4); state.playSound(MIDDLE);
      return page("Kalinta", "Bring five Arachnid Tracker Silks and a Predator's Carapace.");
    }
    if (event === "coffin" && state.getInt("cond") === 5 && count(state, MORTE_TALISMAN) && count(state, TRIMDEN_SILK) >= 5 && count(state, PREDATOR_CARAPACE)) {
      for (const id of [MORTE_TALISMAN, TRIMDEN_SILK, PREDATOR_CARAPACE]) await quest.takeItem(state.session, id, -1);
      await quest.giveItem(state.session, COFFIN_ETERNAL_REST, 1); await state.set("cond", 6); state.playSound(MIDDLE);
      return page("Kalinta", "Take the Coffin of Eternal Rest to Virgil.");
    }
    return null;
  },
  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId()), quest = service(), cond = state.getInt("cond");
    if (state.isCompleted()) return page("Virgil", "You have already completed the Path to Palus Knight.");
    if (!state.isStarted()) { const actor = state.session.actor; if (npcId !== VIRGIL || Number(actor.fetchClassId()) !== 31) return page("Quest", "This path is not for your current class."); return Number(actor.fetchLevel()) < 19 ? page("Virgil", "Come back after reaching level 19.") : page("Virgil", "Do you seek the path of a Palus Knight?", '<a action="bypass -h quest 410 start">Accept the trial.</a>'); }
    if (npcId === VIRGIL) {
      if (count(state, PALUS_TALISMAN)) return count(state, LYCANTHROPE_SKULL) >= 13 ? page("Virgil", "You have all the skulls.", '<a action="bypass -h quest 410 skulls">Present the skulls.</a>') : page("Virgil", `Lycanthrope Skulls: ${count(state, LYCANTHROPE_SKULL)}/13.`);
      if (count(state, COFFIN_ETERNAL_REST)) { const result = await quest.awardFirstProfession(state, 32); if (!result.ok) return page("Virgil", "Your profession could not be granted. Keep the coffin and try again."); await quest.takeItem(state.session, COFFIN_ETERNAL_REST); await quest.giveItem(state.session, GAZE_OF_ABYSS, 1); state.playSound(FINISH); await state.exit(false); return page("Virgil", "You have completed the Path to Palus Knight and become a Palus Knight."); }
      return page("Virgil", "Complete Kalinta's request.");
    }
    if (npcId === KALINTA) {
      if (count(state, VIRGILS_LETTER)) return page("Kalinta", "Virgil sent you?", '<a action="bypass -h quest 410 morte">Accept Kalinta’s request.</a>');
      if (count(state, MORTE_TALISMAN)) return count(state, TRIMDEN_SILK) >= 5 && count(state, PREDATOR_CARAPACE) ? page("Kalinta", "You have the required trophies.", '<a action="bypass -h quest 410 coffin">Receive the coffin.</a>') : page("Kalinta", `Arachnid Tracker Silk: ${count(state, TRIMDEN_SILK)}/5; Predator's Carapace: ${count(state, PREDATOR_CARAPACE)}/1.`);
    }
    return page("Quest", "Continue your trial.");
  },
  async onKill(state, npc) {
    if (!state.isStarted()) return; const id = Number(npc.fetchSelfId()), quest = service();
    if (id === LYCANTHROPE && count(state, PALUS_TALISMAN) && count(state, LYCANTHROPE_SKULL) < 13) { await quest.giveItem(state.session, LYCANTHROPE_SKULL, 1); if (count(state, LYCANTHROPE_SKULL) === 13) { await state.set("cond", 2); state.playSound(MIDDLE); } else state.playSound(ITEM); }
    if (id === POISON_SPIDER && count(state, MORTE_TALISMAN) && !count(state, PREDATOR_CARAPACE)) { await quest.giveItem(state.session, PREDATOR_CARAPACE, 1); if (count(state, TRIMDEN_SILK) >= 5) await state.set("cond", 5); state.playSound(MIDDLE); }
    if (id === ARACHNID_TRACKER && count(state, MORTE_TALISMAN) && count(state, TRIMDEN_SILK) < 5) { await quest.giveItem(state.session, TRIMDEN_SILK, 1); if (count(state, TRIMDEN_SILK) === 5) { if (count(state, PREDATOR_CARAPACE)) await state.set("cond", 5); state.playSound(MIDDLE); } else state.playSound(ITEM); }
  },
};
