const B = 7334,
  H = 7332,
  BL = 7178,
  RD = 7179,
  IN = 7180,
  G = 7181,
  Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`,
  n = (s, id) =>
    s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 39,
  name: "Red-Eyed Invaders",
  npcs: [B, H],
  startNpcs: [B],
  killNpcs: [919, 920, 921, 925],
  eventNpc: (e) =>
    ({ start: B, bathis: H, necklaces: H, finish: H })[e] ?? null,
  async onEvent(s, e) {
    const q = Q(),
      c = s.getInt("cond");
    if (e === "start" && !s.isStarted()) {
      if (s.session.actor.fetchLevel() < 20) return null;
      await s.setState("started");
      await s.set("cond", 1);
      return p("Babenco", "Speak with Bathis.");
    }
    if (e === "bathis" && c === 1) {
      await s.set("cond", 2);
      return p("Bathis", "Collect 100 necklaces.");
    }
    if (e === "necklaces" && c === 3) {
      await q.takeItem(s, BL, -1);
      await q.takeItem(s, RD, -1);
      await s.set("cond", 4);
      return p("Bathis", "Collect incense and gems.");
    }
    if (e === "finish" && c === 5) {
      for (const z of [IN, G]) await q.takeItem(s, z, -1);
      for (const [id, a] of [
        [6521, 60],
        [6529, 1],
        [6535, 500],
      ])
        await q.giveItem(s.session, id, a);
      await s.exit(false);
      return p("Bathis", "The invaders are defeated.");
    }
    return null;
  },
  async onTalk(s, x) {
    if (!s.isStarted())
      return p("Babenco", '<a action="bypass -h quest 39 start">Accept.</a>');
    const c = s.getInt("cond"),
      e =
        c === 1 ? "bathis" : c === 3 ? "necklaces" : c === 5 ? "finish" : null;
    return x.fetchSelfId() === H && e
      ? p("Bathis", '<a action="bypass -h quest 39 ' + e + '">Continue.</a>')
      : p("Quest", "Continue.");
  },
  async onKill(s, m) {
    const c = s.getInt("cond"),
      id = m.fetchSelfId();
    if (c === 2 && id !== 925 && Math.random() < 0.5) {
      const item = id === 921 ? RD : BL;
      await Q().giveItem(s.session, item, 1);
      if (n(s, BL) + n(s, RD) >= 100) await s.set("cond", 3);
    }
    if (c === 4 && id !== 919) {
      const map = { 925: [G, IN, 0.5], 921: [IN, G, 0.3], 920: [IN, G, 0.25] }[
        id
      ];
      if (map && Math.random() < map[2]) {
        await Q().giveItem(s.session, map[0], 1);
        if (n(s, map[0]) >= 30 && n(s, map[1]) >= 30) await s.set("cond", 5);
      }
    }
  },
};
