const K = 7307,
  C = 7132,
  H = 7144,
  L = 968,
  V1 = 969,
  V2 = 970,
  S = 971,
  O = 972,
  Z = 973,
  ST = 974,
  B = 1107,
  W = 975,
  HP = 1060,
  E = [4412, 4413, 4414, 4415, 4416];
const Q = () => invoke("GameServer/Quest/QuestService");
const p = (t, x, a = "") =>
  `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
const n = (s, id) =>
  s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 103,
  name: "Spirit of Craftsman",
  npcs: [K, C, H],
  startNpcs: [K],
  killNpcs: [15, 20, 455, 517, 518],
  eventNpc: (e) => (e === "start" ? K : null),
  async onEvent(s, e) {
    const a = s.session.actor;
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(a.fetchRace()) !== 2 ||
      Number(a.fetchLevel()) < 11
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    await Q().giveItem(s.session, L, 1);
    s.playSound("ItemSound.quest_accept");
    return p("Karrod", "Take this letter to Cekton.");
  },
  async onTalk(s, x) {
    const id = Number(x.fetchSelfId()),
      a = s.session.actor,
      q = Q(),
      c = s.getInt("cond");
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === K &&
        Number(a.fetchRace()) === 2 &&
        Number(a.fetchLevel()) >= 11
        ? p(
            "Karrod",
            "Will you aid the craftsman?",
            '<a action="bypass -h quest 103 start">Accept.</a>',
          )
        : p("Karrod", "Only level 11 dark elves may help.");
    const step = async (take, give, next) => {
      for (const z of take) await q.takeItem(s, z);
      for (const z of give) await q.giveItem(s.session, z, 1);
      await s.set("cond", next);
      s.playSound("ItemSound.quest_middle");
    };
    if (id === C && c === 1) {
      await step([L], [V1], 2);
      return p("Cekton", "Speak with Harne.");
    }
    if (id === H && c === 2) {
      await step([V1], [V2], 3);
      return p("Harne", "Bring ten bone fragments.");
    }
    if (id === H && c === 4) {
      await step([V2, B], [S], 5);
      return p("Harne", "Return to Cekton.");
    }
    if (id === C && c === 5) {
      await step([S], [O], 6);
      return p("Cekton", "Use the oil on a zombie.");
    }
    if (id === C && c === 7) {
      await step([Z], [ST], 8);
      return p("Cekton", "Return to Karrod.");
    }
    if (id === K && c === 8) {
      await q.takeItem(s, ST);
      for (const [z, c] of [
        [W, 1],
        [HP, 100],
        [a.isSpellcaster?.() ? 2509 : 1835, a.isSpellcaster?.() ? 500 : 1000],
        ...E.map((z) => [z, 10]),
      ])
        await q.giveItem(s.session, z, c);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Karrod", "The spirit is at peace.");
    }
    return p(
      id === C ? "Cekton" : id === H ? "Harne" : "Karrod",
      "Continue your task.",
    );
  },
  async onKill(s, m) {
    const c = s.getInt("cond"),
      id = Number(m.fetchSelfId());
    if (
      c === 3 &&
      [455, 517, 518].includes(id) &&
      n(s, B) < 10 &&
      Math.random() < 0.3
    ) {
      await Q().giveItem(s.session, B, 1);
      if (n(s, B) >= 10) {
        await s.set("cond", 4);
        s.playSound("ItemSound.quest_middle");
      } else s.playSound("ItemSound.quest_itemget");
    }
    if (c === 6 && [15, 20].includes(id) && Math.random() < 0.3) {
      await Q().takeItem(s, O);
      await Q().giveItem(s.session, Z, 1);
      await s.set("cond", 7);
      s.playSound("ItemSound.quest_middle");
    }
  },
};
