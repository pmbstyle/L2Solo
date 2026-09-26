// Main-process mirror of durable raid state. One small row per boss, replaced
// on respawn; no growing per-tick history and no database work in the worker.
const records = new Map();
async function init() {
    const rows = await invoke('Database').execute(['SELECT * FROM bot_raid_encounters', []]);
    rows.forEach(accept);
}
function accept(row) {
    if (!row || Number(records.get(row.raidKey)?.revision || 0) >= Number(row.revision)) return;
    records.set(row.raidKey, { revision: Number(row.revision), snapshot: JSON.parse(row.snapshotJson) });
}
function get(key) { return records.get(key) || { revision: 0, snapshot: null }; }
function prepare(commit) {
    if (commit.worldRequired === false) return true;
    const World = invoke('GameServer/World/World');
    const boss = invoke('GameServer/World/RaidEntityIndex').bossByTemplateId(World, Number(commit.key.split(':')[1]));
    if (!boss || boss.isDead?.() || boss.state?.fetchDead?.()
        || commit.snapshot.raidInstanceId !== invoke('GameServer/RaidBoss/RaidEncounterScope').instanceId(boss)) return false;
    if (commit.snapshot.status === 'defeated') {
        const Spawns = invoke('GameServer/World/Generics/SpawnNpcs');
        if (Spawns.shouldRespawn(boss.spawnDefinition?.spawn)) {
            commit.worldDefeat = { npcId: Number(boss.fetchSelfId()),
                respawnTime: Number(commit.snapshot.defeatedAt || Date.now()) + Spawns.respawnDelayForDefinitionMs(boss.spawnDefinition) };
        }
    }
    return true;
}
module.exports = { init, accept, get, prepare };
