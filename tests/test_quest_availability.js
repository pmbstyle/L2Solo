const assert = require("assert");
const fs = require("fs");

require("../src/Global");

const QuestService = invoke("GameServer/Quest/QuestService");
const npcTemplates = JSON.parse(fs.readFileSync("data/Npcs/npcs.json", "utf8"));
const otherItems = JSON.parse(
  fs.readFileSync("data/Items/Others/others.json", "utf8"),
);
const weapons = JSON.parse(
  fs.readFileSync("data/Items/Weapons/weapons.json", "utf8"),
);
const spawnGroups = JSON.parse(
  fs.readFileSync("data/Npcs/Spawns/spawns.json", "utf8"),
);

const templateIds = new Set(npcTemplates.map((npc) => Number(npc.selfId)));
const itemIds = new Set([...otherItems, ...weapons].map((item) => Number(item.selfId)));
const spawnedIds = new Set();
function collectSpawnIds(value) {
  if (Array.isArray(value)) return value.forEach(collectSpawnIds);
  if (!value || typeof value !== "object") return;
  if (Number.isInteger(value.selfId)) spawnedIds.add(value.selfId);
  Object.values(value).forEach(collectSpawnIds);
}
collectSpawnIds(spawnGroups);

for (const quest of QuestService.quests()) {
  for (const npcId of [...(quest.npcs || []), ...(quest.killNpcs || [])]) {
    assert(
      templateIds.has(npcId),
      `Q${quest.id} references NPC ${npcId}, but its template is absent`,
    );
    assert(
      spawnedIds.has(npcId),
      `Q${quest.id} references NPC ${npcId}, but it has no world spawn`,
    );
  }
}

for (const itemId of [5789, 5790]) {
  assert(
    itemIds.has(itemId),
    `source-backed starter quest reward ${itemId} is missing from the item datapack`,
  );
}

for (const itemId of [1138, 1139, 1140, 1141, 1142, 1143, 1144, 1145, 1161, 1162, 1163, 1164, 1165, 1166, 1167, 1168, 1169, 1170, 1171, 1172, 1173, 1174, 1175, 1176, 1177, 1178, 1179, 1271]) {
  assert(itemIds.has(itemId), `Q401 requires missing quest item ${itemId}`);
}

console.log("registered quest NPCs and kill targets are available");
