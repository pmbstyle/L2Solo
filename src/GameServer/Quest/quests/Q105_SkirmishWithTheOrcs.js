const K = 7218,
  O1 = [1836, 1837, 1838, 1839],
  O2 = [1840, 1841, 1842, 1843],
  T1 = 1844,
  T2 = 1845,
  E = [4412, 4413, 4414, 4415, 4416];
const M1 = [5059, 5060, 5061, 5062],
  M2 = [5064, 5065, 5067, 5068];
const Q = () => invoke("GameServer/Quest/QuestService");
const p = (t, x, a = "") =>
  `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
const n = (s, id) =>
  s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 105,
  name: "Skirmish with the Orcs",
  npcs: [K],
  startNpcs: [K],
  killNpcs: [...M1, ...M2],
  eventNpc: (e) => (e === "start" ? K : null),
  async onEvent(s, e) {
    const a = s.session.actor;
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(a.fetchRace()) !== 1 ||
      Number(a.fetchLevel()) < 10
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    await Q().giveItem(s.session, O1[Math.floor(Math.random() * 4)], 1);
    s.playSound("ItemSound.quest_accept");
    return p("Kendell", "Defeat the chief named in my orders.");
  },
  async onTalk(s) {
    const a = s.session.actor,
      q = Q(),
      c = s.getInt("cond");
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return Number(a.fetchRace()) === 1 && Number(a.fetchLevel()) >= 10
        ? p(
            "Kendell",
            "Will you fight the Kaboo?",
            '<a action="bypass -h quest 105 start">Accept.</a>',
          )
        : p("Kendell", "Only elves of level 10 or higher.");
    if (c === 2) {
      for (const z of [...O1, T1]) await q.takeItem(s, z, -1);
      await q.giveItem(s.session, O2[Math.floor(Math.random() * 4)], 1);
      await s.set("cond", 3);
      s.playSound("ItemSound.quest_middle");
      return p("Kendell", "Now defeat another chief.");
    }
    if (c === 4) {
      for (const z of [...O2, T2]) await q.takeItem(s, z, -1);
      await q.giveItem(s.session, a.isSpellcaster?.() ? 754 : 981, 1);
      for (const z of E) await q.giveItem(s.session, z, 10);
      if (a.isNewbie?.())
        await q.giveItem(
          s.session,
          a.isSpellcaster?.() ? 5790 : 5789,
          a.isSpellcaster?.() ? 3000 : 7000,
        );
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Kendell", "The forest is safer now.");
    }
    return p("Kendell", "Continue your task.");
  },
  async onKill(s, m) {
    const c = s.getInt("cond"),
      id = Number(m.fetchSelfId());
    if (c === 1 && M1.includes(id) && n(s, id - 3223)) {
      await Q().giveItem(s.session, T1, 1);
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
    } else if (
      c === 3 &&
      M2.includes(id) &&
      n(s, id - (id < 5067 ? 3224 : 3225))
    ) {
      await Q().giveItem(s.session, T2, 1);
      await s.set("cond", 4);
      s.playSound("ItemSound.quest_middle");
    }
  },
};
