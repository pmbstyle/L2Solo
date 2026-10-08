const Manager = invoke('GameServer/Bot/BotManager');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Availability = invoke('GameServer/Bot/AI/BotAvailability');
const Status = invoke('GameServer/Bot/AI/BotStatus');
const Protocol = invoke('GameServer/World/Generics/NativeStatusProtocol');
const Response = invoke('GameServer/Network/Response');
const pct = (n) => Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 100))) : 101;
function savedPercent(vitals, key, maximum) {
    const value = vitals?.[key], max = vitals?.[maximum];
    if (value === null || value === undefined || value === '' || max === null || max === undefined || max === '') return 101;
    const current = Number(value), capacity = Number(max);
    return Number.isFinite(current) && Number.isFinite(capacity) && capacity > 0 ? pct(current / capacity) : 101;
}
const words = (s) => String(s ?? 'unknown').replace(/_/g, ' ');
const identity = (source) => {
    const p = Roles.presentation(source.classId ?? source.stats?.classId ?? source.stats?.classProgressionClassId);
    return { name: source.name || source.characterName || '', level: Number(source.level) || 1,
        classId: p.classId ?? 0, className: p.className };
};
function fields(items) {
    // Keep long diagnostics readable across pages instead of dropping their tail.
    return items.flatMap(([label, value]) => {
        let text = Protocol.text(value ?? 'none', 1024) || 'none'; const result = [];
        while (text.length) {
            let end = Math.min(64, text.length);
            if (end < text.length) { const space = text.lastIndexOf(' ', end); if (space > 32) end = space; }
            result.push({ label: result.length ? `${label} (cont.)` : label, value: text.slice(0, end) });
            text = text.slice(end).trimStart();
        }
        return result;
    });
}
function personality(persona) {
    const p = (key) => Math.round(Number(persona?.traits?.[key] || 0) * 100);
    return [['Personality', words(persona?.archetype || 'unavailable')], ['Drive', words(persona?.primaryDrive || 'unavailable')],
        ['Social traits', persona?.traits ? `Sociability ${p('sociability')} / commitment ${p('commitment')} / empathy ${p('empathy')}` : 'unavailable'],
        ['Style', persona?.traits ? `Caution ${p('caution')} / ambition ${p('ambition')} / leadership ${p('assertiveness')} / resilience ${p('resilience')}` : 'unavailable']];
}
function hot(session, target, tab) {
    const s = Manager.getBotStatus(target);
    if (!s?.available) return null;
    const a = Availability.evaluate(session, target);
    const overview = [['Activity', words(s.mode)], ['Intent', words(s.intent)], ['Role', words(s.role)],
        ['Home', `${s.home?.region || 'unknown'}${s.home?.visitor ? ' / visitor' : ''}`],
        ['Party', s.party ? `${s.party.role}, ${s.party.stance}/${s.party.roleStance}, leader ${s.party.leader?.name || 'unknown'}` : 'none'],
        ['Hunting spot', s.spot?.name || 'none'],
        ['Relationship', a.memory ? `${a.relationship} / trust ${a.memory.trust} / familiarity ${a.memory.familiarity}` : 'No shared history'],
        ['Invitation', a.available ? 'Available' : a.reasonText], ...personality(s.persona)];
    const m = s.movement || {}, d = s.decisions || {}, buffs = s.buffs || {}, trade = s.trade || {};
    const details = [['Target', s.target ? `${s.target.type}: ${s.target.name || s.target.id}` : 'none'],
        ['Nearby', `Players ${s.nearby?.realPlayers ?? 0} / bots ${s.nearby?.friendlyBots ?? 0} / mobs ${s.nearby?.attackableNpcs ?? 0}`],
        ['Movement', m.moving ? `moving (${m.towards})` : 'idle'], ...((invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) ? [['Path', `${m.pathSummary || 'none'} / geodata ${m.pathfinding?.pathLength ?? 0}`]] : []),
        ['Blockers', s.blockers?.join(', ') || 'none'], ...((invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) ? [['Decision', Status.decisionSummary(d.role || d.hunt, d.role ? 'role' : 'hunt')],
        ['Target AI', Status.decisionSummary(d.target, 'target')], ['Combat AI', Status.decisionSummary(d.combat, 'combat')],
        ['PvP AI', Status.decisionSummary(d.pvp, 'pvp')]] : []),
        ['Buffs', buffs.eligible ? `WW ${buffs.windWalk}s / Shield ${buffs.shield}s / Haste ${buffs.haste}s / Might ${buffs.might}s${buffs.needsRefresh ? ' / refresh' : ''}` : `Might ${buffs.might ?? 0}s`],
        ['Trade', trade.last || (trade.shoppingTarget ? `going to ${trade.shoppingTarget.name}` : trade.store ? `${trade.store.type} / ${trade.store.title}` : 'none')],
        ['Spot detail', s.spot ? `${s.spot.name} / Lv ${s.spot.minLevel}-${s.spot.maxLevel} / density ${s.spot.density}` : 'none']];
    return { ...identity(s), phase: 'active', hp: pct(s.vitals?.hpPct), mp: pct(s.vitals?.mpPct), rows: fields(tab === 'details' ? details : overview) };
}
function cold(state, tab) {
    const stats = state.stats || {}, travel = stats.travel, lead = stats.marketLead, wanted = stats.marketWanted;
    const persona = invoke('GameServer/Bot/AI/BotPersona').of(state);
    const goal = invoke('GameServer/Bot/Goals/GoalState').snapshot(state.characterId)?.current;
    const goalLabel = !goal ? 'none' : goal.plan?.personaDrive === 'wealth'
        ? `${goal.type}: wealth / ${goal.target?.focusItem?.itemName || 'best surplus'}`
        : `${goal.type}: ${goal.plan?.expectedBenefit || 'active'}`;
    const overview = [['Activity', words(state.activity)], ['Role', words(state.party?.role || stats.role || 'dps')],
        ['Region', state.currentRegion || 'unknown'], ['Party', state.party?.partyId || 'none'], ['Goal', goalLabel], ...personality(persona)];
    const details = [['Region / spot', `${state.currentRegion || 'unknown'} / ${state.spotId || 'none'}`], ['Goal', goalLabel],
        ['Travel', travel ? `${travel.reason} -> ${travel.townName || 'field'}` : 'none'],
        ['Market lead', lead ? `${lead.itemName} in ${lead.town} for ${lead.price}` : 'none'],
        ['WTB', wanted?.itemName || (wanted?.itemId ? `Item ${wanted.itemId}` : 'none')],
        ['Party bonds', `${Object.keys(stats.partyHistory || {}).length} remembered partners`], ['Vitals source', 'Latest background simulation state; Refresh to update']];
    return { ...identity(state), phase: 'background', hp: savedPercent(state.vitals, 'hp', 'maxHp'),
        mp: savedPercent(state.vitals, 'mp', 'maxMp'), rows: fields(tab === 'details' ? details : overview) };
}
async function render(session, open = false) {
    if (!session?.actor || session.nativeStatusVersion !== 1 || !session.nativeStatusOpen) return;
    const actor = session.actor, revision = session.nativeStatusRevision = (session.nativeStatusRevision || 0) + 1;
    const view = { ...(session.nativeStatusView ||= { name: '', tab: 'list', page: 0 }) };
    let data = { name: '', level: 0, classId: 0, className: '', phase: 'list', hp: 101, mp: 101, rows: [] }, message = '';
    try {
        if (view.tab === 'list') {
            const targets = Manager.sessions.filter((s) => s.actor).slice().sort((a, b) => a.actor.fetchName().localeCompare(b.actor.fetchName()));
            const pages = Math.max(1, Math.ceil(targets.length / 8)); view.page = Math.min(view.page, pages - 1);
            // Detailed status collection is bounded to the visible page.
            data.rows = targets.slice(view.page * 8, view.page * 8 + 8).map((t) => {
                const s = Manager.getBotStatus(t);
                return { ...identity(s || { name: t.actor.fetchName(), level: t.actor.fetchLevel?.(), classId: t.actor.fetchClassId?.() }),
                    summary: s?.available ? `${words(s.mode)} / ${words(s.intent)}` : 'Status unavailable' };
            });
            data.total = targets.length; data.pages = pages;
        } else {
            let target = Manager.findSessionByName(view.name), saved = null;
            if (!target) {
                saved = await Life.findByName(view.name);
                if (session.actor !== actor || !session.nativeStatusOpen || session.nativeStatusRevision !== revision) return;
                target = Manager.findSessionByName(view.name);
            }
            data = (target ? hot(session, target, view.tab) : saved ? cold(saved, view.tab) : null)
                || { ...data, name: view.name, phase: 'missing', rows: [], message: 'Character is unavailable. Try Refresh.' };
        }
    } catch (error) {
        utils.infoWarn('BotStatus', 'native snapshot failed: %s', error.message);
        data.rows = []; data.phase = 'missing'; message = 'Could not load status. Try Refresh.';
    }
    if (session.actor !== actor || !session.nativeStatusOpen || session.nativeStatusVersion !== 1 || session.nativeStatusRevision !== revision) return;
    const total = data.total ?? data.rows.length, pages = data.pages ?? Math.max(1, Math.ceil(total / 8));
    view.page = Math.min(view.page, pages - 1); session.nativeStatusView = view;
    const rows = view.tab === 'list' ? data.rows : data.rows.slice(view.page * 8, view.page * 8 + 8);
    session.nativeStatusVisible = view.tab === 'list' ? rows.map((r) => r.name) : [];
    session.dataSendToMe(Response.npcHtml(actor.fetchId(), Protocol.encode({ ...data, ...view,
        name: view.tab === 'list' ? view.name : data.name, total, pages, open, message: message || data.message || '' }, rows)));
}
function open(session, name = '') {
    session.botStatusName = name;
    session.nativeStatusOpen = true;
    session.nativeStatusView = { name, tab: name ? 'overview' : 'list', page: 0 };
    return render(session, true);
}
function handler(session, parts) {
    if (!session?.actor) return;
    const action = parts[1];
    if (action === 'close') { session.nativeStatusOpen = false; session.nativeStatusRevision = (session.nativeStatusRevision || 0) + 1; return; }
    if (action === 'open') {
        if (!['0', '1'].includes(parts[2])) return;
        session.nativeStatusVersion = Number(parts[2]);
        if (parts[2] === '1') return open(session, session.botStatusName || '');
        session.nativeStatusOpen = false;
        return invoke('GameServer/World/Generics/NpcBypasses/BotStatus')(session, ['bot-status', session.nativeStatusView?.name || session.botStatusName]);
    }
    if (session.nativeStatusVersion !== 1 || !session.nativeStatusOpen) return;
    const view = session.nativeStatusView;
    if (action === 'inspect') {
        if (!session.nativeStatusVisible?.includes(parts[2])) return;
        return open(session, parts[2]);
    }
    if (action === 'list') {
        // List is navigation within the current inspector, not a new selection.
        view.tab = 'list'; view.page = 0;
        return render(session);
    }
    if (action === 'tab') {
        if (!view.name || !['overview', 'details'].includes(parts[2])) return;
        view.tab = parts[2]; view.page = 0;
    } else if (action === 'page') {
        if (!/^\d{1,6}$/.test(parts[2] || '')) return;
        view.page = Number(parts[2]);
    } else if (action !== 'refresh') return;
    return render(session);
}
handler.open = open; handler.render = render;
module.exports = handler;
