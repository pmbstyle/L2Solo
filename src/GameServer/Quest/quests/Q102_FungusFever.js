const A = 7284,
  C = 7156,
  N = [7217, 7219, 7221, 7285],
  L = 964,
  AM = 965,
  T = 966,
  LI = 746,
  M = [1130, 1131, 1132, 1133, 1134],
  E = [4412, 4413, 4414, 4415, 4416];
const Q = () => invoke("GameServer/Quest/QuestService");
const p = (t, x, a = "") =>
  `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
const n = (s, id) =>
  s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 102,
  name: "Fungus Fever",
  npcs: [A, C, ...N],
  startNpcs: [A],
  killNpcs: [13, 19],
  eventNpc: (e) => (e === "start" ? A : null),
  async onEvent(s, e) {
    const a = s.session.actor;
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(a.fetchRace()) !== 1 ||
      Number(a.fetchLevel()) < 12
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    await Q().giveItem(s.session, L, 1);
    s.playSound("ItemSound.quest_accept");
    return p("Alberius", "Take this letter to Cobendell.");
  },
  async onTalk(s, x) {
    const id = Number(x.fetchSelfId()),
      a = s.session.actor,
      q = Q(),
      c = s.getInt("cond");
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === A &&
        Number(a.fetchRace()) === 1 &&
        Number(a.fetchLevel()) >= 12
        ? p(
            "Alberius",
            "Will you cure the fever?",
            '<a action="bypass -h quest 102 start">Accept.</a>',
          )
        : p("Alberius", "Only level 12 elves may help.");
    if (id === C && c === 1) {
      await q.takeItem(s, L);
      await q.giveItem(s.session, AM, 1);
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
      return p("Cobendell", "Collect ten Dryad Tears.");
    }
    if (id === C && c === 3) {
      await q.takeItem(s, T, -1);
      await q.takeItem(s, AM);
      for (const z of M) await q.giveItem(s.session, z, 1);
      await s.set("cond", 4);
      s.playSound("ItemSound.quest_middle");
      return p("Cobendell", "Deliver the medicines.");
    }
    if (id === A && c === 4) {
      await q.takeItem(s, M[0]);
      await q.giveItem(s.session, LI, 1);
      await s.set("cond", 5);
      await s.set("medicines", 4);
      s.playSound("ItemSound.quest_middle");
      return p("Alberius", "Deliver the remaining medicines.");
    }
    if (N.includes(id) && c === 5) {
      const item = M[N.indexOf(id) + 1];
      if (n(s, item)) {
        await q.takeItem(s, item);
        const left = s.getInt("medicines") - 1;
        await s.set("medicines", left);
        if (!left) {
          await s.set("cond", 6);
          s.playSound("ItemSound.quest_middle");
        }
      }
      return p("Elf", "Thank you for the medicine.");
    }
    if (id === A && c === 6) {
      await q.takeItem(s, LI);
      await q.giveItem(s.session, a.isSpellcaster?.() ? 744 : 743, 1);
      await q.giveItem(
        s.session,
        a.isSpellcaster?.() ? 2509 : 1835,
        a.isSpellcaster?.() ? 500 : 1000,
      );
      for (const z of [1060, ...E])
        await q.giveItem(s.session, z, z === 1060 ? 100 : 10);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Alberius", "The fever has passed.");
    }
    return p("Quest", "Continue your task.");
  },
  async onKill(s) {
    if (s.getInt("cond") !== 2 || n(s, T) >= 10 || Math.random() >= 0.3) return;
    await Q().giveItem(s.session, T, 1);
    if (n(s, T) >= 10) {
      await s.set("cond", 3);
      s.playSound("ItemSound.quest_middle");
    } else s.playSound("ItemSound.quest_itemget");
  },
};
