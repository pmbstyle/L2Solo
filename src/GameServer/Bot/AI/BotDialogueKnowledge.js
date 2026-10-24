const Protocol = require('./BotDialogueProtocol');

const ACTIONS = ['inspect_self', 'lookup_game', 'find_item_sources', 'recall_event'];
const TOPICS = ['inventory', 'equipment', 'skills', 'party', 'goals', 'relationship', 'relationships', 'recent_events', 'clan_history',
    'items', 'item', 'item_sources', 'npcs', 'npc', 'recipes', 'recipe', 'skill'];
const PAGE_SIZE = 6;

const descriptors = [
    { action: 'inspect_self', description: 'Read inventory, equipment, learned skills, party, goals, relationship with the speaker, relationships with other people, recent_events or clan_history. Leave query empty for all equipment; otherwise filter item names. relationships supports friends/enemies filters. page starts at 1.' },
    { action: 'find_item_sources', description: 'Find actual drop/spoil mobs for an English item name in query, or its entityId. No preliminary item search is needed for an exact name.' },
    { action: 'recall_event', description: 'Check your recorded history before answering about a past raid, drop, trade or shared encounter. query is a short keyword or canonical game name, not the whole question.' },
    { action: 'lookup_game', description: 'Search C4 items/npcs/skills by English name; read item, item_sources, npc, skill, recipes (product ID), recipe (recipe ID). Catalog locations are possible spawns, not live sightings.' }
];

const GROUNDING_PROMPT = 'Current server facts override earlier conversation, including your own replies. Clan and party membership are separate facts. Shop listings are goods for sale or purchase, never evidence of what you wear. Use equipment for worn items and the supplied grade (none means no-grade); never guess a grade from a name. Use relationships for named friends or conflicts; relationship describes only the current speaker. Missing or partial memory does not mean nobody knows you or nobody has attacked you. Never mention runtime, snapshots, off-screen, cold/hot state or tools in character; describe uncertainty naturally.';

function equipmentRows(session) {
    if (session?.actor?.backpack?.fetchItems) return session.actor.backpack.fetchItems()
        .filter(entry => entry.fetchEquipped?.()).map(item);
    if (!session?.inventory || typeof session.inventory !== 'object') return null;
    return Object.values(session.inventory).flatMap(row => Array.isArray(row.instances)
        ? row.instances.filter(instance => instance.equipped).map(instance => ({
            objectId: instance.id, selfId: row.selfId, name: row.name, count: instance.amount,
            equipped: true, grade: row.rank, enchant: instance.enchant, slot: instance.slot, kind: row.kind
        })) : !row.equipped ? [] : [{ selfId: row.selfId, name: row.name, count: row.amount,
            equipped: true, grade: row.rank, enchant: row.enchant, slot: row.slot, kind: row.kind }]);
}

function equipmentPage(rows, decision) {
    const needle = String(decision.query || '').trim().toLowerCase().replace(/^(?:(?:my|your|current|equipped|worn)\s+)+/, '');
    const generic = /^(?:gear|equipment|loadout|items|all)?$/.test(needle);
    const kind = /^(?:weapon|weapons)$/.test(needle) ? 'weapon' : /^(?:armor|armour|clothes)$/.test(needle) ? 'armor' : null;
    const selected = kind ? rows.filter(row => kind === 'weapon'
        ? [7, 14].includes(Number(row.slot)) || /^Weapon\./.test(row.kind || '')
        : /^Armor\./.test(row.kind || '') || [6, 8, 9, 10, 11, 12, 15].includes(Number(row.slot))) : rows;
    const order = [7, 14, 10, 15, 11, 8, 6, 9, 12, 3, 1, 2, 4, 5];
    const priority = row => { const index = order.indexOf(Number(row.slot)); return index < 0 ? 99 : index; };
    return { availableTotal: rows.length, ...page([...selected].sort((a, b) => priority(a) - priority(b)),
        { ...decision, query: generic || kind ? '' : decision.query }) };
}

function clan(session) {
    const service = invoke('GameServer/Clan/ClanService');
    const member = service.clanOfMember(Number(session?.actor?.fetchId?.() || session?.characterId));
    const id = Number(session?.actor?.fetchClanId?.() ?? member?.id ?? 0);
    const value = id ? (Number(member?.id) === id ? member : service.findById(id)) : null;
    return { id, name: value?.name || null };
}

function wantsEquipment(text) {
    return /\b(?:gear|equipment|loadout|wear|wearing|equipped|weapon|armor|armour|grade)\b|\u0448\u043c\u043e\u0442|\u044d\u043a\u0438\u043f|\u043e\u0440\u0443\u0436|\u0431\u0440\u043e\u043d|\u0433\u0440\u0435\u0439\u0434/i.test(String(text || ''));
}

async function relationships(session, decision = {}) {
    const id = Number(session?.actor?.fetchId?.() || session?.characterId);
    const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    await memory.ensureMany([id]);
    const observed = memory.inspect(id);
    if (!observed.ready) return { ok: false, reason: 'relationships_unavailable' };
    const query = String(decision.query || '').trim().toLowerCase();
    const rows = observed.relations.filter(row => row.kind === 'character').map(row => ({
        id: row.targetId, relationship: row.hostility >= 3 || row.trust <= -3 ? 'hostile'
            : row.trust >= 3 || row.affinity >= 3 ? 'friendly' : 'familiar',
        affinity: row.affinity, trust: row.trust, hostility: row.hostility, familiarity: row.familiarity,
        reasons: (row.reasons || []).map(reason => ({ type: reason.type, at: reason.at })),
        lastInteractionAt: row.at
    })).filter(row => query === 'friends' ? row.relationship === 'friendly'
        : query === 'enemies' ? row.relationship === 'hostile' : true)
        .sort((a, b) => (Math.abs(b.affinity) + Math.abs(b.trust) + b.hostility)
            - (Math.abs(a.affinity) + Math.abs(a.trust) + a.hostility) || b.lastInteractionAt - a.lastInteractionAt);
    const result = page(rows, { ...decision, query: '' });
    const ids = result.rows.map(row => row.id);
    const names = ids.length ? await invoke('Database').execute([
        `SELECT id, name FROM characters WHERE id IN (${ids.map(() => '?').join(',')})`, ids
    ]) : [];
    const byId = new Map(names.map(row => [Number(row.id), row.name]));
    return { ok: true, source: 'personal_relationship_memory', completeHistory: false,
        observation: 'Recorded personal impressions, not an exhaustive list of friends or enemies.',
        ...result, rows: result.rows.map(row => ({ ...row, name: byId.get(row.id) || null })) };
}

async function selfContext(session, text, conversation = {}) {
    const result = { clan: clan(session) };
    const followup = /^(?:is (?:it|that)|are (?:they|those)|what about|and (?:it|that|them))\b/i.test(String(text || '').trim())
        && (conversation.recentTurns || []).slice(-4).some(turn => turn.role === 'player' && wantsEquipment(turn.text));
    if (wantsEquipment(text) || followup) {
        const rows = equipmentRows(session);
        result.equipment = rows ? { source: 'worn_equipment', ...equipmentPage(rows, {}) }
            : { available: false, reason: 'equipment_unknown' };
    }
    if (/\b(?:friends?|enemies|enemy|rivals?|acquaintances|know anyone)\b|\u0434\u0440\u0443\u0437|\u0434\u0440\u0443\u0433\u0438|\u0432\u0440\u0430\u0433|\u0437\u043d\u0430\u043a\u043e\u043c/i.test(String(text || ''))) {
        try { result.relationships = await relationships(session); }
        catch (_) { result.relationships = { ok: false, reason: 'relationships_unavailable' }; }
    }
    return result;
}

function page(rows, decision) {
    const needle = String(decision.query || '').trim().toLowerCase();
    const selected = needle ? rows.filter(row => String(row.name || '').toLowerCase().includes(needle) || String(row.id ?? row.selfId) === needle) : rows;
    const current = Math.max(1, Math.min(1000, Math.floor(Number(decision.page) || 1)));
    return { page: current, total: selected.length, hasMore: current * PAGE_SIZE < selected.length,
        rows: selected.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE) };
}

function item(item) {
    return { objectId: item.fetchId?.(), selfId: item.fetchSelfId?.(), name: item.fetchName?.(),
        count: item.fetchAmount?.(), equipped: !!item.fetchEquipped?.(), grade: item.fetchRank?.(),
        slot: item.fetchSlot?.(), kind: item.fetchKind?.(), enchant: item.fetchEnchantLevel?.(),
        pAtk: item.fetchPAtk?.(), mAtk: item.fetchMAtk?.(), pDef: item.fetchPDef?.(), mDef: item.fetchMDef?.() };
}

function persona(subject) {
    const value = invoke('GameServer/Bot/AI/BotPersona').of(subject);
    if (!value) return null;
    return { primaryDrive: value.primaryDrive, archetype: value.archetype,
        dialogueVoice: value.dialogueVoice, textCard: value.textCard };
}

async function relationship(player, subject) {
    if (!player) return null;
    const memory = invoke('GameServer/Bot/AI/BotSocialMemory');
    const value = await memory.load(player, subject) || memory.getSnapshot(player, subject);
    return { playerId: value.playerId, playerName: value.playerName,
        relationship: memory.relationship(value), trust: value.trust, familiarity: value.familiarity,
        groupRuns: value.groupRuns, helpedInCombat: value.helpedInCombat, wipesTogether: value.wipesTogether,
        tradesCompleted: value.tradesCompleted, gratitude: value.gratitude, grudge: value.grudge };
}

async function inspect(decision, { session, playerSession, publicChat = false, clanId: channelClanId }) {
    const actor = session?.actor;
    const id = Number(actor?.fetchId?.() || session?.characterId);
    switch (decision.topic) {
    case 'clan_history': {
        const clans = invoke('GameServer/Clan/ClanService');
        const clan = channelClanId ? clans.findById(channelClanId)
            : clans.clanOfMember(id) || clans.findById(actor?.fetchClanId?.());
        const clanId = Number(clan?.id || 0);
        if (!clan || Number(playerSession?.actor?.fetchClanId?.()) !== clanId ||
            !clan.members?.some(member => Number(member.id) === id)) return { ok: false, reason: 'clan_history_unavailable' };
        return { ok: true, source: 'public_clan_history', rows: await require('./BotClanConversationStore').recent(clanId, { limit: 6 }) };
    }
    case 'inventory': case 'equipment': {
        if (decision.topic === 'equipment') {
            const rows = equipmentRows(session);
            return rows ? { ok: true, source: actor ? 'current_equipment' : 'persistent_equipment',
                historyEvidence: false, ...equipmentPage(rows, decision) }
                : { ok: false, reason: 'equipment_unknown' };
        }
        if (!actor?.backpack?.fetchItems) {
            if (!session?.inventory || typeof session.inventory !== 'object') return { ok: false, reason: 'inventory_unknown' };
            const rows = Object.values(session.inventory).map(row => ({
                    selfId: row.selfId, name: row.name, count: row.amount, equipped: !!row.equipped, grade: row.rank
                }));
            return { ok: true, source: 'persistent_inventory_snapshot', updatedAt: session.updatedAt || null,
                historyEvidence: false, observation: 'Snapshot holdings, not proof of any past encounter or drop.', ...page(rows, decision) };
        }
        const rows = actor.backpack.fetchItems()
            .filter(entry => decision.topic !== 'equipment' || entry.fetchEquipped?.()).map(item);
        return { ok: true, source: 'current_inventory', historyEvidence: false,
            observation: 'Current holdings only. Absence of an item does not prove a past drop, trade or encounter.', ...page(rows, decision) };
    }
    case 'skills': {
        if (!actor?.skillset?.fetchSkills) return { ok: false, reason: 'skills_unknown' };
        const rows = actor.skillset.fetchSkills().filter(skill => !skill.fetchPassive())
            .map(skill => ({ id: skill.fetchSelfId(), name: skill.model?.name, level: skill.fetchLevel(),
                mpCost: skill.fetchConsumedMp(), range: skill.fetchDistance() }));
        return { ok: true, ...page(rows, decision) };
    }
    case 'relationship': return publicChat ? { ok: false, reason: 'private_memory' }
        : { ok: true, relationship: await relationship(playerSession, session) };
    case 'relationships': return publicChat ? { ok: false, reason: 'private_memory' } : relationships(session, decision);
    case 'recent_events': {
        const events = await invoke('GameServer/Bot/AI/BotEventJournal').search({
            botId: id, playerId: publicChat ? null : playerSession?.actor?.fetchId?.(), limit: PAGE_SIZE
        });
        return { ok: true, source: 'personal_journal', completeHistory: false,
            observation: 'Only these recorded events are known. Missing records mean unknown, not proof an event never happened.',
            rows: events.map(event => ({ type: event.eventType, summary: event.summary, at: event.updatedAt })) };
    }
    case 'goals': {
        const state = actor ? invoke('GameServer/Bot/Population/BotLifeState').cachedState(id) : session;
        const plan = state?.stats?.equipmentPlan;
        const errand = session.companionShopping || state?.stats?.supplyErrand;
        return { ok: true, activity: session.plan || state?.activity || null,
            equipmentGoal: plan ? { target: plan.target, phase: plan.phase, reason: plan.reason } : null,
            supplyErrand: errand ? { itemId: errand.itemId || errand.itemSelfId, itemName: errand.itemName,
                amount: errand.amount, phase: session.supplyErrandPhase || errand.phase,
                totalCost: errand.totalCost, expiresAt: errand.expiresAt } : null };
    }
    case 'party': {
        if (!actor) return { ok: true, party: session?.party || null, observation: 'persistent_snapshot' };
        const status = invoke('GameServer/Bot/AI/BotStatus').getStatus(session);
        return { ok: true, party: Protocol.compact(status.party, { rows: 9, depth: 4 }) };
    }
    default: return { ok: false, reason: 'unknown_inspection_topic' };
    }
}

function lookup(decision, service = invoke('GameServer/World/Generics/NativeKnowledgeBase')()) {
    let entityId = Number(decision.entityId || 0);
    const current = Math.max(1, Math.min(1000, Math.floor(Number(decision.page) || 1)));
    const query = String(decision.query || '').trim().slice(0, 100);
    if (['items', 'npcs', 'skills'].includes(decision.topic)) {
        const result = decision.topic === 'items'
            ? service.listItems({ q: query, page: current, limit: PAGE_SIZE, exactFirst: true })
            : decision.topic === 'skills' ? service.listSkills({ q: query, page: current, limit: PAGE_SIZE })
                : service.listNpcs({ q: query, page: current, limit: PAGE_SIZE });
        return { ok: true, source: 'server_catalogue', page: result.page, total: result.total,
            hasMore: result.page < result.pages, rows: result.items.map(row => ({
                id: row.id, name: row.name, level: row.level, grade: row.grade, kind: row.kind,
                price: row.price, raidBoss: row.raidBoss
            })) };
    }
    if ((!Number.isSafeInteger(entityId) || entityId <= 0) && query && ['item', 'item_sources', 'recipes'].includes(decision.topic)) {
        const found = service.listItems({ q: query, limit: PAGE_SIZE, exactFirst: true });
        const exact = found.items.find(row => row.name.toLowerCase() === query.toLowerCase());
        if (exact || found.total === 1) entityId = Number((exact || found.items[0]).id);
        else return { ok: false, reason: 'ambiguous_item_name', candidates: found.items.map(row => ({ id: row.id, name: row.name })) };
    }
    if (!Number.isSafeInteger(entityId) || entityId <= 0) return { ok: false, reason: 'entity_id_required_search_first' };
    if (decision.topic === 'skill') {
        const skill = service.skillDetail(entityId);
        return skill ? { ok: true, source: 'server_catalogue', skill } : { ok: false, reason: 'skill_not_found' };
    }
    if (decision.topic === 'item' || decision.topic === 'item_sources') {
        const result = service.itemDetail(entityId);
        if (!result) return { ok: false, reason: 'item_not_found' };
        if (decision.topic === 'item') return { ok: true, source: 'server_catalogue', item: {
            id: result.id, name: result.name, grade: result.grade, kind: result.kind, stats: result.stats, template: result.template
        } };
        const sources = ['drops', 'spoils'].flatMap(method => (result.sources?.[method] || []).map(row => ({
            method, npcId: row.id, name: row.name, level: row.level,
            chancePercent: row.chancePercent, expectedAmountPerKill: row.expectedAmountPerKill, availability: row.availability
        })));
        return { ok: true, source: 'server_catalogue', item: { id: result.id, name: result.name },
            ...page(sources, { ...decision, query: '' }), rateProfile: result.rateProfile,
            observation: 'Catalog sources are possibilities, not a live sighting or personal encounter.' };
    }
    if (decision.topic === 'npc') {
        const result = service.npcDetail(entityId);
        if (!result) return { ok: false, reason: 'npc_not_found' };
        return { ok: true, source: 'server_catalogue', npc: { id: result.id, name: result.name,
            level: result.level, raidBoss: result.raidBoss, weaknesses: result.weaknesses,
            locations: (result.spawns || []).slice(0, 3).map(row => ({ period: row.period,
                points: row.mapPoints?.slice(0, 2), respawnSeconds: row.respawnSeconds })) },
        observation: 'Spawn definitions only. Current life, occupancy and personal experience are unknown.' };
    }
    if (decision.topic === 'recipes' || decision.topic === 'recipe') {
        const catalogue = service.catalogue();
        if (!catalogue.capabilities().recipes) return { ok: false, reason: 'recipes_unavailable' };
        if (decision.topic === 'recipe') {
            const row = catalogue.recipe(entityId);
            return row ? { ok: true, source: 'server_catalogue', id: row.recipeId, productId: row.productId,
                amount: row.productCount, chancePercent: row.successRate,
                ...page((catalogue.ingredientsForRecipe(entityId) || []).map(part => ({ ...part,
                    name: service.itemOverview(part.selfId)?.name })), { ...decision, query: '' }) }
                : { ok: false, reason: 'recipe_not_found' };
        }
        const rows = catalogue.recipesForProduct(entityId) || [];
        return { ok: true, source: 'server_catalogue', ...page(rows.map(row => ({
            id: row.recipeId, name: row.name, productId: row.productId, amount: row.productCount,
            chancePercent: row.successRate, ingredientCount: catalogue.ingredientsForRecipe(row.recipeId)?.length,
            instruction: 'Read topic=recipe with this id for paginated ingredient quantities.'
        })), { ...decision, query: '' }) };
    }
    return { ok: false, reason: 'unknown_catalogue_topic' };
}

async function execute(decision, context) {
    try {
        if (decision.action === 'recall_event') {
            const rows = await invoke('GameServer/Bot/AI/BotEventJournal').search({
                botId: context.session?.actor?.fetchId?.() || context.session?.characterId,
                playerId: context.publicChat ? null : context.playerSession?.actor?.fetchId?.(), query: decision.query
            });
            return { ok: true, source: 'personal_journal', rows: rows.map(row => ({
                id: row.id, type: row.eventType, summary: row.summary, at: row.updatedAt
            })), ...(!rows.length ? { terminalReply: "I don't remember that." } : {}) };
        }
        const result = decision.action === 'inspect_self' ? await inspect(decision, context)
            : decision.action === 'lookup_game' ? lookup(decision)
                : decision.action === 'find_item_sources' ? lookup({ ...decision, topic: 'item_sources' }) : { ok: false, reason: 'unknown_read_tool' };
        return Protocol.compact(result, { rows: PAGE_SIZE });
    } catch (_) {
        return { ok: false, reason: 'knowledge_unavailable' };
    }
}

module.exports = { ACTIONS, TOPICS, descriptors, GROUNDING_PROMPT, execute, inspect, lookup, persona, relationship, selfContext };
