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
      spawnedIds.has(npcId) || quest.questSpawns?.includes(npcId),
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

for (const itemId of [1138, 1139, 1140, 1141, 1142, 1143, 1144, 1145, 1161, 1162, 1163, 1164, 1165, 1166, 1167, 1168, 1169, 1170, 1171, 1172, 1173, 1174, 1175, 1176, 1177, 1178, 1179, 1180, 1181, 1182, 1183, 1184, 1185, 1186, 1187, 1188, 1189, 1190, 1191, 1192, 1193, 1194, 1195, 1196, 1197, 1198, 1199, 1200, 1201, 1202, 1203, 1204, 1205, 1206, 1207, 1208, 1209, 1210, 1211, 1212, 1214, 1215, 1216, 1217, 1218, 1219, 1220, 1221, 1222, 1223, 1224, 1225, 1226, 1229, 1230, 1237, 1238, 1239, 1240, 1241, 1242, 1243, 1244, 1271, 1272, 1273, 1274, 1276, 1280, 1281, 1282, 1283, 1284, 1285, 1286, 1287, 1288, 1289, 1290, 1291, 1292, 1293]) {
  assert(itemIds.has(itemId), `Q401 requires missing quest item ${itemId}`);
}

for (const itemId of [1245, 1246, 1247, 1248, 1250, 1251, 1252]) {
  assert(itemIds.has(itemId), `Q411 requires missing quest item ${itemId}`);
}

for (const itemId of [1253, 1254, 1255, 1256, 1257, 1259, 1260, 1261, 1277, 1278, 1279]) {
  assert(itemIds.has(itemId), `Q412 requires missing quest item ${itemId}`);
}

for (const itemId of [1262, 1263, 1264, 1265, 1266, 1267, 1268, 1269, 1270]) {
  assert(itemIds.has(itemId), `Q413 requires missing quest item ${itemId}`);
}

for (const itemId of [1578, 1579, 1580, 1589, 1591, 1592]) {
  assert(itemIds.has(itemId), `Q414 requires missing quest item ${itemId}`);
}

for (const itemId of Array.from({ length: 23 }, (_, index) => 1593 + index)) {
  assert(itemIds.has(itemId), `Q415 requires missing quest item ${itemId}`);
}

for (const itemId of Array.from({ length: 16 }, (_, index) => 1616 + index)) {
  assert(itemIds.has(itemId), `Q416 requires missing quest item ${itemId}`);
}

console.log("registered quest NPCs and kill targets are available");
