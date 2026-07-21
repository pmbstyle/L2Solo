const S = 7220,
  P = [1038, 1039, 1040, 1041];
const Q = () => invoke("GameServer/Quest/QuestService");
const p = (t, x, a = "") =>
  `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
const n = (s, id) =>
  s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 163,
  name: "Legacy of the Poet",
  npcs: [S],
  startNpcs: [S],
  killNpcs: [372, 373],
  eventNpc: (e) => (e === "start" ? S : null),
  async onEvent(s, e) {
    const a = s.session.actor;
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(a.fetchRace()) === 2 ||
      Number(a.fetchLevel()) < 11
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    s.playSound("ItemSound.quest_accept");
    return p("Starden", "Find Rumiel's poems.");
  },
  async onTalk(s) {
    const a = s.session.actor;
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return Number(a.fetchRace()) !== 2 && Number(a.fetchLevel()) >= 11
        ? p(
            "Starden",
            "Will you search for the poems?",
            '<a action="bypass -h quest 163 start">Accept.</a>',
          )
        : p("Starden", "I cannot ask this of you.");
    if (s.getInt("cond") !== 2)
      return p("Starden", "The poems are still missing.");
    for (const id of P) await Q().takeItem(s, id, -1);
    await Q().rewardAdena(s.session, 13890);
    s.playSound("ItemSound.quest_finish");
    await s.exit(false);
    return p("Starden", "Rumiel will not be forgotten.");
  },
  async onKill(s) {
    if (s.getInt("cond") !== 1) return;
    const missing = P.filter((id) => !n(s, id));
    if (!missing.length) return;
    const chances = [0.1, 0.2, 0.2, 0.4];
    const i = P.indexOf(missing[0]);
    if (Math.random() >= chances[i]) return;
    await Q().giveItem(s.session, missing[0], 1);
    if (P.every((id) => n(s, id))) {
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
    } else s.playSound("ItemSound.quest_itemget");
  },
};
