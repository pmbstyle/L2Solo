const N = 7305,
  I = 1046;
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`,
  n = (s, id) =>
    s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 170,
  name: "Dangerous Seduction",
  npcs: [N],
  startNpcs: [N],
  killNpcs: [5022],
  eventNpc: (e) => (e === "start" ? N : null),
  async onEvent(s, e) {
    const a = s.session.actor;
    if (
      e !== "start" ||
      s.isStarted() ||
      a.fetchRace() !== 2 ||
      a.fetchLevel() < 21
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    return p("Vellior", "Defeat Merkenis.");
  },
  async onTalk(s) {
    if (!s.isStarted())
      return p("Vellior", '<a action="bypass -h quest 170 start">Accept.</a>');
    if (!n(s, I)) return p("Vellior", "Bring the nightmare crystal.");
    await Q().takeItem(s, I, -1);
    await Q().rewardAdena(s.session, 102680);
    s.playSound("ItemSound.quest_finish");
    await s.exit(false);
    return p("Vellior", "You have resisted temptation.");
  },
  async onKill(s) {
    if (s.getInt("cond") === 1) {
      await Q().giveItem(s.session, I, 1);
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
    }
  },
};
