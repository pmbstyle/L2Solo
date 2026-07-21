const H = 7568,
  P = 7580,
  O = [1553, 1554, 1555],
  L = [1557, 1556, 1558],
  W = 1510,
  HP = 1060,
  E = [4412, 4413, 4414, 4415, 4416];
const Q = () => invoke("GameServer/Quest/QuestService");
const p = (t, x, a = "") =>
  `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
module.exports = {
  id: 107,
  name: "Merciless Punishment",
  npcs: [H, P],
  startNpcs: [H],
  killNpcs: [5041],
  eventNpc: (e) => (e === "start" ? H : null),
  async onEvent(s, e) {
    const a = s.session.actor;
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(a.fetchRace()) !== 3 ||
      Number(a.fetchLevel()) < 12
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    await Q().giveItem(s.session, O[0], 1);
    s.playSound("ItemSound.quest_accept");
    return p("Hatos", "Ask Parugon about the messenger.");
  },
  async onTalk(s, x) {
    const id = Number(x.fetchSelfId()),
      a = s.session.actor,
      q = Q(),
      c = s.getInt("cond");
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === H &&
        Number(a.fetchRace()) === 3 &&
        Number(a.fetchLevel()) >= 12
        ? p(
            "Hatos",
            "Will you punish the traitor?",
            '<a action="bypass -h quest 107 start">Accept.</a>',
          )
        : p("Hatos", "Only level 12 orcs may help.");
    if (id === P && c === 1) {
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
      return p("Parugon", "Find Baranka's messenger.");
    }
    if (id === H && [3, 5].includes(c)) {
      const i = c === 3 ? 1 : 2;
      await q.takeItem(s, O[i - 1], -1);
      await q.takeItem(s, L[i - 1], -1);
      await q.giveItem(s.session, O[i], 1);
      await s.set("cond", c + 1);
      s.playSound("ItemSound.quest_middle");
      return p("Hatos", "The next target awaits.");
    }
    if (id === H && c === 7) {
      for (const z of [...O, ...L]) await q.takeItem(s, z, -1);
      for (const [z, c] of [[W, 1], [HP, 100], ...E.map((z) => [z, 10])])
        await q.giveItem(s.session, z, c);
      if (a.isNewbie?.())
        await q.giveItem(
          s.session,
          a.isSpellcaster?.() ? 5790 : 5789,
          a.isSpellcaster?.() ? 3000 : 6000,
        );
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Hatos", "You have served the tribe.");
    }
    return p(id === P ? "Parugon" : "Hatos", "Continue your task.");
  },
  async onKill(s) {
    const c = s.getInt("cond");
    if (![2, 4, 6].includes(c)) return;
    const i = (c - 2) / 2;
    await Q().giveItem(s.session, L[i], 1);
    await s.set("cond", c + 1);
    s.playSound("ItemSound.quest_middle");
  },
};
