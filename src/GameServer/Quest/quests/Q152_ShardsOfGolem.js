const H = 7035,
  A = 7283,
  R1 = 1008,
  R2 = 1009,
  SHARD = 1010,
  BOX = 1011,
  ARMOR = 23;
const Q = () => invoke("GameServer/Quest/QuestService");
const p = (t, x, a = "") =>
  `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
const n = (s, id) =>
  s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 152,
  name: "Shards of Golem",
  npcs: [H, A],
  startNpcs: [H],
  killNpcs: [16],
  eventNpc: (e) => (e === "start" ? H : null),
  async onEvent(s, e) {
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(s.session.actor.fetchLevel()) < 10
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    await Q().giveItem(s.session, R1, 1);
    s.playSound("ItemSound.quest_accept");
    return p("Harris", "Take this receipt to Altran.");
  },
  async onTalk(s, x) {
    const id = Number(x.fetchSelfId()),
      q = Q(),
      c = s.getInt("cond");
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === H && Number(s.session.actor.fetchLevel()) >= 10
        ? p(
            "Harris",
            "Can you recover the golem shards?",
            '<a action="bypass -h quest 152 start">Accept.</a>',
          )
        : p("Harris", "Return at level 10.");
    if (id === A && c === 1) {
      await q.takeItem(s, R1);
      await q.giveItem(s.session, R2, 1);
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
      return p("Altran", "Bring five golem shards.");
    }
    if (id === A && c === 3) {
      await q.takeItem(s, SHARD, -1);
      await q.giveItem(s.session, BOX, 1);
      await s.set("cond", 4);
      s.playSound("ItemSound.quest_middle");
      return p("Altran", "Take this tool box to Harris.");
    }
    if (id === H && c === 4 && n(s, BOX)) {
      await q.takeItem(s, R2);
      await q.takeItem(s, BOX);
      await q.giveItem(s.session, ARMOR, 1);
      await q.rewardExpSp(s.session, 5000, 0);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Harris", "Excellent work.");
    }
    return p(id === A ? "Altran" : "Harris", "Continue your task.");
  },
  async onKill(s) {
    if (s.getInt("cond") !== 2 || Math.random() >= 0.3 || n(s, SHARD) >= 5)
      return;
    await Q().giveItem(s.session, SHARD, 1);
    if (n(s, SHARD) >= 5) {
      await s.set("cond", 3);
      s.playSound("ItemSound.quest_middle");
    } else s.playSound("ItemSound.quest_itemget");
  },
};
