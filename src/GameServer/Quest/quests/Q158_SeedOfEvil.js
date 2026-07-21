const N = 7031,
  I = 1025,
  R = 956;
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`,
  n = (s, id) =>
    s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 158,
  name: "Seed of Evil",
  npcs: [N],
  startNpcs: [N],
  killNpcs: [5016],
  eventNpc: (e) => (e === "start" ? N : null),
  async onEvent(s, e) {
    if (e !== "start" || s.isStarted() || s.session.actor.fetchLevel() < 21)
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    s.playSound("ItemSound.quest_accept");
    return p("Biotin", "Defeat Nerkas.");
  },
  async onTalk(s) {
    if (!s.isStarted())
      return p("Biotin", '<a action="bypass -h quest 158 start">Accept.</a>');
    if (!n(s, I)) return p("Biotin", "The clay tablet is missing.");
    await Q().takeItem(s, I);
    await Q().giveItem(s.session, R, 1);
    s.playSound("ItemSound.quest_finish");
    await s.exit(false);
    return p("Biotin", "The seed is destroyed.");
  },
  async onKill(s) {
    if (s.getInt("cond") === 1) {
      await Q().giveItem(s.session, I, 1);
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
    }
  },
};
