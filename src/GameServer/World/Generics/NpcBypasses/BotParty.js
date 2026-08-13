const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const Html = invoke('GameServer/World/Generics/HtmlKit');
const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');

const CANDIDATES_PER_PAGE = 8;
const MAX_SEARCH_LENGTH = 16;
const LEVEL_RANGES = Object.freeze([
    { key: '1-19', label: 'Lv 1-19', min: 1, max: 19 },
    { key: '20-39', label: 'Lv 20-39', min: 20, max: 39 },
    { key: '40-49', label: 'Lv 40-49', min: 40, max: 49 },
    { key: '50-59', label: 'Lv 50-59', min: 50, max: 59 },
    { key: '60-69', label: 'Lv 60-69', min: 60, max: 69 },
    { key: '70+', label: 'Lv 70+', min: 70, max: Number.MAX_SAFE_INTEGER }
]);
const ROLE_FILTERS = Object.freeze([
    { key: 'tank', label: 'Tank', roles: ['tank'] },
    { key: 'melee', label: 'Melee DD', roles: ['dps', 'dagger', 'crafter'] },
    { key: 'mage', label: 'Mage DD', roles: ['mage'] },
    { key: 'archer', label: 'Archer', roles: ['archer'] },
    { key: 'support', label: 'Support / Buffer', roles: ['buffer'] },
    { key: 'healer', label: 'Healer', roles: ['healer'] }
]);

function pct(value) {
    return `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`;
}

function searchText(value) {
    return String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, MAX_SEARCH_LENGTH);
}

function menuState(session) {
    session.botPartyCatalogState ??= {
        view: 'home',
        query: '',
        levelKey: null,
        roleKey: null,
        page: 0
    };
    return session.botPartyCatalogState;
}

function resetState(session) {
    session.botPartyCatalogState = {
        view: 'home',
        query: '',
        levelKey: null,
        roleKey: null,
        page: 0
    };
    return session.botPartyCatalogState;
}

function candidateCatalog(session) {
    return BotAvailability.catalogForPlayer(
        session,
        BotManager.sessions,
        BotLifeState.allStates(2000)
    ).map((candidate) => ({
        ...candidate,
        profession: BotRoles.presentation(candidate.subject)
    }));
}

function compareCandidates(a, b) {
    return b.level - a.level || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
}

function selectedCandidates(catalog, state) {
    if (state.view === 'search') {
        const query = state.query.toLowerCase();
        return catalog
            .filter((candidate) => candidate.name.toLowerCase().includes(query))
            .sort(compareCandidates);
    }

    if (state.view !== 'results') return [];
    const range = LEVEL_RANGES.find((item) => item.key === state.levelKey);
    const role = ROLE_FILTERS.find((item) => item.key === state.roleKey);
    if (!range || !role) return [];

    return catalog
        .filter((candidate) => candidate.level >= range.min && candidate.level <= range.max)
        .filter((candidate) => role.roles.includes(candidate.profession.role))
        .sort(compareCandidates);
}

function pageNavigation(page, totalPages, candidateCount) {
    if (totalPages <= 1) return '';

    return '<br1>' + Html.columns([
        Html.cell(
            page > 0 ? Html.link('Previous', `bot-party page ${page - 1}`, { color: Html.COLOR.link }) : '',
            { width: 80, align: 'left' }
        ),
        Html.cell(Html.font(`Page ${page + 1}/${totalPages} (${candidateCount})`, Html.COLOR.muted), { width: 110, align: 'center' }),
        Html.cell(
            page + 1 < totalPages ? Html.link('Next', `bot-party page ${page + 1}`, { color: Html.COLOR.link }) : '',
            { width: 80, align: 'right' }
        )
    ]);
}

function searchPanel(state) {
    const current = state.query ? `<br1>${Html.font(`Search: ${state.query}`, Html.COLOR.muted)}` : '';
    return Html.section('Find by name',
        Html.columns([
            Html.cell(`<edit var="bot_name" width=155 height=15 length=${MAX_SEARCH_LENGTH}>`, { width: 165 }),
            Html.cell(Html.button('Search', 'bot-party search $bot_name', { width: 85 }), { width: 95, align: 'right' })
        ]) + current
    );
}

function levelPanel(catalog) {
    const rows = [];
    for (let index = 0; index < LEVEL_RANGES.length; index += 2) {
        rows.push(Html.row(LEVEL_RANGES.slice(index, index + 2).map((range) => {
            const count = catalog.filter((candidate) => candidate.level >= range.min && candidate.level <= range.max).length;
            return Html.cell(Html.button(`${range.label} (${count})`, `bot-party level ${range.key}`, { width: 125 }), { width: 135, align: 'center' });
        })));
    }
    return Html.section('Browse by level', Html.table(rows));
}

function rolePanel(catalog, state) {
    const range = LEVEL_RANGES.find((item) => item.key === state.levelKey);
    if (!range) return '';
    const inRange = catalog.filter((candidate) => candidate.level >= range.min && candidate.level <= range.max);
    const rows = [];
    for (let index = 0; index < ROLE_FILTERS.length; index += 2) {
        rows.push(Html.row(ROLE_FILTERS.slice(index, index + 2).map((role) => {
            const count = inRange.filter((candidate) => role.roles.includes(candidate.profession.role)).length;
            return Html.cell(Html.button(`${role.label} (${count})`, `bot-party role ${role.key}`, { width: 125 }), { width: 135, align: 'center' });
        })));
    }
    return Html.section(`Role for ${range.label}`, Html.table(rows));
}

function candidateHp(candidate) {
    if (candidate.phase === 'hot') {
        return pct(BotManager.getBotStatus(candidate.session)?.vitals?.hpPct);
    }
    const hp = Number(candidate.state?.vitals?.hp || 0);
    const maxHp = Number(candidate.state?.vitals?.maxHp || 0);
    return maxHp > 0 ? pct(hp / maxHp) : '?';
}

function candidateMode(candidate) {
    if (candidate.phase === 'hot') return BotManager.getBotStatus(candidate.session)?.mode || candidate.session?.plan || 'active';
    return candidate.state?.activity || 'background';
}

function candidateAvailability(session, candidate) {
    return candidate.phase === 'hot'
        ? BotAvailability.evaluate(session, candidate.session)
        : BotAvailability.evaluateState(session, candidate.state);
}

function candidateCard(candidate, page) {
    const availability = candidate.availability;
    const action = availability.available
        ? Html.link('Invite', `bot-party invite ${candidate.name} ${page}`, { color: Html.COLOR.ok })
        : Html.font(availability.reasonText, Html.COLOR.muted);
    const className = candidate.profession.className || 'Unknown profession';
    const phase = candidate.phase === 'hot' ? 'active' : 'background';
    const relationship = availability.relationship;

    let body = Html.table([
        Html.row([
            Html.cell(`${Html.font(candidate.name, Html.COLOR.title)}<br1>${Html.font(`Lv ${candidate.level} ${className}`, Html.COLOR.muted)} ${Html.font(candidate.profession.role, Html.COLOR.link)}`, { width: 180 }),
            Html.cell(action, { width: 90, align: 'right' })
        ])
    ]);
    body += Html.font(`${phase} / ${candidateMode(candidate)} / ${relationship} / HP ${candidateHp(candidate)}`, Html.COLOR.muted);
    body += '<br1>' + Html.line(Html.TEXTURE.blank, Html.WIDTH, 5);
    return body;
}

function resultTitle(state, candidateCount) {
    if (state.view === 'search') return `Name matches for "${state.query}" (${candidateCount})`;
    const range = LEVEL_RANGES.find((item) => item.key === state.levelKey);
    const role = ROLE_FILTERS.find((item) => item.key === state.roleKey);
    return `${range?.label || 'Level'} / ${role?.label || 'Role'} (${candidateCount})`;
}

function resultsPanel(session, candidates, state) {
    const totalPages = Math.max(1, Math.ceil(candidates.length / CANDIDATES_PER_PAGE));
    const numericPage = Number(state.page);
    const page = Math.min(totalPages - 1, Math.max(0, Number.isFinite(numericPage) ? Math.floor(numericPage) : 0));
    state.page = page;
    const first = page * CANDIDATES_PER_PAGE;
    const visibleCandidates = candidates
        .slice(first, first + CANDIDATES_PER_PAGE)
        .map((candidate) => ({
            ...candidate,
            availability: candidateAvailability(session, candidate)
        }));
    let body = Html.section(resultTitle(state, candidates.length), '');

    visibleCandidates.forEach((candidate) => {
        body += candidateCard(candidate, page);
    });
    if (candidates.length === 0) {
        body += Html.font('No bots match this selection.', Html.COLOR.muted);
    }
    body += pageNavigation(page, totalPages, candidates.length);
    return body;
}

function footer(state) {
    const actions = [];
    if (state.view === 'results') actions.push({ label: 'Back to roles', command: 'bot-party back', color: Html.COLOR.link });
    else if (state.view === 'roles') actions.push({ label: 'Back to levels', command: 'bot-party back', color: Html.COLOR.link });
    else if (state.view === 'search') actions.push({ label: 'Clear search', command: 'bot-party home', color: Html.COLOR.link });
    actions.push({ label: 'Refresh', command: 'bot-party refresh', color: Html.COLOR.link });
    actions.push({ label: 'Close', command: 'bot-party close', color: Html.COLOR.muted });
    return '<br>' + Html.actionFooter(actions);
}

function render(session, requestedPage) {
    const actor = session.actor;
    if (!actor) return;

    const state = menuState(session);
    if (requestedPage !== undefined) state.page = requestedPage;
    const catalog = candidateCatalog(session);
    let body = `${Html.font('Bot Party Finder', Html.COLOR.title)}<br1>`;
    body += `${Html.font(`${catalog.length} adventurers. Active and background bots can join from anywhere.`, Html.COLOR.muted)}<br1>`;

    if (state.view === 'home' || state.view === 'search') {
        body += searchPanel(state);
    }
    if (state.view === 'home') {
        body += levelPanel(catalog);
    } else if (state.view === 'roles') {
        body += rolePanel(catalog, state);
    } else if (state.view === 'search' || state.view === 'results') {
        body += resultsPanel(session, selectedCandidates(catalog, state), state);
    }
    body += footer(state);

    const html = Html.page(body, { title: 'Bot Party' });
    session.dataSendToMe(ServerResponse.npcHtml(actor.fetchId(), html));
}

function open(session) {
    resetState(session);
    render(session);
}

function botParty(session, parts) {
    const actor = session.actor;
    if (!actor) return;
    const state = menuState(session);
    const action = parts[1];

    if (action === 'close') return;
    if (action === 'home') {
        resetState(session);
        return render(session);
    }
    if (action === 'search') {
        state.view = 'search';
        state.query = searchText(parts[2]);
        state.levelKey = null;
        state.roleKey = null;
        state.page = 0;
        if (!state.query) state.view = 'home';
        return render(session);
    }
    if (action === 'level' && LEVEL_RANGES.some((range) => range.key === parts[2])) {
        state.view = 'roles';
        state.query = '';
        state.levelKey = parts[2];
        state.roleKey = null;
        state.page = 0;
        return render(session);
    }
    if (action === 'role' && ROLE_FILTERS.some((role) => role.key === parts[2])) {
        state.view = 'results';
        state.roleKey = parts[2];
        state.page = 0;
        return render(session);
    }
    if (action === 'back') {
        if (state.view === 'results') {
            state.view = 'roles';
            state.roleKey = null;
        } else {
            resetState(session);
        }
        state.page = 0;
        return render(session);
    }
    if (action === 'page') return render(session, parts[2]);
    if (action === 'refresh') return render(session);

    if (action === 'invite' && parts[2]) {
        World.inviteBotByName(session, actor, parts[2], undefined, 'botparty');
        return render(session, parts[3]);
    }

    resetState(session);
    render(session);
}

botParty.render = render;
botParty.open = open;
botParty.CANDIDATES_PER_PAGE = CANDIDATES_PER_PAGE;
botParty.LEVEL_RANGES = LEVEL_RANGES;
botParty.ROLE_FILTERS = ROLE_FILTERS;

module.exports = botParty;
