'use strict';

const MODES = ['need', 'random', 'turn'];
const positive = value => Math.max(0, Number(value) || 0);
const trait = (persona, key) => Math.max(0, Math.min(1, Number(persona?.traits?.[key] ?? 0.5)));

function propose(leader, members, objective, { persona, rng = Math.random, affinity = 0 } = {}) {
    const weights = [1 + trait(persona, 'empathy') + Math.max(0, affinity),
        1 + (1 - trait(persona, 'commitment')), 1 + trait(persona, 'commitment')];
    let roll = Math.max(0, Math.min(0.999999, rng())) * weights.reduce((sum, value) => sum + value, 0);
    const mode = MODES.find((_, index) => (roll -= weights[index]) < 0) || 'turn';
    const help = objective?.helpDeal;
    const fee = Math.floor(positive(help?.fee));
    const Material = require('./CraftMaterialParty');
    return { mode, spoil: 'spoiler', ...(Material.isObjective(objective) ? Material.agreement(members, objective) : {}),
        cursor: 0, leaderId: Number(leader.characterId),
        memberIds: members.map(member => Number(member.characterId)),
        ...(fee > 0 && Number(help?.itemId) > 0 ? { help: { payerId: Number(help.payerId),
            itemId: Number(help.itemId), count: Math.max(1, Math.floor(positive(help.count))),
            fee, remaining: fee, status: 'proposed' } } : {}) };
}

// This policy only moves the encounter's actual rewards. It cannot create
// currency or pay an order: the native party transaction settles its escrow.
function allocate(memberResults, agreement, { rng = Math.random, needScore = () => -Infinity } = {}) {
    if (!agreement || !MODES.includes(agreement.mode) || !memberResults.length) return null;
    const copies = memberResults.map(entry => ({ ...entry, result: { ...entry.result,
        materialize: { ...entry.result.materialize, items: [] } } }));
    const projected = new Map(copies.map(entry => [Number(entry.state.characterId), { ...entry.state.inventory }]));
    const transfers = [];
    const materialNeeds = agreement.materialNeeds?.slice(0, require('./CraftMaterialParty').MAX_MEMBERS).map(row => ({ ...row }));
    let cursor = Math.max(0, Math.floor(positive(agreement.cursor)));
    for (const source of memberResults) for (const item of source.result.materialize?.items || []) {
        let unassigned = positive(item.amount);
        // At most one split per member, never a loop per dropped unit. Only
        // this hunt's declared components override the ordinary loot policy.
        if (materialNeeds) {
            const Material = require('./CraftMaterialParty');
            const goals = materialNeeds
                .filter(goal => Number(goal.itemId) === Number(item.selfId));
            for (const goal of goals) {
                const owner = copies.find(entry => Number(entry.state.characterId) === Number(goal.characterId));
                if (!owner || !unassigned) continue;
                const inventory = projected.get(Number(owner.state.characterId));
                const count = Math.min(unassigned, Material.remaining(owner.state, goal, inventory));
                if (!(count > 0)) continue;
                const reward = { ...item, amount: count }; delete reward.partySpoil;
                owner.result.materialize.items.push(reward);
                goal.collected = positive(goal.collected) + count;
                inventory[item.selfId] = { ...inventory[item.selfId], ...reward,
                    amount: positive(inventory[item.selfId]?.amount) + count };
                if (Number(owner.state.characterId) !== Number(source.state.characterId))
                    transfers.push({ from: source.state, to: owner.state, item: reward });
                unassigned -= count;
            }
            if (!unassigned) continue;
        }
        const distributedItem = unassigned === positive(item.amount) ? item : { ...item, amount: unassigned };
        let recipient = copies.find(entry => Number(entry.state.characterId) === Number(source.state.characterId));
        const helpOwner = agreement.help?.status === 'funded' && Number(item.selfId) === Number(agreement.help.itemId)
            ? copies.find(entry => Number(entry.state.characterId) === Number(agreement.help.payerId)) : null;
        if (helpOwner) recipient = helpOwner;
        else if (item.partySpoil && (agreement.spoil === 'spoiler' || agreement.materialNeeds)) { /* The original spoiler keeps unreserved spoil. */ }
        else if (agreement.materialNeeds) recipient = copies[cursor++ % copies.length];
        else if (agreement.mode === 'turn') recipient = copies[cursor++ % copies.length];
        else if (agreement.mode === 'random') recipient = copies[Math.min(copies.length - 1, Math.floor(rng() * copies.length))];
        else {
            const scores = copies.map(entry => ({ entry, score: needScore(entry.state, item, projected) }));
            const best = Math.max(...scores.map(row => row.score));
            const tied = scores.filter(row => Number.isFinite(row.score) && row.score === best);
            if (tied.length) recipient = tied[Math.min(tied.length - 1, Math.floor(rng() * tied.length))].entry;
        }
        const reward = { ...distributedItem }; delete reward.partySpoil;
        recipient.result.materialize.items.push(reward);
        const inventory = projected.get(Number(recipient.state.characterId));
        projected.set(Number(recipient.state.characterId), { ...inventory, [item.selfId]: { ...inventory[item.selfId], ...item,
            amount: positive(inventory[item.selfId]?.amount) + positive(distributedItem.amount) } });
        if (Number(recipient.state.characterId) !== Number(source.state.characterId)) {
            transfers.push({ from: source.state, to: recipient.state, item: distributedItem });
        }
    }
    return { memberResults: copies, transfers, agreement: { ...agreement, cursor, ...(materialNeeds ? { materialNeeds } : {}) } };
}

function feeText(value) {
    const fee = Math.floor(positive(value));
    if (fee < 1000) return String(fee);
    if (fee < 999500) return `${Math.round(fee / 1000)}k`;
    return `${(fee / 1000000).toFixed(1).replace(/\.0$/, '')}kk`;
}

function describe(goal, agreement, { place, includeGoal = true } = {}) {
    const itemName = id => require('../../Item/ItemTemplateIndex')
        .find(invoke('GameServer/DataCache').items, id)?.template?.name;
    const help = agreement?.help;
    const named = itemName(includeGoal && help?.fee > 0 ? help.itemId : includeGoal && goal?.itemId);
    const destination = includeGoal && goal?.spotId
        ? invoke('GameServer/Bot/AI/BotChatLocation').describe({ spotId: goal.spotId }) : null;
    const namedPlace = destination && destination !== 'my hunting spot' && destination !== place;
    let target = '';
    if (named && help?.fee > 0) target = `need help farming ${named}, paying ${feeText(help.fee)}`;
    else if (named) target = `farming ${named}${namedPlace ? ` in ${destination}` : ''}`;
    else if (namedPlace && !goal?.itemId) target = `heading to ${destination}`;
    const loot = { need: 'loot by need', random: 'loot random', turn: 'loot by turn' }[agreement?.mode];
    return [target, loot].filter(Boolean).join(', ');
}

function formationText(name, spotId, goal, agreement) {
    const place = invoke('GameServer/Bot/AI/BotChatLocation').describe({ spotId });
    const clause = describe(goal, agreement, { place });
    return `${name} formed a party at ${place}${clause ? `: ${clause}` : ''}.`;
}

module.exports = { MODES, propose, allocate, describe, formationText };
