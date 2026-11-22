const Protocol = require('./BotDialogueProtocol');
const { EVENT_TYPES, COMBAT_EVENT_TYPES } = require('./BotCombatMemory');
const LocalObservation = require('./BotLocalObservation');

const REMOTE_ACTIONS = ['inspect_self', 'lookup_game', 'find_item_sources', 'recall_event'];
const ACTIONS = [...REMOTE_ACTIONS, 'look_around'];
const TOPICS = ['inventory', 'equipment', 'skills', 'party', 'goals', 'relationship', 'relationships', 'recent_events', 'clan', 'clan_history',
    'items', 'item', 'item_sources', 'npcs', 'npc', 'recipes', 'recipe', 'skill'];
const PAGE_SIZE = 6;

const descriptors = [
    { action: 'inspect_self', description: 'Read inventory, equipment, skills, party, goals (progress/blockers), clan (role/goal/task), recent_events or clan_history. relationship is the speaker; relationships takes a character name or friends/enemies in query. Empty query shows all equipment.' },
    { action: 'find_item_sources', description: 'Find actual drop/spoil mobs for an English item name in query, or its entityId. No preliminary item search is needed for an exact name.' },
    { action: 'recall_event', description: 'Recall recorded PvP, raids, drops, trades or shared encounters. query is a short keyword or canonical name.' },
    { action: 'lookup_game', description: 'Search C4 items/npcs/skills by English name; read item, item_sources, npc, skill, recipes (product ID), recipe (recipe ID). Catalog locations are possible spawns, not live sightings.' },
    { action: 'look_around', description: 'Read visible nearby people, mobs and confirmed threats from your current position. No arguments.' }
];

function actionsFor(session) {
    return LocalObservation.available(session) ? ACTIONS : REMOTE_ACTIONS;
}

const GROUNDING_PROMPT = 'Server facts override earlier conversation. Clan and party membership are separate. Read inventory for items in your bag. Use equipment for worn items and never guess grade (none means no-grade). Read relationships for how you know a named character; relationship is only the speaker. Partial memory cannot rule out past encounters. Never mention runtime, snapshots, off-screen, cold/hot state or tools in character.';

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

function clanFor(session) {
    const service = invoke('GameServer/Clan/ClanService');
    const member = service.clanOfMember(Number(session?.actor?.fetchId?.() || session?.characterId));
    const id = Number(session?.actor?.fetchClanId?.() ?? member?.id ?? 0);
    return { id, value: id ? (Number(member?.id) === id ? member : service.findById(id)) : null };
}

function lifeState(session, id) {
    if (!session.actor) return session;
    const saved = invoke('GameServer/Bot/Population/BotLifeState').cachedState(id);
    return { ...saved, ...session.coldLifeState,
        stats: session.coldLifeState?.stats ?? session.decisionStats ?? saved?.stats };
}

async function inspectClan(session, id) {
    const { id: clanId, value } = clanFor(session);
    if (!clanId) return { ok: true, clan: null };
    if (!value?.members?.some(entry => Number(entry.id) === id)) return { ok: false, reason: 'clan_unavailable' };
    const [row] = await invoke('Database').execute([
        'SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [clanId]
    ], 'bot-dialogue:clan-state');
    const { id: currentClanId, value: clan } = clanFor(session);
    const member = clan?.members?.find(entry => Number(entry.id) === id);
    if (currentClanId !== clanId || !member) return { ok: false, reason: 'clan_membership_changed' };
    const state = row ? JSON.parse(row.stateJson) : null;
    const stats = lifeState(session, id).stats;
    const objective = stats?.clanPartyObjective;
    const gear = stats?.equipmentPlan;
    const goals = [state?.goal, state?.productionGoal].filter(goal => goal && goal.status !== 'completed');
    return {
        ok: true,
        clan: { id: clanId, name: clan.name, level: clan.level,
            position: Number(clan.leaderId) === id ? 'leader' : 'member',
            title: session.actor?.fetchTitle?.() ?? member.title ?? null },
        strategy: state?.strategy?.status === 'active' ? state.strategy.objective : null,
        goals: goals.map(goal => {
            const ownPartyTask = goal.goalKey && objective?.clanGoalKey === goal.goalKey
                && Number(objective.clanId) === clanId && objective.status === 'open';
            const ownGearTask = goal.status === 'executing' && goal.goalKey && gear?.clanGoal?.goalKey === goal.goalKey
                && Number(gear.clanGoal.clanId) === clanId && ['active', 'component_ready', 'ready_to_craft'].includes(gear.status);
            const onRoster = goal.assignedMemberIds?.some(memberId => Number(memberId) === id);
            const assigned = ownGearTask || onRoster;
            return {
                type: goal.type, status: goal.status, progress: goal.progress, required: goal.required,
                itemName: goal.target?.itemName, itemId: goal.target?.itemId,
                ...(goal.type === 'level' ? { targetMemberLevel: goal.target?.level } : { targetLevel: goal.target?.level }),
                npcId: goal.target?.npcId ?? goal.plan?.sourceId, npcName: goal.target?.npcName,
                approach: goal.plan?.kind, reason: goal.reasonCodes?.[0] ?? goal.plan?.reasonCode,
                assignment: assigned ? {
                    role: Number(goal.target?.memberId ?? goal.plan?.beneficiaryId) === id ? 'beneficiary' : 'participant',
                    task: onRoster && ownPartyTask ? objective.sourceKind
                        : ownGearTask ? gear.strategy : undefined
                } : null
            };
        })
    };
}

function inspectGoals(session, id) {
    const state = lifeState(session, id);
    const activity = session.plan || state.activity || null;
    const plan = state.stats?.equipmentPlan;
    const errand = session.companionShopping || state.stats?.supplyErrand;
    const activeMaterials = ['craft', 'luxury_exchange'].includes(plan?.strategy)
        && !['deferred', 'complete', 'abandoned'].includes(plan.status) ? plan.materials || [] : [];
    const liveBag = activeMaterials.length ? session.actor?.backpack?.fetchItems?.() : null;
    const counts = new Map();
    for (const entry of liveBag || (activeMaterials.length ? Object.values(state.inventory || {}) : [])) {
        const selfId = Number(entry.fetchSelfId?.() ?? entry.selfId);
        counts.set(selfId, (counts.get(selfId) || 0) + Number(entry.fetchAmount?.() ?? entry.amount ?? 0));
    }
    const hasInventory = !!(liveBag || state.inventory);
    const materials = activeMaterials.filter(row => Number(row.selfId) > 0 && Number(row.amount) > 0).map(row => {
        const inBag = hasInventory ? counts.get(Number(row.selfId)) || 0 : undefined;
        return { selfId: row.selfId, required: row.amount, inBag,
            missingFromBag: inBag === undefined ? undefined : Math.max(0, row.amount - inBag) };
    }).sort((a, b) => Number(b.missingFromBag > 0) - Number(a.missingFromBag > 0));
    const items = materials.length ? invoke('GameServer/World/Generics/NativeKnowledgeBase')() : null;
    const dead = session.actor?.state?.fetchDead?.() ?? activity === 'dead';
    return { ok: true, activity,
        activityBlocker: dead ? 'dead' : activity === 'party_wait' ? 'waiting_for_party' : null,
        equipmentGoal: plan ? {
            target: plan.target, phase: plan.phase, reason: plan.reason, status: plan.status, strategy: plan.strategy,
            blocker: ['blocked', 'deferred'].includes(plan.status) ? plan.reason ?? plan.status : null,
            resumeLevel: plan.levelingRecovery?.resumeLevel,
            next: plan.next ? { kind: plan.next.sourceKind ?? plan.next.kind, npcName: plan.next.npcName,
                itemId: plan.next.itemId, amount: plan.next.amount, requiresParty: plan.requiresParty } : null,
            market: plan.strategy === 'market' && plan.market ? { town: plan.market.town, plannedPrice: plan.market.price } : null,
            materials: materials.slice(0, PAGE_SIZE).map(row => ({
                ...row, name: items.itemOverview(Number(row.selfId))?.name
            })),
            materialTypes: materials.length,
            materialCountsSource: materials.length && hasInventory ? (liveBag ? 'current_backpack' : 'saved_backpack') : null,
            backpackUpdatedAt: materials.length && !liveBag && hasInventory ? state.updatedAt : undefined
        } : null,
        supplyErrand: errand ? { kind: errand.kind, itemId: errand.itemId || errand.itemSelfId, itemName: errand.itemName,
            amount: errand.amount, phase: session.supplyErrandPhase || errand.phase,
            totalCost: errand.totalCost, expiresAt: errand.expiresAt } : null };
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
    const query = String(decision.query || '').trim().normalize('NFC').toLowerCase();
    const group = !decision.directAnswer && ['friends', 'enemies'].includes(query) ? query : null;
    const rows = observed.relations.filter(row => row.kind === 'character').map(row => ({
        id: row.targetId, relationship: row.hostility >= 3 || row.trust <= -3 ? 'hostile'
            : row.trust >= 3 || row.affinity >= 3 ? 'friendly' : 'familiar',
        affinity: row.affinity, trust: row.trust, hostility: row.hostility, familiarity: row.familiarity,
        reasons: (row.reasons || []).map(reason => ({ type: reason.type, at: reason.at })),
        lastInteractionAt: row.at
    })).filter(row => group === 'friends' ? row.relationship === 'friendly'
        : group === 'enemies' ? row.relationship === 'hostile' : true)
        .sort((a, b) => (Math.abs(b.affinity) + Math.abs(b.trust) + b.hostility)
            - (Math.abs(a.affinity) + Math.abs(a.trust) + a.hostility) || b.lastInteractionAt - a.lastInteractionAt);
    const namedSearch = query && !group;
    const result = page(rows, { ...decision, query: '' });
    const ids = (namedSearch ? rows : result.rows).map(row => row.id);
    const names = ids.length ? await invoke('Database').execute([
        `SELECT id, name FROM characters WHERE id IN (${ids.map(() => '?').join(',')})`, ids
    ]) : [];
    const byId = new Map(names.map(row => [Number(row.id), row.name]));
    const withName = row => ({ ...row, name: byId.get(row.id) || null });
    const selection = namedSearch ? page(rows.map(withName)
        .filter(row => row.name?.normalize('NFC').toLowerCase() === query), { ...decision, query: '' })
        : { ...result, rows: result.rows.map(withName) };
    return { ok: true, source: 'personal_relationship_memory', completeHistory: false,
        observation: 'Recorded personal impressions, not an exhaustive list of friends or enemies.',
        ...selection };
}

async function selfContext(session, text, conversation = {}) {
    const { id, value } = clanFor(session);
    const result = { clan: { id, name: value?.name || null } };
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
    case 'clan': return inspectClan(session, id);
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
            let catalogue;
            const rows = Object.values(session.inventory).map(row => {
                const name = row.name && row.name !== `Item ${row.selfId}` ? row.name
                    : (catalogue ||= invoke('GameServer/World/Generics/NativeKnowledgeBase')()).itemOverview(Number(row.selfId))?.name ?? row.name;
                return { selfId: row.selfId, name, count: row.amount, equipped: !!row.equipped, grade: row.rank };
            });
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
    case 'goals': return inspectGoals(session, id);
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
            return await recall(decision, context);
        }
        if (decision.action === 'look_around') {
            const view = LocalObservation.read(context.session);
            return decision.directAnswer ? { ...view, terminalReply: observationReply(view), replyReason: 'local_observation' } : view;
        }
        const result = decision.action === 'inspect_self' ? await inspect(decision, context)
            : decision.action === 'lookup_game' ? lookup(decision)
                : decision.action === 'find_item_sources' ? lookup({ ...decision, topic: 'item_sources' }) : { ok: false, reason: 'unknown_read_tool' };
        if (decision.directAnswer && decision.topic === 'goals') {
            return { ...result, terminalReply: goalReply(result, context.playerMessage), replyReason: 'goal_status' };
        }
        if (decision.directAnswer && decision.topic === 'inventory') {
            return { ...result, terminalReply: inventoryReply(result, decision.query), replyReason: 'inventory_status' };
        }
        if (decision.directAnswer && decision.topic === 'relationships') {
            return { ...result, terminalReply: relationshipReply(result, context.playerMessage), replyReason: 'relationship_memory' };
        }
        return Protocol.compact(result, { rows: PAGE_SIZE });
    } catch (_) {
        const terminalReply = decision.directAnswer ? {
            look_around: "I can't see who or what is nearby from here.",
            inspect_self: "I can't check that right now.",
            recall_event: "I can't confirm how that went."
        }[decision.action] : undefined;
        return { ok: false, reason: 'knowledge_unavailable',
            ...(terminalReply ? { terminalReply, replyReason: 'knowledge_unavailable' } : {}) };
    }
}

const raidWord = /\braids?\b|\bboss(?:es)?\b|(?:^|[^\p{L}])(?:рейд|босс)\p{L}*/iu;
const pvpWord = /\b(?:pvp|pk|gank\w*|skirmish\w*|duel\w*)\b|(?:^|[^\p{L}])(?:пвп|пк|ганк\p{L}*|дуэл\p{L}*|подрал\p{L}*|дрались)(?!\p{L})/iu;
const genericCombatWord = /^(?:raids?|boss(?:es)?|pvp|pk|fights?|battle|skirmish|gank|duel|latest|last|recent|(?:today|yesterday)(?:['’]s)?|рейд\p{L}*|босс\p{L}*|пвп|пк|бой|битва|ганк\p{L}*|дуэл\p{L}*|последн\p{L}*|недавн\p{L}*|вчера\p{L}*|сегодня\p{L}*)$/iu;
const sharedCombat = /\b(?:we|together|with me|our)\b|(?:^|[^\p{L}])(?:мы|вместе|со мной|наш(?:его|ем|ему|им|и|а|у)?)(?!\p{L})/iu;
const outcomeQuestion = /\b(?:what happened|how did .{1,65} end|how was (?:the |your |our |that )?(?:last |latest )?(?:raid|pvp|fight|battle|duel)|who (?:won|lost|retreated|backed off|defeated|killed)|did (?:you|your (?:group|party)) (?:win|defeat|beat|kill|finish|retreat|back off|(?:land|get) the kill)|which side|was (?:he|she|that player) (?:with|against) (?:you|us)|how did it go)\b/i;
const latestCombat = /\b(?:last|latest|most recent)\s+(?:boss\s+)?(?:raid|pvp|fight|battle|duel)\b/i;
const sharedOutcome = /\b(?:we|our (?:party|group)) (?:won|lost|wiped|killed|defeated|beat|finished|retreated)\b|\b(?:did|have|had) (?:we|our (?:party|group)) (?:win|lose|wipe|kill|killed|defeat|defeated|beat|finish|finished|retreat|retreated)\b/i;
const asksAboutLoot = /\b(?:loot|rewards?|drops?|dropped|spoils?)\b/i;
const asksAboutPast = /\b(?:remember|recall|last|previous|recent(?:ly)?|ago|yesterday|happened|did|were)\b|(?:^|[^\p{L}])(?:помн|вспом|вчера|недавн|прошл)\p{L}*/iu;
const worldCommand = /(?:^|[.!?,;]\s+|\b(?:and|then)\s+)(?:(?:can|could|would|will) you\s+(?:also\s+)?)?(?:please\s+)?(?:attack|equip|buy|sell|bring|follow|invite|move|kill|heal|buff|trade|stay|come|pick up)\b/i;

function asksCombatOutcome(text) {
    return !asksAboutLoot.test(text) && (outcomeQuestion.test(text) || latestCombat.test(text) || sharedOutcome.test(text));
}

function combatQuery(query) {
    const words = query.split(/[\s,.!?]+/u).filter(Boolean);
    const modifier = word => genericCombatWord.test(word) || /^(?:with|against|on|the|me|us)$/i.test(word);
    while (words.length && modifier(words[0])) words.shift();
    while (words.length && modifier(words.at(-1))) words.pop();
    return words.join(' ');
}

function readForQuestion(message = '') {
    const text = String(message).trim().replace(/^[\p{L}\d_'-]{1,24},\s+/u, '');
    // Let the normal model path handle a question combined with a game command.
    if (worldCommand.test(text)) return null;
    if (/\b(?:what do you think (?:about|of)|how do you (?:feel about|like)|do you like)\s+your clan\b/i.test(text)) {
        return { action: 'inspect_self', topic: 'clan', answerOnly: true };
    }
    const known = text.match(/^(?:how (?:do|did) you know|where did you meet|what(?:'s| is) your relationship with|are you friends with)\s+["“']?([\p{L}\d_'-]+)["”']?(?:[?.!]|$)/iu);
    if (known && !/^(?:me|him|her|them|that|this|it)$/i.test(known[1])) {
        return { action: 'inspect_self', topic: 'relationships', query: known[1], directAnswer: true };
    }
    if (/\b(?:look around|(?:who|what) (?:can|do) you see (?:around|nearby|near you|right now|here)|(?:who|what)(?:'s| is) (?:around you|nearby)|(?:players|mobs) (?:you (?:can )?see|around you)|(?:danger|threats?) (?:nearby|around you))\b/i.test(text)) {
        return { action: 'look_around', directAnswer: true };
    }
    if (/\b(?:what are you (?:currently |right now )?(?:working on|collecting|saving for|crafting)|what(?:'s| is) your (?:(?:current|personal) )?goal|how (?:many|much) .{1,48} (?:do you still need|are you (?:still )?(?:missing|short))|how (?:far|close) are you (?:on|to) (?:your|finishing))\b/i.test(text)
        || /\b(?:are|do) you (?:currently )?(?:working on|collecting(?: on)?|saving (?:up )?for) (?:(?:any|some|new|better) )*(?:gear|equipment)\b/i.test(text)) {
        return { action: 'inspect_self', topic: 'goals', directAnswer: true };
    }
    const bag = text.match(/\b(?:do you have|have you got)\s+(?:any\s+)?([^?.!,]{1,60}?)\s+in\s+your\s+(?:backpack|bag|inventory)\b/i)
        || text.match(/\bhow (?:many|much)\s+([^?.!,]{1,60}?)\s+do you have(?:\?|$)/i);
    if (bag) return { action: 'inspect_self', topic: 'inventory', query: bag[1].trim(), directAnswer: true };
    const kind = pvpWord.test(text) ? 'pvp' : raidWord.test(text) ? 'raid' : null;
    if (!kind || !asksCombatOutcome(text)) return null;
    const named = kind === 'pvp'
        ? text.match(/\b(?:with|against|did you fight)\s+['"]?([\p{L}\d_'-]+)/iu)?.[1]
        : text.match(/\braids?\s+(?:on|against)\s+(.+?)(?:[?.!,]|$)/i)?.[1]
            || text.match(/\b(?:what happened|who won)\s+(?:in|on|at)\s+(?:yesterday['’]s\s+|today['’]s\s+|the\s+)?(.+?)\s+raid\b/i)?.[1];
    const query = named && !/^(?:me|us|them|you|there|the|anyone)$/i.test(named) ? combatQuery(named.replace(/^['"]|['"]$/g, '')) : '';
    return { action: 'recall_event', query, directAnswer: true };
}

const englishList = new Intl.ListFormat('en');
function observationReply(view) {
    if (!view.ok) return "I can't see who or what is nearby from here.";
    const people = view.people.slice(0, 3).map(row => row.name);
    const mobs = view.mobs.slice(0, 3).map(row => row.name);
    const evidence = {
        targeting_you: 'is targeting me', targeting_your_party: 'is targeting my party',
        recently_hit_you: 'just hit me', has_aggro_on_you: 'has aggro on me',
        recently_attacked_you: 'attacked me recently', recently_attacked_your_party: 'attacked my party recently'
    };
    const threats = view.threats.slice(0, 2).map(row => row.name + ' ' + evidence[row.evidence]);
    return [people.length ? 'I can see ' + englishList.format(people) + ' nearby.' : "I don't see anyone nearby.",
        mobs.length ? 'Mobs I can see include ' + englishList.format(mobs) + '.' : "I don't see any mobs.",
        threats.length ? englishList.format(threats) + '.' : "I don't see an immediate threat."].join(' ');
}

function goalReply(result, message) {
    const goal = result.equipmentGoal;
    const target = typeof goal?.target === 'string' ? goal.target : goal?.target?.name;
    const errand = result.supplyErrand;
    const activeTarget = target && !['complete', 'abandoned', 'deferred'].includes(goal.status);
    const reply = activeTarget ? "I'm working on " + target + '.' :
        errand?.itemName ? "I'm picking up " + errand.itemName + '.' : "I don't have an active gear goal right now.";
    const words = value => ' ' + String(value || '').toLowerCase().replace(/[^\p{L}\d]+/gu, ' ').trim() + ' ';
    const text = words(message);
    const material = goal?.materials?.find(row => row.name && text.includes(words(row.name)));
    const count = material && Number.isFinite(material.missingFromBag)
        ? ' I have ' + material.inBag + ' of the ' + material.required + ' ' + material.name + " I need. I'm " + material.missingFromBag + ' short.'
        : /\bhow (?:much|many)\b/i.test(text) ? " I don't know the count." : '';
    return reply + count + (result.activityBlocker === 'waiting_for_party' ? " I'm waiting for a party." : '');
}

function inventoryReply(result, query) {
    if (!result.ok) return "I can't check my bag right now.";
    const exact = result.rows.filter(row => row.name?.toLowerCase() === query.toLowerCase());
    if (!exact.length) return result.rows.length ? 'Do you mean ' + result.rows[0].name + '?' : "I don't see that in my bag.";
    const name = exact[0].name;
    if (result.hasMore || exact.some(row => !Number.isFinite(row.count))) return 'I have ' + name + ", but I'm not sure how many.";
    return 'I have ' + exact.reduce((sum, row) => sum + row.count, 0) + ' ' + name + ' in my bag.';
}

function relationshipReply(result, message = '') {
    if (result.reason === 'private_memory') return "I'd rather talk about that in private.";
    const row = result.rows?.[0];
    if (!row) return "I don't remember meeting them.";
    const memories = {
        hunted_together: 'We hunted together.',
        helped_in_combat: 'They helped me in a fight.',
        healed: 'They healed me in a fight.',
        resurrected: 'They brought me back after I died.',
        attacked: 'They attacked me.',
        killed: 'They killed me in a fight.',
        party_formed: 'We partied up.',
        trade_completed: 'We traded before.',
        chat: "We've talked before."
    };
    const fact = row.reasons?.map(reason => memories[reason.type]).find(Boolean);
    const opening = /\bare you friends\b/i.test(message)
        ? (row.relationship === 'friendly' ? "We're on good terms. " : "I know them. ") : '';
    if (!fact) return opening || "I know them, but I don't remember how we met.";
    return opening + fact + (/\bwhere did you meet\b/i.test(message) ? " I don't remember where." : '');
}

function combatDateRange(text) {
    const yesterday = /\byesterday\b|(?:^|[^\p{L}])вчера\p{L}*/iu.test(text);
    if (!yesterday && !/\btoday\b|(?:^|[^\p{L}])сегодня\p{L}*/iu.test(text)) return {};
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    if (yesterday) day.setDate(day.getDate() - 1);
    const since = day.getTime();
    day.setDate(day.getDate() + 1);
    return { since, before: day.getTime() };
}

function previewParticipants(row, botId, playerId) {
    const { participantIds, sides, kills = [] } = row.meta;
    const priority = [...(row.matchedParticipantIds || []), playerId,
        ...kills.slice(0, PAGE_SIZE).flatMap(kill => [kill.killerId, kill.victimId])];
    const ordered = [...new Set([...priority, ...participantIds])].filter(id => id !== botId && participantIds.includes(id));
    return sides ? sides.flatMap(side => ordered.filter(id => side.includes(id)).slice(0, PAGE_SIZE)) : ordered.slice(0, PAGE_SIZE);
}

function recalledCombat(row, result, { botId, playerId, publicChat, names, preview }) {
    const meta = row.meta;
    const facts = { ...result, occurredAt: new Date(row.updatedAt).toISOString(), participantCount: meta.participantIds.length };
    const shared = !!playerId && meta.participantIds.includes(playerId);
    if (EVENT_TYPES.raid.includes(row.eventType)) {
        const won = Array.isArray(meta.winningParticipantIds) ? meta.winningParticipantIds.includes(botId) : undefined;
        return { ...facts, bossName: meta.bossName, outcome: row.eventType === 'raid_defeated' ? 'defeated' : 'failed',
            ...(won !== undefined ? { resultForBot: won ? 'won' : 'participated', defeatedByBotParty: won } : {}),
            ...(!publicChat ? { speakerParticipationConfirmed: shared, otherParticipants: preview.map(names).filter(Boolean) } : {}) };
    }

    const botSide = meta.sides.findIndex(side => side.includes(botId));
    let resultForBot = 'no_confirmed_winner';
    if (meta.scope === 'casualty') resultForBot = botSide === meta.losingSide ? 'was_killed' : 'killed_opponent';
    else if (meta.losingSide !== null && botSide >= 0) resultForBot = botSide === meta.losingSide ? 'lost' : 'won';
    const retreatingSide = meta.outcome === 'retreated' && botSide >= 0 && meta.losingSide !== null
        ? (botSide === meta.losingSide ? 'my_side' : 'opposing_side') : undefined;
    const outcome = { ...facts, scope: meta.scope, outcome: meta.outcome, resultForBot, retreatingSide, killCount: meta.kills.length };
    if (publicChat || botSide < 0) return outcome;
    const onSide = index => preview.filter(id => meta.sides[index].includes(id)).map(names).filter(Boolean);
    return { ...outcome, speakerParticipationConfirmed: shared,
        ...(shared ? { speakerSide: meta.sides[botSide].includes(playerId) ? 'ally' : 'opponent' } : {}),
        allies: onSide(botSide), opponents: onSide(1 - botSide), sideCounts: [meta.sides[botSide].length, meta.sides[1 - botSide].length],
        kills: meta.kills.slice(0, PAGE_SIZE).map(({ killerId, victimId, credit }) => ({
            killer: killerId === botId ? 'self' : names(killerId) || null,
            victim: victimId === botId ? 'self' : names(victimId) || null, credit
        })) };
}

function combatReply(row, query, publicChat) {
    if (EVENT_TYPES.raid.includes(row.type)) {
        if (row.outcome === 'failed') return 'The attempt on ' + row.bossName + ' failed.';
        if (row.defeatedByBotParty === true) return 'My party defeated ' + row.bossName + '.';
        if (row.defeatedByBotParty === false) return 'I took part, but another party defeated ' + row.bossName + '.';
        return row.bossName + ' was defeated.' + (row.speakerParticipationConfirmed ? ' We were both there.' : '');
    }
    const side = query.toLowerCase();
    const ally = !publicChat && row.allies?.find(name => name.toLowerCase() === side);
    const opponent = !publicChat && row.opponents?.find(name => name.toLowerCase() === side);
    const prefix = ally ? ally + ' was on my side. ' : opponent ? opponent + ' was on the opposing side. ' : '';
    if (row.outcome === 'expired') return prefix + 'The fight ran out of time. No winner was recorded.';
    if (row.retreatingSide) return prefix + (row.retreatingSide === 'my_side' ? 'My side retreated.' : 'The opposing side retreated.');
    if (row.scope === 'casualty') return prefix + (row.resultForBot === 'was_killed' ? 'I was killed.' : 'I landed the kill.');
    if (row.resultForBot === 'won') return prefix + 'My side won.';
    if (row.resultForBot === 'lost') return prefix + 'My side lost.';
    return prefix + 'The fight ended without a confirmed winner.';
}

async function recall(decision, { session, playerSession, playerMessage = '', publicChat }) {
    const botId = Number(session?.actor?.fetchId?.() || session?.characterId);
    const playerId = publicChat ? null : Number(playerSession?.actor?.fetchId?.()) || null;
    const suppliedQuery = String(decision.query || '').trim();
    const text = `${playerMessage} ${suppliedQuery}`;
    const combatKind = pvpWord.test(text) ? 'pvp' : raidWord.test(text) ? 'raid' : null;
    const normalized = combatKind ? combatQuery(suppliedQuery) : suppliedQuery;
    let query = normalized ? suppliedQuery : '';
    const dateFromPlayer = combatKind ? combatDateRange(playerMessage) : {};
    const search = invoke('GameServer/Bot/AI/BotEventJournal').search;
    const criteria = {
        botId, playerId, combatKind,
        matchParticipantNames: !publicChat,
        ...(combatKind ? (dateFromPlayer.since !== undefined ? dateFromPlayer : combatDateRange(suppliedQuery)) : {}),
        ...(combatKind && latestCombat.test(playerMessage) ? { limit: 1 } : {}),
        withParticipant: combatKind && sharedCombat.test(playerMessage) ? playerId : null
    };
    let rows = await search({ ...criteria, query });
    if (!rows.length && normalized && normalized !== query) {
        query = normalized;
        rows = await search({ ...criteria, query });
    }
    const participantPreview = new Map();
    const nameIds = new Set();
    for (const row of rows) {
        if (publicChat || !COMBAT_EVENT_TYPES.includes(row.eventType) || !Array.isArray(row.meta?.participantIds)) continue;
        const preview = previewParticipants(row, botId, playerId);
        participantPreview.set(row, preview);
        for (const id of preview) nameIds.add(id);
        for (const { killerId, victimId } of (row.meta.kills || []).slice(0, PAGE_SIZE)) {
            if (killerId !== botId) nameIds.add(killerId);
            if (victimId !== botId) nameIds.add(victimId);
        }
    }
    const ids = [...nameIds];
    const names = ids.length ? await invoke('Database').execute([
        `SELECT id, name FROM characters WHERE id IN (${ids.map(() => '?').join(',')})`, ids
    ], 'bot-activity:combat-participant-names').catch(() => []) : [];
    const nameById = new Map(names.map(({ id, name }) => [Number(id), name]));
    const result = rows.map(row => {
        const result = { id: row.id, type: row.eventType, summary: row.summary, at: row.updatedAt };
        if (!COMBAT_EVENT_TYPES.includes(row.eventType) || !Array.isArray(row.meta?.participantIds)) return result;
        return recalledCombat(row, result, { botId, playerId, publicChat, names: id => nameById.get(id),
            preview: participantPreview.get(row) || [] });
    });
    const only = result.length === 1 ? result[0] : null;
    const direct = decision.directAnswer || asksCombatOutcome(playerMessage) && !worldCommand.test(playerMessage);
    const response = { ok: true, source: 'personal_journal', rows: result };
    if (!rows.length) {
        if (!playerMessage || decision.directAnswer || raidWord.test(playerMessage) || pvpWord.test(playerMessage)
            || asksAboutPast.test(playerMessage)) return { ...response, terminalReply: "I don't remember that." };
        return { ...response, ok: false, reason: 'no_match_for_current_question' };
    }
    if (direct && result.every(row => row.outcome && COMBAT_EVENT_TYPES.includes(row.type))) {
        return { ...response, terminalReply: only ? combatReply(only, query, publicChat)
            : 'I remember more than one fight like that. Which one do you mean?',
        replyReason: only ? 'recorded_combat_outcome' : 'multiple_recorded_events' };
    }
    return response;
}

module.exports = { ACTIONS, TOPICS, actionsFor, descriptors, GROUNDING_PROMPT, execute, inspect, lookup, persona, relationship, selfContext,
    readForQuestion };
