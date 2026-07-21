const U = 7147,
  B = 1158,
  S = 1159,
  SH = 625,
  M = [33, 345, 371],
  F = [463, 464, 504];
const Q = () => invoke("GameServer/Quest/QuestService");
const p = (t, x, a = "") =>
  `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
const n = (s, id) =>
  s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 162,
  name: "Curse of the Underground Fortress",
  npcs: [U],
  startNpcs: [U],
  killNpcs: [...M, ...F],
  eventNpc: (e) => (e === "start" ? U : null),
  async onEvent(s, e) {
    const a = s.session.actor;
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(a.fetchRace()) === 2 ||
      Number(a.fetchLevel()) < 12
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    s.playSound("ItemSound.quest_accept");
    return p("Unoren", "Collect bones and elven skulls.");
  },
  async onTalk(s) {
    const a = s.session.actor,
      q = Q();
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return Number(a.fetchRace()) !== 2 && Number(a.fetchLevel()) >= 12
        ? p(
            "Unoren",
            "Will you lift the curse?",
            '<a action="bypass -h quest 162 start">Accept.</a>',
          )
        : p("Unoren", "I cannot ask this of you.");
    if (s.getInt("cond") !== 2)
      return p("Unoren", "Bring ten bone fragments and three skulls.");
    await q.takeItem(s, S, -1);
    await q.takeItem(s, B, -1);
    await q.giveItem(s.session, SH, 1);
    await q.rewardAdena(s.session, 24000);
    s.playSound("ItemSound.quest_finish");
    await s.exit(false);
    return p("Unoren", "The curse is lifted.");
  },
  async onKill(s, m) {
    if (s.getInt("cond") !== 1) return;
    const id = Number(m.fetchSelfId()),
      skull = M.includes(id),
      item = skull ? S : B,
      cap = skull ? 3 : 10;
    if (n(s, item) >= cap) return;
    const chance = id === 504 ? 0.3 : id === 463 || id === 464 ? 0.25 : 0.2;
    if (Math.random() >= chance) return;
    await Q().giveItem(s.session, item, 1);
    if (n(s, B) >= 10 && n(s, S) >= 3) {
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
    } else s.playSound("ItemSound.quest_itemget");
  },
};
