const R = 7008,
  A = 7283,
  RL = 796,
  DIR = 937,
  T = 741,
  B = 740,
  N = 742,
  H = 739,
  S = 738,
  HP = 1060,
  SP = 5790,
  SS = 5789,
  E = [4412, 4413, 4414, 4415, 4416];
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`,
  n = (s, id) =>
    s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 101,
  name: "Sword of Solidarity",
  npcs: [R, A],
  startNpcs: [R],
  killNpcs: [361, 362],
  eventNpc: (e) =>
    ({ start: R, dir: A, note: A, handle: R, reward: A })[e] ?? null,
  async onEvent(s, e) {
    const q = Q(),
      a = s.session.actor;
    if (e === "start" && !s.isStarted()) {
      if (Number(a.fetchRace()) !== 0 || Number(a.fetchLevel()) < 9)
        return null;
      await s.setState("started");
      await s.set("cond", 1);
      await q.giveItem(s.session, RL, 1);
      s.playSound("ItemSound.quest_accept");
      return p("Roien", "Take this letter to Altran.");
    }
    const x = {
      dir: [1, 2, RL, DIR],
      note: [3, 4, DIR, N],
      handle: [4, 5, N, H],
    }[e];
    if (x && s.getInt("cond") === x[0]) {
      for (const z of e === "note" ? [DIR, T, B] : [x[2]])
        if (!(await q.takeItem(s, z))) return null;
      await q.giveItem(s.session, x[3], 1);
      await s.set("cond", x[1]);
      s.playSound("ItemSound.quest_middle");
      return p("Quest", "Continue the task.");
    }
    if (e === "reward" && s.getInt("cond") === 5) {
      if (!(await q.takeItem(s, H))) return null;
      const mage = Boolean(a.isSpellcaster?.());
      const rewards = [[S, 1], [HP, 100], ...E.map((id) => [id, 10])];
      if (a.isNewbie?.()) rewards.push([mage ? SP : SS, mage ? 3000 : 7000]);
      for (const [id, c] of rewards) await q.giveItem(s.session, id, c);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Altran", "The Sword of Solidarity is yours.");
    }
    return null;
  },
  async onTalk(s, x) {
    const id = Number(x.fetchSelfId()),
      c = s.getInt("cond"),
      a = s.session.actor;
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === R &&
        Number(a.fetchRace()) === 0 &&
        Number(a.fetchLevel()) >= 9
        ? p(
            "Roien",
            "Will you restore the sword?",
            '<a action="bypass -h quest 101 start">Accept.</a>',
          )
        : p("Roien", "Humans of level 9 or higher only.");
    const e =
      id === A
        ? c === 1
          ? "dir"
          : c === 3
            ? "note"
            : c === 5
              ? "reward"
              : null
        : c === 4
          ? "handle"
          : null;
    return e
      ? p(
          "Quest",
          "Continue. ",
          `<a action="bypass -h quest 101 ${e}">Continue.</a>`,
        )
      : p("Quest", "Continue the restoration.");
  },
  async onKill(s) {
    if (s.getInt("cond") !== 2 || Math.random() >= 0.2) return;
    const id = n(s, T) ? B : T;
    if (n(s, id)) return;
    await Q().giveItem(s.session, id, 1);
    if (n(s, T) && n(s, B)) {
      await s.set("cond", 3);
      s.playSound("ItemSound.quest_middle");
    } else s.playSound("ItemSound.quest_itemget");
  },
};
