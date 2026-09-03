const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Policy = invoke('GameServer/Clan/ClanWarehouseEquipmentPolicy');
const Identity = invoke('GameServer/Bot/AI/BotServiceIdentity');

const running = new Map();
const itemCursors = new Map();
const memberCursors = new Map();
let clanCursor = 0;
let nextScanAt = 0;

function liveRows(actor) {
    return actor.backpack.fetchItems().map((item) => ({
        id: item.fetchId(), selfId: item.fetchSelfId(), amount: item.fetchAmount(),
        enchant: item.fetchEnchantLevel(), equipped: item.fetchEquipped(), slot: item.fetchSlot()
    }));
}

function available(session, clanId) {
    const actor = session?.actor;
    return !!actor?.backpack && Number(actor.fetchClanId()) === Number(clanId)
        && !actor.isDead() && !actor.state?.fetchHits?.() && !actor.state?.fetchCasts?.()
        && !session.activeTrade && !session.trade && !session.activeNegotiation && !session.botTradeReservations?.size
        && !actor.fetchPrivateStoreType?.() && !Identity.isStaticService(session);
}

function publish(session, result) {
    const actor = session.actor;
    const backpack = actor.backpack;
    const ids = new Set(result.returned.map((item) => Number(item.id)));
    for (const item of result.returned) backpack.unequipPaperdoll(Number(item.slot));
    backpack.items = backpack.fetchItems().filter((item) => !ids.has(Number(item.fetchId())));
    const received = Policy.materialize(result.received);
    backpack.items.push(received);
    backpack.equipPaperdoll(result.slot, received.fetchId(), received.fetchSelfId());
    if (session.coldLifeState) session.coldLifeState = result.state;
    // Persistence already committed both sides of the exchange. Only runtime
    // stats, item skills, toggles, and client appearance need refreshing here.
    invoke(path.actor).calculateStats(session, actor);
    invoke('GameServer/Skills/ToggleSkills').syncEquipment(session, actor);
    const response = invoke('GameServer/Network/Response');
    session.dataSendToMe?.(response.itemsList(backpack.fetchItems()));
    session.dataSendToOthers?.(response.charInfo(actor), actor);
    const shots = invoke('GameServer/Inventory/ShotStock');
    shots.ensureActorStock(actor).then(() => shots.enableAutoShot(actor))
        .catch((error) => utils.infoWarn('ClanGear', 'shot refresh failed: %s', error.message));
}

function coldAvailable(characterId) {
    const population = invoke('GameServer/Bot/Population/PopulationService');
    const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    return !population.resolving && !population.partyFormationRunning
        && !coordinator.commandInflight.has(Number(characterId));
}

async function exchangeCold(request) {
    const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
    // Fence and flush any worker proposal before changing the physical gear.
    // The member keeps its party; the new revision invalidates stale proposals.
    try {
        const fence = await coordinator.fenceBot(request.characterId);
        if (!fence.ok || !coldAvailable(request.characterId)) return { ok: false, code: 'member_busy' };
        const state = await LifeState.findByCharacterId(request.characterId);
        const handoff = await owner.handoffToMain(state, { allowParty: true, allowLifecycle: true });
        if (!handoff.ok) return { ok: false, code: 'member_busy' };
        return await LifeState.applyClanWarehouseExchange({ ...request, validateCold: () => coldAvailable(request.characterId) });
    } finally {
        const current = LifeState.cachedState(request.characterId);
        if (current?.phase === 'cold') await coordinator.acceptColdState(current);
    }
}

async function resolve(clanId, options) {
    const deadlineAt = options.deadlineAt ?? Date.now() + 100;
    const rows = await Database.fetchClanWarehouseItems(clanId);
    const preferred = new Set(options.preferredIds || []);
    const cursor = itemCursors.get(clanId) || 0;
    const stock = rows.filter((row) => Number(row.amount) > Number(row.reservedAmount || 0)
        && Policy.materialize(row)?.isWearable()).sort((a, b) =>
        Number(preferred.has(b.id)) - Number(preferred.has(a.id))
        || Number(a.id <= cursor) - Number(b.id <= cursor) || a.id - b.id).slice(0, 32);
    if (!stock.length) return { exchanged: 0 };
    const members = await Database.execute([`SELECT c.id, c.classId, c.level, c.name,
        l.phase, l.activity, l.partyId, l.simulationOwner, l.statsJson
        FROM characters c JOIN bot_life_state l ON l.characterId = c.id
        WHERE c.clanId = ? ORDER BY c.id`, [clanId]], 'clan-gear:members');
    const manager = invoke('GameServer/Bot/BotManager');
    let exchanged = 0;
    let inspected = 0;
    for (const item of stock) {
        if ((inspected > 0 && Date.now() >= deadlineAt) || exchanged >= 8) break;
        let completed = true;
        const memberCursor = memberCursors.get(clanId);
        const memberStart = memberCursor?.itemId === item.id ? memberCursor.memberId : 0;
        const orderedMembers = [...members].sort((a, b) => Number(a.id <= memberStart) - Number(b.id <= memberStart) || a.id - b.id);
        for (const member of orderedMembers) {
            if (inspected > 0 && Date.now() >= deadlineAt) { completed = false; break; }
            memberCursors.set(clanId, { itemId: item.id, memberId: member.id });
            const session = manager.findSessionById(Number(member.id));
            if (member.phase === 'hot' ? !available(session, clanId)
                : member.phase !== 'cold' || !['hunting', 'resting', 'grouped'].includes(member.activity)
                    || !coldAvailable(member.id)) continue;
            if (Identity.isStaticService({ ...member, stats: JSON.parse(member.statsJson || '{}') })) continue;
            const inventory = member.phase === 'hot' ? liveRows(session.actor) : await Database.fetchItems(member.id);
            inspected += 1;
            if (!Policy.plan(member, inventory, item)) continue;
            const actor = session?.actor;
            const request = {
                clanId, characterId: member.id, warehouseId: item.id, expectedPhase: member.phase,
                validateLive: (current, persisted) => session?.actor === actor && available(session, clanId)
                    && manager.findSessionById(Number(member.id)) === session
                    && Number(actor.fetchLevel()) === Number(current.level)
                    && Number(actor.fetchClassId()) === Number(current.classId)
                    && Policy.equipmentSignature(liveRows(actor)) === Policy.equipmentSignature(persisted)
            };
            const result = member.phase === 'hot'
                ? await LifeState.applyClanWarehouseExchange(request, (result) => publish(session, result))
                : await exchangeCold(request);
            if (result.ok) {
                exchanged += 1;
                console.info('ClanGear :: %s exchanged warehouse item %d, returned %s', member.name, item.selfId,
                    result.returned.map((old) => `${old.selfId}+${old.enchant}`).join(', ') || 'empty slot');
                break;
            }
        }
        if (completed) {
            itemCursors.set(clanId, Number(item.id));
            memberCursors.delete(clanId);
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
    return { exchanged };
}

function resolveClan(clanId, options = {}) {
    const id = Number(clanId);
    if (running.has(id)) return running.get(id);
    const work = resolve(id, options).finally(() => running.delete(id));
    running.set(id, work);
    return work;
}

async function resolveBatch(deadlineAt) {
    if (!Database.isReady() || Date.now() < nextScanAt || Date.now() >= deadlineAt) return;
    nextScanAt = Date.now() + 5000;
    const clans = await Database.execute([`SELECT DISTINCT clanId FROM clan_warehouse_items
        WHERE clanId > ? AND amount > reservedAmount AND (kind LIKE 'Weapon.%' OR kind LIKE 'Armor.%')
        ORDER BY clanId LIMIT 1`, [clanCursor]], 'clan-gear:candidates');
    if (!clans.length) { clanCursor = 0; return; }
    if (Date.now() >= deadlineAt) return;
    clanCursor = Number(clans[0].clanId);
    return resolveClan(clanCursor, { deadlineAt });
}

module.exports = { resolveClan, resolveBatch, available, publish };
