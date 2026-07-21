const N = 7149,
  I = 1044;
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`,
  n = (s, id) =>
    s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 164,
  name: "Blood Fiend",
  npcs: [N],
  startNpcs: [N],
  killNpcs: [5021],
  eventNpc: (e) => (e === "start" ? N : null),
  async onEvent(s, e) {
    const a = s.session.actor;
    if (
      e !== "start" ||
      s.isStarted() ||
      a.fetchRace() === 2 ||
      a.fetchLevel() < 21
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    return p("Creamees", "Defeat Kirunak.");
  },
  async onTalk(s) {
    if (!s.isStarted())
      return p("Creamees", '<a action="bypass -h quest 164 start">Accept.</a>');
    if (!n(s, I)) return p("Creamees", "Bring Kirunak's skull.");
    await Q().takeItem(s, I);
    await Q().rewardAdena(s.session, 42130);
    s.playSound("ItemSound.quest_finish");
    await s.exit(false);
    return p("Creamees", "Well done.");
  },
  async onKill(s) {
    if (s.getInt("cond") === 1) {
      await Q().giveItem(s.session, I, 1);
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
    }
  },
};
