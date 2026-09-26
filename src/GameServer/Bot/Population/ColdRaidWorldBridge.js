function settle(party, options = {}) {
    const encounter = party?.stats?.raidEncounter;
    if (encounter?.status !== 'defeated' || !Number(encounter.bossTemplateId)) {
        return Promise.resolve({ ok: false, reason: 'raid_not_defeated' });
    }
    const World = invoke('GameServer/World/World');
    const boss = invoke('GameServer/World/RaidEntityIndex')
        .bossByTemplateId(World, encounter.bossTemplateId);
    if (!boss || boss.isDead?.() || boss.state?.fetchDead?.()) {
        return Promise.resolve({ ok: true, alreadySettled: true });
    }
    // An old hot snapshot may predate generation capture. Its victory is
    // terminal for the party, but is not proof that this live spawn died.
    if (!encounter.raidInstanceId || encounter.raidInstanceId !== invoke('GameServer/RaidBoss/RaidEncounterScope').instanceId(boss)) {
        return Promise.resolve({ ok: false, reason: 'raid_instance_changed' });
    }

    const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');
    const definition = boss.spawnDefinition;
    const now = Number(encounter.defeatedAt || Date.now());
    const delayMs = SpawnNpcs.respawnDelayForDefinitionMs(definition);
    const respawnAt = Number(options.respawnAt) || now + delayMs;
    const periodRevision = Number(World.npc?.periodRevision || 0);
    const sourceSession = { dataSendToMe() {}, dataSendToMeAndOthers() {} };

    boss.setHp?.(0);
    boss.state?.setDead?.(true);
    invoke('GameServer/Bot/AI/HotPartyCastTracker').cancelForDeadNpc(boss);
    invoke('GameServer/World/RaidBossMinionManager').onBossDeath(World, boss, sourceSession);
    const persisted = SpawnNpcs.shouldRespawn(definition?.spawn)
        ? invoke('GameServer/World/RaidBossState').markDefeated(boss, respawnAt)
        : Promise.resolve(true);
    if (SpawnNpcs.shouldRespawn(definition?.spawn)) {
        SpawnNpcs.scheduleRaidBossRespawn(World, definition, respawnAt, periodRevision);
    }
    invoke('GameServer/World/Generics/NpcDecay').schedule(
        World,
        sourceSession,
        boss,
        Math.max(0, Number(boss.fetchCorpseTime?.() || 0))
    );
    return Promise.resolve(persisted).then(() => ({ ok: true, bossTemplateId: encounter.bossTemplateId,
        winnerPartyId: encounter.winnerPartyId, respawnAt }));
}

module.exports = { settle };
