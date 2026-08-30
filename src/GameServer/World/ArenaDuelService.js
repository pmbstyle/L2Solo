const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const BotSession = invoke('GameServer/Bot/BotSession');
const BotManager = invoke('GameServer/Bot/BotManager');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const Arena = invoke('GameServer/World/GiranArena');
const ServerResponse = invoke('GameServer/Network/Response');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');

const NPC_SELF_ID = 8225;
const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;
const NPC_INTERACTION_DISTANCE = 250;
const CLONE_START = Object.freeze({ locX: 72984, locY: 142760, locZ: -3778, head: 32768 });
let nextActorId = 2100000000;
let nextItemId = 900000000;
let active = null;
let monitor = null;
let selectionInFlight = false;

function actorOf(session) {
    return session?.actor || null;
}

function className(classId) {
    return DataCache.classTemplates?.find((entry) => Number(entry.classId) === Number(classId))?.template?.class
        || `Class ${classId}`;
}

function cloneJson(value, fallback = {}) {
    try { return structuredClone(value); } catch (_) { return fallback; }
}

function itemSnapshot(item) {
    return cloneJson(item?.model || item, {});
}

function snapshotItems(items = []) {
    return items
        .map(itemSnapshot)
        .filter((item) => Number(item.selfId) > 0)
        .filter((item) => {
            const kind = String(item.kind || '');
            return kind.startsWith('Armor.') || kind.startsWith('Weapon.')
                || !!ShotStock.kindForSelfId?.(Number(item.selfId));
        })
        .map((item) => ({
            ...item,
            id: nextItemId++,
            characterId: 0,
            amount: Math.max(1, Number(item.amount) || 1)
        }));
}

function hydrateItemRows(items = []) {
    return items.map((item) => {
        const definition = DataCache.items?.find((entry) => Number(entry.selfId) === Number(item?.selfId));
        if (!definition) return item;
        const details = cloneJson(definition, {});
        if (Number(item?.slot) > 0 && details.etc) delete details.etc.slot;
        return { ...item, ...utils.crushOb(details) };
    });
}

function paperdollFor(items) {
    const paperdoll = Array.from({ length: 16 }, () => ({}));
    items.filter((item) => item.equipped && Number(item.slot) > 0).forEach((item) => {
        const slot = Number(item.slot);
        if (slot >= 0 && slot < paperdoll.length) paperdoll[slot] = { id: item.id, selfId: item.selfId };
    });
    if (paperdoll[14]?.id && paperdoll[8]?.id) paperdoll[8] = {};
    return paperdoll;
}

function skillSnapshot(skills = []) {
    return skills.map((skill) => cloneJson(skill?.model || skill, {}))
        .filter((skill) => Number(skill.selfId) > 0 && Number(skill.level) > 0);
}

function actorModelFrom(source, character, classInfo, items) {
    const sourceModel = source?.model ? cloneJson(source.model, {}) : {};
    const classModel = cloneJson(classInfo, {});
    const flattenedClass = utils.crushOb(classModel);
    const base = {
        ...flattenedClass,
        ...sourceModel,
        ...character,
        id: nextActorId++,
        username: `bot_arena_${character.id}`,
        name: `${character.name || source?.fetchName?.() || 'Opponent'} [Arena]`,
        title: 'Arena Opponent',
        locX: CLONE_START.locX,
        locY: CLONE_START.locY,
        locZ: CLONE_START.locZ,
        head: CLONE_START.head,
        isOnline: true,
        pvpFlag: 0,
        karma: 0,
        pvp: 0,
        pk: 0,
        hp: 1,
        mp: 1,
        cp: 1,
        effects: {},
        activeBuffs: {},
        stateDead: false,
        items,
        paperdoll: paperdollFor(items)
    };
    delete base.idleSince;
    return base;
}

function hotCandidate(candidate) {
    return candidate?.session?.actor || candidate?.subject?.session?.actor || candidate?.subject || null;
}

async function loadColdCharacter(characterId) {
    const rows = await Database.execute([
        'SELECT * FROM characters WHERE id = ?',
        [Number(characterId)]
    ]);
    return rows?.[0] || null;
}

async function makeSnapshot(candidate) {
    const sourceActor = hotCandidate(candidate);
    if (sourceActor?.backpack?.fetchItems && sourceActor?.skillset?.fetchSkills) {
        const character = {
            id: Number(sourceActor.fetchId()),
            name: sourceActor.fetchName(),
            classId: sourceActor.fetchClassId(),
            race: sourceActor.fetchRace(),
            sex: sourceActor.fetchSex(),
            level: sourceActor.fetchLevel()
        };
        const items = snapshotItems(sourceActor.backpack.fetchItems());
        return {
            character,
            model: actorModelFrom(sourceActor, character, {}, items),
            skills: skillSnapshot(sourceActor.skillset.fetchSkills()),
            sourceId: character.id,
            sourceName: character.name
        };
    }

    const sourceId = Number(candidate?.state?.characterId || candidate?.subject?.characterId || 0);
    const character = await loadColdCharacter(sourceId);
    if (!character) return null;
    const [items, skills] = await Promise.all([
        Database.fetchItems(sourceId),
        Database.fetchSkills(sourceId)
    ]);
    const classInfo = DataCache.classTemplates?.find((entry) => Number(entry.classId) === Number(character.classId)) || {};
    const filteredItems = snapshotItems(hydrateItemRows(items));
    return {
        character,
        model: actorModelFrom(null, character, classInfo, filteredItems),
        skills: skillSnapshot(skills),
        sourceId,
        sourceName: character.name
    };
}

function candidateCatalog(playerSession, minLevel = 1, maxLevel = 80, classId = null) {
    const catalog = BotAvailability.catalogForPlayer(
        playerSession,
        BotManager.sessions || [],
        LifeState.allStates?.(2000) || []
    );
    return catalog.filter((candidate) => {
        const level = Number(candidate.level || candidate.subject?.level || 1);
        const subjectClass = Number(candidate.subject?.fetchClassId?.() || candidate.state?.stats?.classId || candidate.state?.classId || 0);
        return level >= minLevel && level <= maxLevel
            && (classId === null || Number(subjectClass) === Number(classId));
    });
}

function menu(session, minLevel = 1, maxLevel = 80, classId = null) {
    const candidates = candidateCatalog(session, minLevel, maxLevel, classId).slice(0, 32);
    const links = candidates.map((candidate) => {
        const id = Number(candidate.subject?.fetchId?.() || candidate.state?.characterId || 0);
        const level = Number(candidate.level || 1);
        const cls = Number(candidate.subject?.fetchClassId?.() || candidate.state?.stats?.classId || candidate.state?.classId || 0);
        return `<a action="bypass -h arena select ${id}">${candidate.name} — Lv ${level} ${className(cls)}</a><br>`;
    });
    const body = [
        '<html><body><center><font color="LEVEL">Giran Arena</font></center><br>',
        '<a action="bypass -h arena levels">Choose level range</a><br>',
        '<a action="bypass -h arena classes">Choose class</a><br><br>',
        active?.playerSession === session
            ? `<font color="LEVEL">Buffs: ${active.buffMode}</font> `
                + '<a action="bypass -h arena buff self">self</a> '
                + '<a action="bypass -h arena buff full">full</a><br><br>'
            : '',
        links.length ? links.join('') : 'No opponents match this filter.<br>',
        '<br><a action="bypass -h arena heal">Restore HP/MP/CP</a><br>',
        '</body></html>'
    ].join('');
    session.dataSendToMe(ServerResponse.npcHtml(session.activeNpcTalk?.objectId || 0, body));
    session.dataSendToMe(ServerResponse.actionFailed());
}

function applySelfBuffs(session, actor) {
    const SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
    const skills = actor?.skillset?.fetchSkills?.() || [];
    skills.filter((skill) => skill.fetchTargetKind?.() === 'self'
        && skill.fetchSemantic?.().effectType === 'buff')
        .forEach((skill) => {
            try { SkillEffects.execute(session, actor, actor, skill, { selfEffectOnly: true }); } catch (_) {}
        });
}

function clearArenaEffects(actor) {
    if (!actor) return;
    EffectTicker.clearAll(actor);
    EffectStore.list(actor).forEach((effect) => EffectStore.remove(actor, effect.key));
    actor.activeBuffs = {};
}

function refreshBuffedActor(session, actor) {
    const Generics = invoke(path.actor);
    Generics.calculateStats(session, actor);
    actor.statusUpdateVitals?.(actor);
    EffectTicker.refreshEffects?.(session, actor);
}

function applyBuffProfile(session, actor, mode) {
    clearArenaEffects(actor);
    if (mode === 'full') {
        const FullBuff = invoke('GameServer/World/Generics/NpcBypasses/AdminFullBuff');
        FullBuff.applyFullBuff(session, actor, { refresh: false });
    } else {
        applySelfBuffs(session, actor);
    }
    refreshBuffedActor(session, actor);
}

function applyArenaBuffs() {
    if (!active) return;
    clearArenaEffects(invoke('GameServer/Npc/SummonControl').activeSummon(active.player));
    applyBuffProfile(active.playerSession, active.player, active.buffMode);
    applyBuffProfile(active.botSession, active.bot, active.buffMode);
}

function restoreEffects(session, actor, effects = []) {
    if (!actor) return;
    effects.forEach((effect) => {
        const expiresAt = Number(effect.expiresAt || 0);
        if (expiresAt > 0 && expiresAt <= Date.now()) return;
        const remaining = expiresAt > 0 ? expiresAt - Date.now() : 0;
        const restored = EffectStore.apply(actor, {
            ...effect,
            ...(remaining > 0 ? { durationMs: remaining } : {})
        });
        if (restored) EffectTicker.scheduleExpiry(session, actor, restored);
    });
}

function managerDistanceSquared(actor) {
    const dx = Number(actor?.fetchLocX?.()) - Arena.NPC.locX;
    const dy = Number(actor?.fetchLocY?.()) - Arena.NPC.locY;
    const dz = Number(actor?.fetchLocZ?.()) - Arena.NPC.locZ;
    return (dx * dx) + (dy * dy) + (dz * dz);
}

function canUseManager(session) {
    return !!session?.actor
        && !Arena.isInsideActor(session.actor)
        && managerDistanceSquared(session.actor) <= NPC_INTERACTION_DISTANCE * NPC_INTERACTION_DISTANCE;
}

function applyBuffMode(session, mode) {
    if (!active || active.playerSession !== session || active.state !== 'PREPARED'
        || active.enteredArena === true || !canUseManager(session)) return false;
    const selected = mode === 'full' ? 'full' : 'self';
    active.buffMode = selected;
    menu(session);
    return true;
}

function levels(session) {
    const links = [[1, 20], [21, 40], [41, 60], [61, 80]].map(([from, to]) => (
        `<a action="bypass -h arena list ${from} ${to}">Level ${from}-${to}</a><br>`
    ));
    session.dataSendToMe(ServerResponse.npcHtml(session.activeNpcTalk?.objectId || 0, `<html><body>${links.join('')}</body></html>`));
    session.dataSendToMe(ServerResponse.actionFailed());
}

function classes(session) {
    const seen = new Set();
    const links = candidateCatalog(session).map((candidate) => {
        const id = Number(candidate.subject?.fetchClassId?.() || candidate.state?.stats?.classId || candidate.state?.classId || 0);
        if (seen.has(id)) return '';
        seen.add(id);
        return `<a action="bypass -h arena list 1 80 ${id}">${className(id)}</a><br>`;
    }).filter(Boolean).slice(0, 64);
    session.dataSendToMe(ServerResponse.npcHtml(session.activeNpcTalk?.objectId || 0, `<html><body>${links.join('') || 'No classes available.'}</body></html>`));
    session.dataSendToMe(ServerResponse.actionFailed());
}

async function select(session, sourceId) {
    // The source arena is one physical combat zone. Do not replace another
    // player's active clone (and leave their session orphaned) when a second
    // player clicks the NPC while the arena is occupied.
    if (active && active.playerSession !== session) {
        session?.dataSendToMe?.(ServerResponse.speak(session.actor, {
            kind: 0,
            text: 'The Giran arena is occupied. Please wait for the current duel to finish.'
        }));
        return false;
    }
    if (selectionInFlight) return false;
    selectionInFlight = true;
    try {
        const source = candidateCatalog(session).find((candidate) => Number(candidate.subject?.fetchId?.() || candidate.state?.characterId) === Number(sourceId));
        if (!source) return false;
        release(session, 'reselected');
        const snapshot = await makeSnapshot(source);
        if (!snapshot) return false;

        const botSession = new BotSession(`bot_arena_${session.actor.fetchId()}_${snapshot.sourceId}`);
        botSession.arenaEphemeral = true;
        botSession.persistenceMode = 'ephemeral';
        botSession.plan = 'arena';
        botSession.aiActive = false;
        botSession.arenaDuelId = `${session.actor.fetchId()}:${snapshot.sourceId}`;
        botSession.setActor(snapshot.model);
        botSession.actor.skillset.populateSnapshot(snapshot.skills);
        // Arena clones have no client hotbar packet to enable shots. Mirror the
        // normal bot startup behavior against the snapshotted inventory so their
        // soulshot/spiritshot stock is actually consumed by combat skills.
        ShotStock.enableAutoShot(botSession.actor);
        botSession.actor.setIsOnline(true);
        botSession.actor.state.setDead(false);
        botSession.actor.fillupVitals();
        invoke('GameServer/Actor/Generics/CalculateStats')(botSession, botSession.actor);
        botSession.actor.fillupVitals();
        World.insertUser(botSession);

        active = {
            id: botSession.arenaDuelId,
            playerSession: session,
            player: session.actor,
            botSession,
            bot: botSession.actor,
            sourceId: snapshot.sourceId,
            sourceName: snapshot.sourceName,
            state: 'PREPARED',
            enteredArena: false,
            selectedAt: Date.now(),
            buffMode: 'self'
        };
        session.arenaDuelId = undefined;
        session.arenaDeath = false;
        botSession.dataSendToOthers(ServerResponse.charInfo(botSession.actor), botSession.actor);
        botSession.dataSendToOthers(ServerResponse.relationChanged(botSession.actor), botSession.actor);
        ensureMonitor();
        render(session);
        return true;
    } finally {
        selectionInFlight = false;
    }
}

function ensureMonitor() {
    if (monitor || !active) return;
    monitor = setInterval(() => monitorTick(), 250);
    monitor.unref?.();
}

function monitorTick() {
    if (!active) {
        clearInterval(monitor);
        monitor = null;
        return;
    }
    const player = active.player;
    const inside = Arena.isInsideActor(player);
    const botInside = active.bot ? Arena.isInsideActor(active.bot) : true;
    const playerLeft = active.enteredArena === true && inside === false && active.state !== 'FINISHED';
    const botLeft = active.state === 'FIGHTING' && botInside === false;
    if (!player || !active.playerSession?.actor || playerLeft || botLeft) {
        if (inside === false && active.playerSession?.actor) {
            active.playerSession.dataSendToMe?.(ServerResponse.systemMessage(284));
        }
        release(active.playerSession, botLeft ? 'bot_left_arena' : 'left_arena');
        return;
    }
    if (active.state === 'PREPARED' && inside) {
        prepareInside();
    }
    if (Date.now() - active.selectedAt > PREPARE_TIMEOUT_MS && active.state !== 'FIGHTING') {
        release(active.playerSession, 'prepare_timeout');
        return;
    }
    if (active.state === 'FIGHTING' && active.bot.state?.fetchDead?.()) {
        finishBotDeath();
    }
}

function prepareInside() {
    if (!active || active.state !== 'PREPARED' || !Arena.isInsideActor(active.player)) return false;
    active.enteredArena = true;
    active.playerSession.arenaDuelId = active.id;
    active.playerEffectsBefore = cloneJson(EffectStore.list(active.player), []);
    active.playerSummonBefore = invoke('GameServer/Npc/SummonControl').activeSummon(active.player);
    active.playerSummonEffectsBefore = cloneJson(EffectStore.list(active.playerSummonBefore), []);
    applyArenaBuffs();
    active.state = 'READY';
    active.playerSession.dataSendToMe?.(ServerResponse.systemMessage(283));
    return true;
}

function begin(session) {
    if (!active || active.playerSession !== session || !Arena.isInsideActor(session.actor)) return false;
    if (active.state === 'PREPARED') prepareInside();
    if (active.state !== 'READY') return false;
    active.state = 'FIGHTING';
    active.botSession.dataSendToOthers(ServerResponse.speak(active.bot, { kind: 0, text: 'Let us begin.' }), active.bot);
    invoke('GameServer/World/ArenaBotAI').start(active);
    return true;
}

function finishBotDeath() {
    if (!active || active.state !== 'FIGHTING') return;
    invoke('GameServer/World/ArenaBotAI').stop(active);
    // The player's client may still have an auto-attack/skill queued against
    // the clone that just died. End that action before reviving the opponent,
    // so the next round starts only after a fresh .go command.
    active.player?.attack?.destructor?.();
    invoke(path.actor).clearStoredActions?.(active.playerSession, active.player);
    invoke(path.actor).abortCombatState?.(active.playerSession, active.player);
    active.state = 'READY';
    active.bot.state.setDead(false);
    active.bot.setLocXYZH(CLONE_START);
    applyBuffProfile(active.botSession, active.bot, active.buffMode);
    active.bot.fillupVitals();
    active.botSession.dataSendToOthers(ServerResponse.revive(active.bot.fetchId()), active.bot);
    active.botSession.dataSendToOthers(ServerResponse.socialAction(active.bot.fetchId(), 9), active.bot);
    active.botSession.dataSendToOthers(ServerResponse.speak(active.bot, { kind: 0, text: 'I will be ready for the next round.' }), active.bot);
}

function onPlayerDeath(session) {
    if (!active || active.playerSession !== session || active.state !== 'FIGHTING'
        || active.player !== session?.actor || !Arena.isInsideActor(active.player)) return false;
    invoke('GameServer/World/ArenaBotAI').stop(active);
    active.state = 'FINISHED';
    session.arenaDeath = true;
    active.bot.state.setDead(false);
    active.bot.fillupVitals();
    active.bot.setLocXYZH(CLONE_START);
    active.botSession.dataSendToOthers(ServerResponse.speak(active.bot, { kind: 0, text: 'You fought well. The arena is yours again when you return.' }), active.bot);
    return true;
}

function heal(session) {
    if (!canUseManager(session)) return false;
    if (active?.playerSession === session && (active.state !== 'PREPARED' || active.enteredArena === true)) return false;
    session.actor.fillupVitals();
    session.actor.statusUpdateVitals?.(session.actor);
    if (active?.playerSession === session && active.bot) {
        active.bot.fillupVitals();
        active.bot.statusUpdateVitals?.(active.bot);
    }
    session.dataSendToMe?.(ServerResponse.userInfo(session.actor));
    return true;
}

function release(session, reason = 'released') {
    if (!active || (session && active.playerSession !== session)) return false;
    const duel = active;
    invoke('GameServer/World/ArenaBotAI').stop(duel);
    const playerDied = reason === 'player_death' || duel.player?.state?.fetchDead?.() === true;
    // A player may still have a queued normal attack/skill timer targeting the
    // clone when the arena ends. Clear it before removing the target, otherwise
    // the client's combat loop can keep scheduling actions against a deleted
    // object outside the arena.
    duel.player?.attack?.destructor?.();
    if (duel.playerSession) {
        invoke(path.actor).clearStoredActions?.(duel.playerSession, duel.player);
    }
    if (duel.playerSession && !playerDied) {
        invoke(path.actor).abortCombatState?.(duel.playerSession, duel.player);
    }
    if (duel.player && duel.enteredArena === true) {
        EffectTicker.clearAll(duel.player);
        EffectStore.list(duel.player).forEach((effect) => EffectStore.remove(duel.player, effect.key));
        duel.player.activeBuffs = {};
    }
    if (duel.playerSession && !playerDied && duel.player && duel.enteredArena === true && duel.playerEffectsBefore) {
        restoreEffects(duel.playerSession, duel.player, duel.playerEffectsBefore);
        invoke(path.actor).calculateStats(duel.playerSession, duel.player);
        duel.player.statusUpdateVitals?.(duel.player);
    }
    const currentPlayerSummon = invoke('GameServer/Npc/SummonControl').activeSummon(duel.player);
    if (duel.enteredArena === true && currentPlayerSummon) {
        clearArenaEffects(currentPlayerSummon);
        if (!playerDied && currentPlayerSummon === duel.playerSummonBefore) {
            restoreEffects(duel.playerSession, currentPlayerSummon, duel.playerSummonEffectsBefore);
        }
        invoke('GameServer/World/Generics/NpcBypasses/AdminFullBuff').refreshSummon(duel.playerSession, currentPlayerSummon);
    }
    if (duel.botSession?.actor) {
        EffectTicker.clearAll(duel.botSession.actor);
        duel.botSession.dataSendToOthers?.(ServerResponse.deleteOb(duel.botSession.actor.fetchId()), duel.botSession.actor);
        duel.botSession.actor.destructor();
        World.removeUser(duel.botSession);
    }
    if (duel.playerSession) {
        duel.playerSession.arenaDuelId = undefined;
        duel.playerSession.arenaDeath = false;
    }
    active = null;
    return true;
}

function duelForActor(actor) {
    if (!active || !actor) return null;
    if (active.player === actor || active.bot === actor) return active;
    const ownerId = Number(actor.fetchOwnerId?.()) || 0;
    return ownerId > 0 && [active.player, active.bot].some((participant) => (
        Number(participant?.fetchId?.()) === ownerId
    )) ? active : null;
}

function render(session) { menu(session); }

function handleBypass(session, parts = []) {
    if (Number(session?.activeNpcTalk?.selfId) !== NPC_SELF_ID || !canUseManager(session)) {
        session?.dataSendToMe?.(ServerResponse.actionFailed());
        return false;
    }
    const command = String(parts[1] || 'menu').toLowerCase();
    if (command === 'levels') return levels(session);
    if (command === 'classes') return classes(session);
    if (command === 'list') {
        const minLevel = Number(parts[2]);
        const maxLevel = Number(parts[3]);
        const classId = parts[4] === undefined ? null : Number(parts[4]);
        return menu(
            session,
            Number.isFinite(minLevel) ? minLevel : 1,
            Number.isFinite(maxLevel) ? maxLevel : 80,
            Number.isFinite(classId) ? classId : null
        );
    }
    if (command === 'select') return select(session, Number(parts[2])).catch(() => false);
    if (command === 'buff') return applyBuffMode(session, String(parts[2] || 'self').toLowerCase());
    if (command === 'heal') return heal(session);
    return render(session);
}

function handleGo(session, text) {
    if (String(text || '').trim().toLowerCase() !== '.go') return false;
    if (begin(session)) return true;
    session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: 'You can use .go only after choosing an opponent and entering the Giran arena.' }));
    return true;
}

module.exports = {
    NPC_SELF_ID,
    menu,
    render,
    handleBypass,
    handleGo,
    begin,
    heal,
    select,
    release,
    onPlayerDeath,
    duelForActor,
    get active() { return active; },
    isInside: Arena.isInside,
    candidateCatalog
};
