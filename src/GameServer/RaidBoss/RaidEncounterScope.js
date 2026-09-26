function instanceId(boss) {
    return boss?.raidInstanceId || (boss?.fetchId ? `object:${boss.fetchId()}` : null);
}

function otherParticipants(world, boss, excludedIds = []) {
    if (!boss) return false;
    const excluded = new Set(excludedIds.map(Number));
    const entities = invoke('GameServer/World/RaidEntityIndex').entitiesForRaid(world, {
        bossId: boss.fetchId(), bossTemplateId: boss.fetchSelfId()
    });
    const ids = new Set(entities.map(npc => Number(npc.fetchId())));
    return (world.user?.sessions || []).some(s => {
        const actor = s.actor;
        if (!actor || excluded.has(Number(actor.fetchId())) || actor.isDead?.()
            || s.hotRaidFailureAt || s.raidFailurePendingAt) return false;
        if (entities.some(npc => !npc.isDead?.() && Number(npc.fetchDestId?.()) === Number(actor.fetchId()))) return true;
        if (s.hotBackgroundPartyId && s.raidPreparationComplete
            && !s.hotRaidFailureAt && !s.raidFailurePendingAt
            && ids.has(Number(s.backgroundHuntTarget?.fetchId?.()))) return true;
        return (actor.state?.fetchHits?.() || actor.state?.fetchCasts?.())
            && ids.has(Number(s.currentTargetId || actor.fetchDestId?.()));
    });
}

function decorateSpot(spot) {
    if (!spot?.raidBoss) return spot;
    const world = invoke('GameServer/World/World');
    const boss = invoke('GameServer/World/RaidEntityIndex').bossByTemplateId(world, spot.raidBossTemplateId);
    const authority = invoke('GameServer/Bot/Population/ColdRaidAuthority').get(`raid:${spot.raidBossTemplateId}`);
    return { ...spot, raidInstanceId: instanceId(boss), raidAuthority: authority.snapshot, raidAuthorityRevision: authority.revision,
        raidExternallyEngaged: otherParticipants(world, boss),
        raidWorldAvailable: !!boss && !boss.isDead?.() && Number(boss.fetchHp?.()) > 0 };
}

module.exports = { instanceId, otherParticipants, decorateSpot };
