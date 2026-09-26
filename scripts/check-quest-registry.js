const fs = require("fs");
const path = require("path");

function auditQuestRegistry({ root = path.resolve(__dirname, "..") } = {}) {
  if (typeof global.invoke !== "function") require(path.join(root, "src/Global"));

  const registryPath = path.join(root, "src/GameServer/Quest/QuestRegistry");
  delete require.cache[require.resolve(registryPath)];
  const registry = require(registryPath);
  const questDir = path.join(root, "src/GameServer/Quest/quests");
  const diskPaths = new Set(fs.readdirSync(questDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => `./quests/${name.slice(0, -3)}`));
  const errors = [];
  const paths = new Set();
  const ids = new Set();

  for (const entry of registry.entries) {
    if (!entry || !["active", "disabled", "helper"].includes(entry.status)) {
      errors.push(`invalid registry status for ${entry?.modulePath || "<missing path>"}`);
      continue;
    }
    if (entry.definitionId) {
      const definition = require(path.join(root, 'src/GameServer/Quest/LowLevelDefinitions')).find(d => d.id === entry.definitionId);
      if (!definition || definition.id !== entry.id || ids.has(entry.id)) errors.push(`Invalid/duplicate declarative quest ${entry.id}`);
      else {
        try { require(path.join(root, 'src/GameServer/Quest/DeclarativeQuest')).validate(definition); }
        catch (error) { errors.push(`Q${entry.id}: ${error.message}`); }
      }
      ids.add(entry.id);
      continue;
    }
    if (!entry.modulePath || paths.has(entry.modulePath)) {
      errors.push(`duplicate or missing module path: ${entry.modulePath || "<missing>"}`);
      continue;
    }
    paths.add(entry.modulePath);
    if (!diskPaths.has(entry.modulePath)) errors.push(`registry path missing on disk: ${entry.modulePath}`);
    if (entry.status === "disabled" && !String(entry.reason || "").trim()) {
      errors.push(`disabled entry missing reason: ${entry.modulePath}`);
    }
    if (entry.status === "helper") continue;
    if (!Number.isInteger(entry.id) || entry.id <= 0 || ids.has(entry.id)) {
      errors.push(`duplicate or invalid quest id ${entry.id}: ${entry.modulePath}`);
    }
    ids.add(entry.id);
    const filenameId = Number(path.basename(entry.modulePath).match(/^Q(\d+)_/)?.[1]);
    if (filenameId !== entry.id) errors.push(`filename id mismatch: ${entry.modulePath} != ${entry.id}`);
    if (!diskPaths.has(entry.modulePath)) continue;
    const quest = require(path.join(root, "src/GameServer/Quest", entry.modulePath.slice(2)));
    if (quest.id !== entry.id) errors.push(`exported id mismatch: ${entry.modulePath} exports ${quest.id}`);
    if (entry.status !== "active") continue;
    if (!String(quest.name || "").trim()) errors.push(`active quest missing name: ${entry.modulePath}`);
    if (!Array.isArray(quest.npcs) || quest.npcs.length === 0) errors.push(`active quest missing NPCs: ${entry.modulePath}`);
    if (!Array.isArray(quest.startNpcs) || quest.startNpcs.length === 0) errors.push(`active quest missing start NPCs: ${entry.modulePath}`);
    if (typeof quest.onTalk !== "function" || typeof quest.onEvent !== "function") {
      errors.push(`active quest missing talk/event handler: ${entry.modulePath}`);
    }
    if (quest.killNpcs?.length && typeof quest.onKill !== "function") {
      errors.push(`active kill quest missing kill handler: ${entry.modulePath}`);
    }
  }

  for (const modulePath of diskPaths) {
    if (!paths.has(modulePath)) errors.push(`quest script missing from registry: ${modulePath}`);
  }
  const active = registry.entries.filter((entry) => entry.status === "active").length;
  return { errors, active, total: registry.entries.length };
}

if (require.main === module) {
  const result = auditQuestRegistry();
  if (result.errors.length) {
    result.errors.forEach((error) => console.error(error));
    process.exit(1);
  }
  console.log(`Quest registry check passed: ${result.active} active, ${result.total - result.active} helper/disabled`);
}

module.exports = { auditQuestRegistry };
