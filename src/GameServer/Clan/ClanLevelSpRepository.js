const ClanRules = require('./ClanRules');

// Reuse the player costs; callers retain their existing item/treasury/trial rules.
module.exports = ({ one, write, run, withCharacterFlushes }) => {
    const loaded = path => require.cache[require.resolve(path)]?.exports;
    const sessionFor = id => loaded('../World/World')?.user?.sessions
        ?.find(session => Number(session.actor?.fetchId?.()) === Number(id));

    function withLeader(clanId, work) {
        return run('SELECT leaderId FROM clans WHERE id = ?', [Number(clanId)], 'clan-level:leader', true)
            .then(rows => {
                const ids = rows.map(row => row.leaderId);
                const execute = () => withCharacterFlushes(ids, work).then(publish);
                const life = loaded('../Bot/Population/BotLifeState');
                return ids.length && life ? life.serializeClanLevelUp(ids[0], execute) : execute();
            });
    }

    function check(clan, fromLevel, toLevel) {
        const requirement = ClanRules.LEVEL_REQUIREMENTS[fromLevel];
        if (!requirement || requirement.nextLevel !== Number(toLevel)) return { ok: false, code: 'invalid_clan_level' };
        const leader = one('SELECT id, clanId, sp FROM characters WHERE id = ?', [clan.leaderId]);
        if (!leader || Number(leader.clanId) !== Number(clan.id)) return { ok: false, code: 'not_leader' };
        const life = one('SELECT * FROM bot_life_state WHERE characterId = ?', [leader.id]);
        const actor = sessionFor(leader.id)?.actor;
        // Hot awards may arrive after the flush; cold progression owns its life row.
        const sp = Number(actor?.fetchSp?.() ?? (life?.phase === 'cold' ? life.sp : leader.sp));
        const requiredSp = requirement.sp;
        if (!Number.isSafeInteger(sp) || sp < requiredSp) return { ok: false, code: 'not_enough_sp', sp, requiredSp };
        return { ok: true, characterId: Number(leader.id), sp, requiredSp, life };
    }

    function spend(budget) {
        const sp = budget.sp - budget.requiredSp;
        write('UPDATE characters SET sp = ? WHERE id = ?', [sp, budget.characterId]);
        let state = null;
        if (budget.life) {
            const version = Math.max(Date.now(), Number(JSON.parse(budget.life.statsJson || '{}').clanLevelSpVersion || 0) + 1);
            write(`UPDATE bot_life_state SET sp = ?, simulationRevision = simulationRevision + 1,
                statsJson = json_set(COALESCE(statsJson, '{}'), '$.clanLevelSpVersion', ?), updatedAt = ?
                WHERE characterId = ?`, [sp, version, Date.now(), budget.characterId]);
            state = one('SELECT * FROM bot_life_state WHERE characterId = ?', [budget.characterId]);
        }
        return { characterId: budget.characterId, sp, spentSp: budget.requiredSp, state };
    }

    function publish(result) {
        if (!result?.levelSp) return result;
        const { levelSp, ...value } = result;
        const session = sessionFor(levelSp.characterId);
        const actor = session?.actor;
        if (actor?.setSp && actor?.fetchSp) {
            // Preserve awards earned between commit and publication; replace any
            // buffered pre-charge snapshot with the current actor's experience.
            actor.setSp(actor.fetchSp() - levelSp.spentSp);
            loaded('../Persistence/CharacterWriteQueue')?.experience(
                levelSp.characterId, actor.fetchLevel(), actor.fetchExp(), actor.fetchSp());
            if (levelSp.state) {
                levelSp.state.sp = actor.fetchSp();
                const version = JSON.parse(levelSp.state.statsJson).clanLevelSpVersion;
                for (const key of ['coldLifeState', 'coldMarketState', 'coldCraftState']) {
                    if (session[key]) session[key] = { ...session[key], sp: actor.fetchSp(),
                        stats: { ...session[key].stats, clanLevelSpVersion: version } };
                }
            }
            if (actor.fetchIsOnline?.()) {
                const Response = loaded('../Network/Response');
                if (Response) session.dataSendToMe?.(Response.statusUpdate(levelSp.characterId, [{ id: 0x0d, value: actor.fetchSp() }]));
            }
        }
        if (levelSp.state) loaded('../Bot/Population/BotLifeState')?.acceptClanLevelSpState(levelSp.state);
        return { ...value, leaderId: levelSp.characterId, sp: levelSp.sp, spentSp: levelSp.spentSp };
    }
    return { withLeader, check, spend, publish };
};
