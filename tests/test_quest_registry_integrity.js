require("../src/Global");
const assert = require("assert");
const { auditQuestRegistry } = require("../scripts/check-quest-registry");

const result = auditQuestRegistry();
assert.deepStrictEqual(result.errors, []);
assert.strictEqual(result.active, 117);

const QuestService = invoke("GameServer/Quest/QuestService");
const Database = invoke("Database");
const registry = require("../src/GameServer/Quest/QuestRegistry");
const disabled = registry.entries.find((entry) => entry.id === 11);
assert.strictEqual(disabled.status, "disabled");
assert(disabled.reason);
assert.strictEqual(QuestService.quests().some((entry) => entry.id === 11), false);

const quest = QuestService.quests().find((entry) => entry.id === 34);
assert(quest, "an active quest must be reachable through QuestService");
assert.strictEqual(QuestService.handlesNpc(quest.startNpcs[0]), true);

const originalFetch = Database.fetchCharacterQuests;
Database.fetchCharacterQuests = async () => [{ questId: 34, state: "started", variables: "{\"cond\":\"1\"}" }];
const session = {
  actor: { fetchId: () => 900011, fetchClanId: () => 0 },
  dataSendToMe() {},
};

QuestService.ensureLoaded(session).then(() => {
  const state = session.questStates.get(34);
  assert(state?.isStarted(), "persisted quest state must resolve through the registered ID");
  assert.strictEqual(state.getInt("cond"), 1);
  Database.fetchCharacterQuests = originalFetch;
  console.log("Quest registry integrity and reachability checks passed");
}).catch((error) => {
  Database.fetchCharacterQuests = originalFetch;
  throw error;
});
