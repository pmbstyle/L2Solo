require("../src/Global");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// QuestService.giveItem throws on an item with no template, which leaves the
// quest stuck on that step. Every item id an active hand-written quest names
// in an item call must therefore have a template. Declarative quests are run
// end to end with real items by test_c4_declarative_quests.js.
const DataCache = invoke("GameServer/DataCache");
DataCache.init();
const registry = require("../src/GameServer/Quest/QuestRegistry");

const templates = new Set(DataCache.items.map((item) => item.selfId));
const questDir = path.join(__dirname, "../src/GameServer/Quest/quests");
const missing = new Set();
let checked = 0;
for (const entry of registry.entries) {
  if (entry.status !== "active" || entry.definitionId) continue;
  const file = path.join(questDir, `${path.basename(entry.modulePath)}.js`);
  const source = fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  // Numeric constants (NAME = 123 or NAME: 123), first definition wins.
  const constants = new Map();
  for (const [, name, value] of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*[:=]\s*(\d+)\b/g)) {
    if (!constants.has(name)) constants.set(name, Number(value));
  }
  // The item argument of giveItem/takeItem/collect(session or state, ITEM, ...).
  // Arguments computed at run time are not resolved here.
  for (const [, arg] of source.matchAll(/\b(?:giveItem|takeItem|collect)\(\s*[\w$.]+\s*,\s*([\w$]+)/g)) {
    const id = /^\d+$/.test(arg) ? Number(arg) : constants.get(arg);
    if (id === undefined) continue;
    checked++;
    if (!templates.has(id)) missing.add(`Q${entry.id}: ${id}`);
  }
}
assert(checked > 300, `item calls must be found in the quest sources (found ${checked})`);
assert.deepStrictEqual([...missing], [], "quest items without an item template");
console.log("Quest item template checks passed");
