const TREES = new Set([5185, 5186, 5187, 5188]);

function onDeath(session, killer, tree) {
    if (!TREES.has(tree.fetchSelfId?.())) return [];
    const World = invoke('GameServer/World/World');
    const guardians = [];
    for (let i = 0; i < 20; i++) {
        const guardian = World.spawnQuestNpc({
            selfId: 5189, locX: tree.fetchLocX(), locY: tree.fetchLocY(), locZ: tree.fetchLocZ(),
            questId: 421, despawnDelay: 30000
        });
        if (!guardian) continue;
        guardian.questSpawn.timer.unref?.();
        guardian.setStateRun(true);
        guardian.addDamageHate(session, killer, 0, 100);
        guardian.enterCombatState(session, killer);
        guardians.push(guardian);
    }
    return guardians;
}
module.exports = { onDeath };
