const V = 7145,
  C = 1030,
  P = 1031,
  G = 31;
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`,
  n = (s, id) =>
    s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 169,
  name: "Offspring of Nightmares",
  npcs: [V],
  startNpcs: [V],
  killNpcs: [105, 25],
  eventNpc: (e) => (e === "start" ? V : null),
  async onEvent(s, e) {
    const a = s.session.actor;
    if (
      e !== "start" ||
      s.isStarted() ||
      a.fetchRace() !== 2 ||
      a.fetchLevel() < 15
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    s.playSound("ItemSound.quest_accept");
    return p("Vlasty", "Bring me a perfect skull.");
  },
  async onTalk(s) {
    const q = Q(),
      a = s.session.actor;
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return p("Vlasty", '<a action="bypass -h quest 169 start">Accept.</a>');
    if (s.getInt("cond") !== 2)
      return p("Vlasty", "The perfect skull is still missing.");
    await q.takeItem(s, P, -1);
    const cracked = n(s, C);
    await q.takeItem(s, C, -1);
    await q.giveItem(s.session, G, 1);
    await q.rewardAdena(s.session, 17000 + cracked * 20);
    s.playSound("ItemSound.quest_finish");
    await s.exit(false);
    return p("Vlasty", "The nightmare is ended.");
  },
  async onKill(s) {
    if (s.getInt("cond") !== 1) return;
    if (Math.random() < 0.2) {
      await Q().giveItem(s.session, P, 1);
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
    } else if (Math.random() < 0.5) {
      await Q().giveItem(s.session, C, 1);
      s.playSound("ItemSound.quest_itemget");
    }
  },
};
