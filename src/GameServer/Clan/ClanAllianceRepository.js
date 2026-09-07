const Rules = require('./ClanAllianceRules');
const { GAME_MINUTE_MS } = require('../World/GameTime');
const runtimeEpoch = require('crypto').randomUUID();

// All progress and physical quest-item writes share the server's transaction
// queue. JSON is scoped to one clan; no separate connection can race saves.
module.exports = function repository({ one, all, write, inTransaction, withCharacterFlushes }) {
    const ensure = () => write(`CREATE TABLE IF NOT EXISTS clan_alliance_quests (
        clanId INTEGER PRIMARY KEY REFERENCES clans(id) ON DELETE CASCADE,
        stateJson TEXT NOT NULL)`);
    const read = clanId => {
        const row = one('SELECT stateJson FROM clan_alliance_quests WHERE clanId = ?', [clanId]);
        return row ? JSON.parse(row.stateJson) : null;
    };
    const save = (clanId, state) => write(`INSERT INTO clan_alliance_quests(clanId, stateJson) VALUES (?, ?)
        ON CONFLICT(clanId) DO UPDATE SET stateJson = excluded.stateJson`, [clanId, JSON.stringify(state)]);
    const count = (id, itemId) => Number(one('SELECT COALESCE(SUM(amount), 0) AS n FROM items WHERE characterId = ? AND selfId = ?', [id, itemId]).n);
    const give = (id, itemId) => write(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId)
        VALUES (?, ?, 1, 0, 0, 0, ?)`, [itemId, Rules.ITEMS[itemId], id]);
    const take = (id, itemId, amount = 1) => {
        if (count(id, itemId) < amount) throw new Error('Alliance quest inventory changed');
        for (const row of all('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? AND amount > 0 ORDER BY id', [id, itemId])) {
            const used = Math.min(amount, Number(row.amount));
            if (used === Number(row.amount)) write('DELETE FROM items WHERE id = ?', [row.id]);
            else write('UPDATE items SET amount = amount - ? WHERE id = ?', [used, row.id]);
            amount -= used;
            if (!amount) break;
        }
    };
    const questLog = state => write(`INSERT INTO character_quests(characterId, questId, state, variables) VALUES (?, 501, ?, ?)
        ON CONFLICT(characterId, questId) DO UPDATE SET state = excluded.state, variables = excluded.variables`,
    [state.leaderId, ['completed', 'failed'].includes(state.stage) ? 'created' : 'started', JSON.stringify({ cond: { started: 1, loyalty: 2, gathering: 3, cured: 4 }[state.stage] || 0 })]);
    const validRoster = (state, clan) => state.leaderId === Number(clan.leaderId) && state.members.every(member =>
        one('SELECT id FROM characters WHERE id = ? AND clanId = ?', [member.id, clan.id]));
    const cleanup = state => {
        // Delete only the actual item objects minted by this attempt, wherever
        // they ended up after a legitimate trade; never unrelated inventory.
        for (const id of state.itemObjectIds || []) write('DELETE FROM items WHERE id = ?', [id]);
    };
    function award(state, id, itemId) {
        const result = give(id, itemId);
        state.itemObjectIds.push(Number(result.insertId));
    }
    return {
        raisePlayerClanToFour({ clanId, characterId }) {
            return withCharacterFlushes([characterId], () => inTransaction(() => {
                ensure();
                const clan = one('SELECT * FROM clans WHERE id = ?', [clanId]);
                const actor = one('SELECT * FROM characters WHERE id = ?', [characterId]);
                const state = read(clanId);
                if (!clan || Number(clan.leaderId) !== Number(characterId) || Number(actor?.clanId) !== Number(clanId)) return { ok: false, code: 'not_leader' };
                if (Number(clan.level) !== 3) return { ok: false, code: 'level_already_advanced' };
                if (Number(actor.sp) < Rules.SP_COST) return { ok: false, code: 'not_enough_sp' };
                if (state?.kind !== 'player' || state.stage !== 'completed' || state.leaderId !== Number(characterId) || !count(characterId, 3874))
                    return { ok: false, code: 'missing_item', itemName: 'Proof of Alliance (complete the clan trial)' };
                take(characterId, 3874);
                write('UPDATE characters SET sp = sp - ? WHERE id = ?', [Rules.SP_COST, characterId]);
                write('UPDATE clans SET level = 4 WHERE id = ?', [clanId]);
                return { ok: true, sp: Number(actor.sp) - Rules.SP_COST, level: 4 };
            }, 'clan-alliance:player-level-up'));
        },
        fetchClanAllianceQuest(clanId) {
            return inTransaction(() => {
                ensure();
                const state = read(Number(clanId));
                const clan = one('SELECT * FROM clans WHERE id = ?', [clanId]);
                if (state?.kind === 'player' && !['completed', 'failed'].includes(state.stage)
                    && (!clan || Number(clan.level) !== 3 || !validRoster(state, clan))) {
                    cleanup(state); state.stage = 'failed'; save(clanId, state); questLog(state);
                }
                return state;
            }, 'clan-alliance:read');
        },
        resolveBotClanAlliance(clanId, timestamp = Date.now(), epoch = runtimeEpoch) {
            return inTransaction(() => {
                ensure();
                const clan = one(`SELECT c.*, s.mode FROM clans c JOIN clan_simulation_clans s ON s.clanId = c.id WHERE c.id = ?`, [clanId]);
                const leader = clan && one('SELECT username, level FROM characters WHERE id = ? AND clanId = ?', [clan.leaderId, clanId]);
                if (!clan || clan.mode !== 'autonomous' || !String(leader?.username).startsWith('bot_') || Number(clan.level) !== 3)
                    return { ok: true, skipped: true };
                const ready = all(`SELECT id FROM characters WHERE clanId = ? AND level >= ? AND username LIKE 'bot_%'
                    ORDER BY id`, [clanId, Rules.BOT_LEVEL]).map(row => Number(row.id));
                let state = read(clanId);
                if (Number(leader.level) < Rules.BOT_LEVEL || ready.filter(id => id !== Number(clan.leaderId)).length < 3) {
                    if (state?.kind === 'bot') { state.stage = 'waiting'; state.elapsedMs = 0; save(clanId, state); }
                    return { ok: true, skipped: true, reason: 'leader_and_three_members_need_level_60' };
                }
                if (state?.kind !== 'bot' || state.stage !== 'running' || state.leaderId !== Number(clan.leaderId)
                    || !state.members.every(id => ready.includes(id))) {
                    state = { kind: 'bot', stage: 'running', leaderId: Number(clan.leaderId),
                        members: [Number(clan.leaderId), ...ready.filter(id => id !== Number(clan.leaderId)).slice(0, 3)],
                        elapsedMs: 0, lastTick: timestamp, epoch };
                } else {
                    // First tick after a restart establishes a new baseline;
                    // downtime does not count as time spent playing.
                    if (state.epoch === epoch) state.elapsedMs += Math.max(0, timestamp - state.lastTick);
                    state.lastTick = timestamp; state.epoch = epoch;
                }
                const advanced = state.elapsedMs >= Rules.BOT_GAME_MINUTES * GAME_MINUTE_MS;
                if (advanced) {
                    write('UPDATE clans SET level = 4 WHERE id = ? AND level = 3', [clanId]);
                    const simulation = one('SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [clanId]);
                    const projection = JSON.parse(simulation.stateJson || '{}');
                    projection.level = 4; projection.goal = null; projection.updatedAt = timestamp;
                    write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [timestamp, JSON.stringify(projection), clanId]);
                    state.stage = 'completed';
                }
                save(clanId, state);
                if (!advanced) {
                    const row = one('SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [clanId]);
                    const projection = JSON.parse(row.stateJson || '{}');
                    if (projection.goal?.plan?.kind === 'alliance_trial') {
                        projection.goal.progress = Math.floor(state.elapsedMs / GAME_MINUTE_MS);
                        projection.updatedAt = timestamp;
                        write('UPDATE clan_simulation_clans SET updatedAt = ?, stateJson = ? WHERE clanId = ?', [timestamp, JSON.stringify(projection), clanId]);
                    }
                } else {
                    write(`INSERT INTO clan_goal_events(clanId, eventType, goalType, plan, reasonCode, payloadJson, occurredAt)
                        VALUES (?, 'alliance_trial_completed', 'level', 'alliance_trial', 'clan_level_four', ?, ?)`, [clanId, JSON.stringify(state), timestamp]);
                }
                return { ok: true, advanced: { ok: advanced }, state };
            }, 'clan-alliance:bot');
        },
        transitionClanAlliance({ clanId, characterId, event, members = [], npcId = 0, roll = 1, chestToken = '', rewardSp = Rules.SP_REWARD, timestamp = Date.now() }) {
            const ids = [characterId, ...members];
            return withCharacterFlushes(ids, () => inTransaction(() => {
                ensure();
                const clan = one('SELECT * FROM clans WHERE id = ?', [clanId]);
                const actor = one('SELECT id, username, clanId FROM characters WHERE id = ?', [characterId]);
                if (!clan || Number(clan.level) !== 3 || Number(actor?.clanId) !== Number(clanId)) return { ok: false, code: 'clan_level_three_required' };
                const isLeader = Number(clan.leaderId) === Number(characterId);
                const leader = one('SELECT username FROM characters WHERE id = ?', [clan.leaderId]);
                if (String(leader?.username).startsWith('bot_')) return { ok: false, code: 'player_clan_required' };
                let state = read(clanId);
                if (state && state.kind === 'player' && !['completed', 'failed'].includes(state.stage) && !validRoster(state, clan)) {
                    cleanup(state); state.stage = 'failed'; save(clanId, state); questLog(state);
                }
                if (event === 'start' && isLeader && (!state || ['failed', 'completed'].includes(state.stage)) && !count(characterId, 3874)) {
                    state = { kind: 'player', stage: 'started', leaderId: Number(characterId), members: [], itemObjectIds: [], startedAt: timestamp };
                } else {
                    if (!state || state.kind !== 'player' || !validRoster(state, clan)) return { ok: false, code: 'quest_not_active', state };
                    const member = state.members.find(entry => entry.id === Number(characterId));
                    if (event === 'ritual' && isLeader && state.stage === 'started') {
                        const selected = [...new Set(members.map(Number))].filter(id => id !== Number(characterId));
                        if (selected.length !== 3 || selected.some(id => !one('SELECT id FROM characters WHERE id = ? AND clanId = ?', [id, clanId])))
                            return { ok: false, code: 'three_clan_members_required', state };
                        state.members = selected.map((id, i) => ({ id, itemId: Rules.HERBS[i].itemId, npcId: Rules.HERBS[i].npcId,
                            blood: i === 2, pledged: false, loyaltyDelivered: false, herb: false, delivered: false, bloodDelivered: false }));
                        state.stage = 'loyalty';
                    } else if (event === 'pledge' && member && state.stage === 'loyalty' && !member.pledged) {
                        member.pledged = true; award(state, characterId, 3837);
                    } else if (event === 'deliver' && member && ['loyalty', 'gathering'].includes(state.stage)) {
                        if (state.stage === 'loyalty' && member.pledged && !member.loyaltyDelivered && count(characterId, 3837)) {
                            take(characterId, 3837); award(state, state.leaderId, 3837); member.loyaltyDelivered = true;
                        }
                        if (state.stage === 'gathering') {
                            if (member.herb && !member.delivered && count(characterId, member.itemId)) {
                                take(characterId, member.itemId); award(state, state.leaderId, member.itemId); member.delivered = true;
                            }
                            if (member.blood && state.bloodObtained && !member.bloodDelivered && count(characterId, 3835)) {
                                take(characterId, 3835); award(state, state.leaderId, 3835); member.bloodDelivered = true;
                            }
                        }
                    } else if (event === 'poison' && isLeader && state.stage === 'loyalty' && state.members.every(m => m.loyaltyDelivered) && count(characterId, 3837) >= 3) {
                        take(characterId, 3837, 3); award(state, characterId, 3872);
                        state.stage = 'gathering'; state.poisonedAt = timestamp;
                    } else if (event === 'kill' && member && state.stage === 'gathering' && Number(npcId) === member.npcId && !member.herb && roll < Rules.DROP_CHANCE) {
                        award(state, characterId, member.itemId); member.herb = true;
                    } else if (event === 'chests' && member?.blood && state.stage === 'gathering' && !state.bloodObtained
                        && (!state.chests || state.chests.deadline <= timestamp)) {
                        if (state.chestAttempts && count(characterId, 57) < 10000) return { ok: false, code: 'chest_retry_costs_10000_adena', state };
                        if (state.chestAttempts) take(characterId, 57, 10000);
                        state.chestAttempts = (state.chestAttempts || 0) + 1;
                        state.chests = { token: `${state.startedAt}:${state.chestAttempts}`, deadline: timestamp + 60000, kills: [], bingo: 0 };
                    } else if (event === 'chest_kill' && member?.blood && state.stage === 'gathering' && state.chests?.token === chestToken
                        && state.chests.deadline > timestamp && !state.chests.kills.includes(npcId) && state.chests.bingo < 4) {
                        state.chests.kills.push(npcId);
                        if (roll < 0.6) state.chests.bingo += 1;
                    } else if (event === 'blood' && member?.blood && state.stage === 'gathering' && state.chests?.bingo >= 4 && !state.bloodObtained) {
                        award(state, characterId, 3835); state.bloodObtained = true;
                    } else if (event === 'cure' && isLeader && state.stage === 'gathering' && state.members.every(m => m.delivered && (!m.blood || m.bloodDelivered))
                        && [3832,3833,3834,3835,3872].every(id => count(characterId, id))) {
                        [3832,3833,3834,3835,3872].forEach(id => take(characterId, id));
                        award(state, characterId, 3873); state.stage = 'cured';
                    } else if (event === 'finish' && isLeader && state.stage === 'cured' && count(characterId, 3873)) {
                        take(characterId, 3873); award(state, characterId, 3874); state.stage = 'completed';
                        write('UPDATE characters SET sp = sp + ? WHERE id = ?', [Math.max(0, Math.floor(rewardSp)), characterId]);
                    } else if (event === 'fail' && isLeader && ['started', 'loyalty', 'gathering', 'cured'].includes(state.stage)) {
                        cleanup(state); state.stage = 'failed';
                    } else return { ok: false, code: 'quest_step_not_ready', state };
                }
                save(clanId, state); questLog(state);
                return { ok: true, state, sp: Number(one('SELECT sp FROM characters WHERE id = ?', [characterId]).sp) };
            }, 'clan-alliance:transition'));
        }
    };
};
