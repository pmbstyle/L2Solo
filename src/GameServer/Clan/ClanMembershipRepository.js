const Policy = require('./ClanMembershipPolicy');

module.exports = ({ all, write, inTransaction, now }) => {
    function repairUnsafe(characterIds = null) {
        const ids = characterIds && [...new Set(characterIds.map(Number).filter(Boolean))];
        if (ids && !ids.length) return { members: [], parties: [] };
        const filter = ids ? ` AND members.id IN (${ids.map(() => '?').join(',')})` : '';
        const rows = all(`SELECT life.*, members.clanId AS actualClanId FROM bot_life_state life
            JOIN characters members ON members.id = life.characterId WHERE 1=1${filter}`, ids || []);
        const members = [];
        for (const row of rows) {
            const previous = { activity: row.activity, stats: JSON.parse(row.statsJson || '{}') };
            const repaired = Policy.reconcileState(previous, Number(row.actualClanId || 0));
            if (repaired === previous) continue;
            repaired.stats.clanMembershipVersion = Math.max(now(), Number(previous.stats.clanMembershipVersion || 0) + 1);
            const next = { ...row, activity: repaired.activity, statsJson: JSON.stringify(repaired.stats),
                simulationRevision: Number(row.simulationRevision || 0) + 1, updatedAt: now() };
            write(`UPDATE bot_life_state SET activity = ?, statsJson = ?, simulationRevision = ?, updatedAt = ?
                WHERE characterId = ?`, [next.activity, next.statsJson, next.simulationRevision, next.updatedAt, row.characterId]);
            members.push(next);
        }
        const parties = [];
        for (const row of all(`SELECT parties.*, members.clanId AS actualClanId FROM bot_background_parties parties
            JOIN characters members ON members.id = parties.leaderId
            WHERE parties.status IN ('active', 'hot') AND members.clanId > 0
              AND json_extract(parties.statsJson, '$.objective.strategy') = 'craft'
              AND COALESCE(json_extract(parties.statsJson, '$.objective.clanGoalKey'), '') = ''${filter}`, ids || [])) {
            const repaired = Policy.reconcileParty({ stats: JSON.parse(row.statsJson || '{}') }, row.actualClanId);
            const next = { ...row, statsJson: JSON.stringify(repaired.stats), updatedAt: now() };
            write('UPDATE bot_background_parties SET statsJson = ?, updatedAt = ? WHERE partyId = ?',
                [next.statsJson, next.updatedAt, next.partyId]);
            parties.push(next);
        }
        return { members, parties };
    }

    function repairGoalsUnsafe(clanIds = null) {
        const ids = clanIds && [...new Set(clanIds.map(Number).filter(Boolean))];
        if (ids && !ids.length) return { members: [], parties: [] };
        const filter = ids ? ` WHERE clanId IN (${ids.map(() => '?').join(',')})` : '';
        const clans = all(`SELECT clanId, stateJson FROM clan_simulation_clans${filter}`, ids || []);
        const members = [], parties = [];
        for (const clan of clans) {
            const keys = Policy.activeGoalKeys(JSON.parse(clan.stateJson || '{}'));
            const activeClanParties = all(`SELECT p.* FROM bot_background_parties p
                JOIN characters c ON c.id = p.leaderId
                WHERE c.clanId = ? AND p.status IN ('active', 'hot')`, [clan.clanId])
                .map((row) => ({
                    status: row.status,
                    memberIds: JSON.parse(row.memberIdsJson || '[]'),
                    stats: JSON.parse(row.statsJson || '{}')
                }));
            for (const goalKey of Policy.activeRaidGoalKeys(activeClanParties)) keys.add(goalKey);
            const rows = all(`SELECT life.* FROM bot_life_state life JOIN characters c ON c.id = life.characterId
                WHERE c.clanId = ? AND (json_extract(life.statsJson, '$.equipmentPlan.clanGoal.goalKey') IS NOT NULL
                    OR json_extract(life.statsJson, '$.clanPartyObjective.clanGoalKey') IS NOT NULL
                    OR json_extract(life.statsJson, '$.partyRequest.clanGoalKey') IS NOT NULL)`, [clan.clanId]);
            for (const row of rows) {
                const previous = { activity: row.activity, partyId: row.partyId, stats: JSON.parse(row.statsJson || '{}') };
                const repaired = Policy.reconcileGoals(previous, keys);
                if (repaired === previous) continue;
                const version = Math.max(now(), Number(previous.stats.clanMembershipVersion || 0) + 1,
                    Number(previous.stats.clanGoalInvalidationVersion || 0) + 1);
                repaired.stats.clanMembershipVersion = version;
                repaired.stats.clanGoalInvalidationVersion = version;
                repaired.stats.lastReason = 'clan_goal_expired';
                const next = { ...row, activity: repaired.activity, statsJson: JSON.stringify(repaired.stats),
                    simulationRevision: Number(row.simulationRevision || 0) + 1, updatedAt: now() };
                write(`UPDATE bot_life_state SET activity = ?, statsJson = ?, simulationRevision = ?, updatedAt = ?
                    WHERE characterId = ?`, [next.activity, next.statsJson, next.simulationRevision, next.updatedAt, row.characterId]);
                members.push(next);
            }
            for (const row of all(`SELECT p.* FROM bot_background_parties p JOIN characters c ON c.id = p.leaderId
                WHERE c.clanId = ? AND p.status IN ('active', 'hot')
                    AND json_extract(p.statsJson, '$.objective.clanGoalKey') IS NOT NULL`, [clan.clanId])) {
                const stats = JSON.parse(row.statsJson || '{}');
                if (keys.has(stats.objective.clanGoalKey)) continue;
                const next = { ...row, statsJson: JSON.stringify({ ...stats, objective: null, acquisitionGoal: null,
                    lastRequirementRefreshAt: 0, clanGoalInvalidationVersion: Math.max(now(),
                        Number(stats.clanGoalInvalidationVersion || 0) + 1) }), updatedAt: now() };
                write('UPDATE bot_background_parties SET statsJson = ?, updatedAt = ? WHERE partyId = ?',
                    [next.statsJson, next.updatedAt, next.partyId]);
                parties.push(next);
            }
        }
        return { members, parties };
    }

    function reconcileGoals(clanIds = null) {
        return inTransaction(() => {
            const membershipRepair = repairGoalsUnsafe(clanIds);
            return { repairedMembers: membershipRepair.members.length, repairedParties: membershipRepair.parties.length, membershipRepair };
        }, 'clan-goals:reconcile').then(publish);
    }

    function publish(result) {
        if (!result?.membershipRepair) return result;
        const { membershipRepair, ...value } = result;
        if (!membershipRepair.members.length && !membershipRepair.parties.length) return value;
        const life = invoke('GameServer/Bot/Population/BotLifeState');
        for (const row of membershipRepair.members) life.acceptClanMembershipState(row);
        const parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
        for (const row of membershipRepair.parties) parties.acceptRow(row);
        return value;
    }

    function reconcile(characterIds = null) {
        return inTransaction(() => {
            const membershipRepair = repairUnsafe(characterIds);
            return { repairedMembers: membershipRepair.members.length, repairedParties: membershipRepair.parties.length, membershipRepair };
        }, 'clan-membership:reconcile').then(publish);
    }
    return { repairUnsafe, repairGoalsUnsafe, publish, reconcile, reconcileGoals };
};
