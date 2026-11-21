const { randomUUID } = require('node:crypto');
const Rules = require('./ClanAmbitionRules');
const { NPC, MOB, ITEM, ID } = Rules;
const COST = require('./ClanRules').LEVEL_REQUIREMENTS[4];

module.exports = ({ one, all, write, inTransaction, withCharacterFlushes, ClanLevelSp }) => {
    const managed = Object.values(ITEM);
    const slots = managed.map(() => '?').join(', ');
    const inventory = id => all(`SELECT id, selfId, amount, equipped, slot FROM items
        WHERE characterId = ? AND selfId IN (${slots}) AND amount > 0 ORDER BY id`, [id, ...managed]);
    function inventoryChanges(id, before) {
        const after = new Map(inventory(id).map(row => [row.id, row]));
        const changes = [];
        for (const row of before) {
            const current = after.get(row.id);
            if (!current) changes.push({ ...row, amount: 0 });
            else if (current.amount !== row.amount) changes.push(current);
            after.delete(row.id);
        }
        return [...changes, ...after.values()];
    }
    const amounts = rows => {
        const result = {};
        for (const { selfId, amount } of rows) result[selfId] = (result[selfId] || 0) + Number(amount);
        return result;
    };
    const quest = id => JSON.parse(one('SELECT variables FROM character_quests WHERE characterId = ? AND questId = ?', [id, ID])?.variables || '{}');
    const save = (id, state) => write(`INSERT INTO character_quests(characterId, questId, state, variables) VALUES (?, ?, ?, ?)
        ON CONFLICT(characterId, questId) DO UPDATE SET state = excluded.state, variables = excluded.variables`,
    [id, ID, state.cond === 13 ? 'completed' : state.cond ? 'started' : 'created', JSON.stringify(state)]);
    const give = (id, item, amount, rows) => {
        const stack = item !== ITEM.brooch && rows.find(row => row.selfId === item);
        if (stack) write('UPDATE items SET amount = amount + ? WHERE id = ?', [amount, stack.id]);
        else write(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId)
            VALUES (?, ?, ?, 0, 0, 0, ?)`, [item, Rules.NAMES[item], amount, id]);
    };
    function take(item, amount, rows) {
        for (const row of rows) {
            if (row.selfId !== item) continue;
            const used = Math.min(amount, row.amount);
            if (used === row.amount) write('DELETE FROM items WHERE id = ?', [row.id]);
            else write('UPDATE items SET amount = amount - ? WHERE id = ?', [used, row.id]);
            amount -= used;
            if (!amount) return;
        }
        throw new Error('Clan ambition inventory changed');
    }
    const clanFor = id => one(`SELECT c.id, c.level, c.leaderId, c.dissolvingExpiryTime AS dissolving
        FROM clans c JOIN characters p ON p.clanId = c.id WHERE p.id = ?`, [id]);
    const eligible = (clan, id, clanId) => clan?.id === clanId && clan.leaderId === id && clan.level === 4
        && Number(clan.dissolving || 0) <= Date.now();

    function hunt(state, items, { npcId, encounter, roll, materialRoll }) {
        const { cond } = state;
        if (cond === 2) {
            if (npcId === MOB.blitz && Rules.CORPSES[encounter]?.ambush && state[encounter]?.kills < 2) {
                state[encounter].kills++;
                return { give: [[ITEM.blitz, 1]] };
            }
            if (MOB.drake === npcId && roll < 0.2 && Rules.count(items, ITEM.drake) < 10)
                return { give: [[ITEM.drake, 1]] };
            if (MOB.thunder === npcId && roll < 0.15 && Rules.count(items, ITEM.thunder) < 10)
                return { give: [[ITEM.thunder, 1]] };
        }
        if (cond === 5 && (npcId === MOB.soldier || npcId === MOB.scout)
            && roll < (npcId === MOB.soldier ? 0.25 : 0.35)) {
            const item = materialRoll < 1 / 3 ? ITEM.stone : materialRoll < 2 / 3 ? ITEM.crystal : ITEM.broken;
            if ((item !== ITEM.broken || state.recipe) && Rules.count(items, item) < (item === ITEM.broken ? 40 : 10))
                return { give: [[item, 1]] };
        }
        if (cond === 10) {
            const ready = Rules.count(items, ITEM.key) >= Rules.KEYS;
            if (!ready && npcId === MOB.guard && roll < 0.15) return { spawn: { id: MOB.keymaster, encounter: 'keymaster', count: 1 } };
            if (!ready && npcId === MOB.keymaster && encounter === 'keymaster' && roll < 0.8)
                return { give: [[ITEM.key, 1]] };
            if (ready && npcId === MOB.keeper) return { spawn: { id: NPC.coffer, encounter: 'coffer', count: 1 } };
        }
        return null;
    }

    function transition({ clanId, leaderId, characterId, event, npcId, attempt, encounter, roll = 1, materialRoll = 1,
        rewardSp = Rules.SP_REWARD }) {
        return withCharacterFlushes([leaderId], () => inTransaction(() => {
            const clan = clanFor(leaderId);
            if (event !== 'abort' && !eligible(clan, leaderId, clanId)) return { ok: false, code: 'level_four_leader_required' };
            let state = quest(leaderId);
            const rows = inventory(leaderId);
            const items = amounts(rows);
            let change;

            if (event === 'kill') {
                if (state.clanId !== clanId || !state.cond || (attempt && attempt !== state.attempt)
                    || (characterId !== leaderId && !one('SELECT id FROM characters WHERE id = ? AND clanId = ?', [characterId, clanId])))
                    return { ok: false, code: 'wrong_attempt' };
                change = hunt(state, items, { npcId, encounter, roll, materialRoll });
                if (!change) return { ok: true, skipped: true };
            } else {
                if (leaderId !== characterId) return { ok: false, code: 'leader_only' };
                if (event === 'start') {
                    if (npcId !== NPC.gustav) return { ok: false, code: 'quest_step_not_ready' };
                    if (state.clanId === clanId && state.cond || Rules.count(items, ITEM.seal))
                        return { ok: false, code: 'quest_already_started' };
                    // Reset proof of progress from an earlier attempt while keeping collected materials.
                    write('DELETE FROM items WHERE characterId = ? AND selfId IN (?, ?, ?, ?)',
                        [leaderId, ITEM.first, ITEM.second, ITEM.third, ITEM.scepter]);
                    state = { clanId, cond: 0, attempt: randomUUID() };
                } else if (event === 'abort') {
                    if (!state.cond || state.cond >= 13) return { ok: false, code: 'no_active_attempt' };
                    for (const row of rows) if (row.selfId !== ITEM.seal) write('DELETE FROM items WHERE id = ?', [row.id]);
                    save(leaderId, {});
                    return { ok: true, state: {}, items: inventoryChanges(leaderId, rows) };
                } else if (state.clanId !== clanId) return { ok: false, code: 'wrong_attempt' };

                if (!Rules.canTalkEvent(state.cond, items, event) || Rules.TALK[event].npc !== npcId)
                    return { ok: false, code: 'quest_step_not_ready' };
                if (event === 'coffer' && (attempt !== state.attempt || encounter !== 'coffer'))
                    return { ok: false, code: 'wrong_coffer' };

                const corpse = Object.hasOwn(Rules.CORPSES, event) ? Rules.CORPSES[event] : null;
                if (corpse) {
                    const first = !Object.hasOwn(state, event);
                    if (first) state[event] = { kills: 0 };
                    const remaining = (corpse.ambush || 0) - state[event].kills;
                    change = { give: first ? corpse.give : [], spawn: remaining ? { id: MOB.blitz, encounter: event, count: remaining } : null };
                } else {
                    change = Rules.TALK[event];
                    if (event === 'recipe') state.recipe = true;
                    state.cond = change.next ?? state.cond;
                }
            }
            for (const [item, amount] of change.take || []) take(item, amount, rows);
            for (const [item, amount] of change.give || []) give(leaderId, item, amount, event === 'start' ? [] : rows);
            const sp = event === 'finish' ? rewardSp : 0;
            if (!Number.isSafeInteger(sp) || sp < 0) throw new Error('Invalid clan ambition SP reward');
            if (event === 'finish') {
                write('DELETE FROM items WHERE characterId = ? AND selfId IN (?, ?, ?, ?)',
                    [leaderId, ITEM.brooch, ITEM.coin, ITEM.recipe, ITEM.broken]);
            }
            if (sp) write('UPDATE characters SET sp = sp + ? WHERE id = ?', [sp, leaderId]);
            save(leaderId, state);
            return { ok: true, state, items: inventoryChanges(leaderId, rows), spawn: change.spawn, awarded: change.give, sp };
        }, 'clan-ambition:transition'));
    }

    function raiseClanToFive({ clanId, characterId }) {
        return ClanLevelSp.withLeader(clanId, () => inTransaction(() => {
            const clan = clanFor(characterId);
            if (!eligible(clan, characterId, clanId)) return { ok: false, code: 'level_four_leader_required' };
            const budget = ClanLevelSp.check(clan, 4, COST.nextLevel);
            if (!budget.ok) return budget;
            const rows = inventory(characterId);
            if (!Rules.count(amounts(rows), ITEM.seal)) return { ok: false, code: 'missing_item', itemName: COST.itemName };
            take(ITEM.seal, 1, rows);
            const levelSp = ClanLevelSp.spend(budget);
            write('UPDATE clans SET level = ? WHERE id = ?', [COST.nextLevel, clanId]);
            const simulation = one('SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [clanId]);
            if (simulation) {
                const now = Date.now();
                const state = { ...JSON.parse(simulation.stateJson || '{}'), level: COST.nextLevel, updatedAt: now };
                write('UPDATE clan_simulation_clans SET stateJson = ?, updatedAt = ? WHERE clanId = ?', [JSON.stringify(state), now, clanId]);
            }
            return { ok: true, level: COST.nextLevel, items: inventoryChanges(characterId, rows), levelSp };
        }, 'clan-ambition:level-up'));
    }

    return { transitionClanAmbition: transition, raiseClanToFive };
};
