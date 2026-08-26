const ActorFilters = window.WorldObserverActorFilters;
const Leaderboards = window.WorldObserverLeaderboards;
const WorldState = window.WorldObserverWorldState;
const MapClusters = window.WorldObserverMapClusters;
const Router = window.WorldObserverSpaRouter;
const UiLanguage = window.WorldObserverUiLanguage;

const state = {
    snapshot: null,
    refreshing: false,
    worldRevision: 0,
    worldEpoch: null,
    worldStatusAt: 0,
    worldStatusLoading: false,
    selectedId: null,
    phase: 'all',
    search: '',
    minLevel: null,
    maxLevel: null,
    classKey: 'all',
    classOptionsSignature: null,
    live: true,
    fit: false,
    renderedTileKey: null,
    viewport: null,
    drag: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    detailRequest: 0,
    clusterScope: null,
    rankingOpen: false,
    rankingMetric: 'level',
    rankingRaceKey: 'all',
    rankingClassKey: 'all',
    rankingFocusReturn: null,
    raidBossOpen: false,
    raidBossFilter: 'all',
    raidBossSearch: '',
    selectedRaidBossId: null,
    raidBossFocusReturn: null,
    clanOpen: false,
    clanSort: 'level',
    clanSearch: '',
    clanDirectory: null,
    selectedClanId: null,
    clanDetail: null,
    clanDetailSignature: null,
    clanDetailLoading: false,
    clanError: null,
    clanRequest: 0,
    clanLastLoadedAt: 0,
    clanFocusReturn: null,
    clanManagerOpen: false,
    clanCrestFit: 'cover',
    clanCrestSource: null,
    clanCrestDraft: null,
    clanCrestSaving: false,
    clanCrestMessage: null,
    applyingRoute: false,
    pendingRoute: null
};

function commitRoute(route, { replace = false } = {}) {
    if (state.applyingRoute) return;
    const href = Router.href(route);
    if (window.location.pathname === href) return;
    window.history[replace ? 'replaceState' : 'pushState']({}, '', href);
}

function clearActorSelection() {
    state.selectedId = null;
    state.selectedRaidBossId = null;
    state.detail = null;
    state.detailError = null;
    state.detailLoading = false;
    state.detailRequest += 1;
}

function applyRoute(route = Router.parse(window.location.pathname)) {
    if (route.name === 'not-found') {
        window.history.replaceState({}, '', Router.href({ name: 'world' }));
        route = { name: 'world' };
    }
    state.applyingRoute = true;
    state.pendingRoute = null;
    try {
        if (route.name === 'world') {
            document.title = 'World Observer';
            closeRankings({ updateRoute: false });
            closeRaidBosses({ updateRoute: false });
            closeClans({ updateRoute: false });
            clearActorSelection();
            if (state.snapshot) {
                renderPoints();
                renderRoster();
                renderSelected();
            }
            return;
        }
        if (route.name === 'rankings') {
            openRankings({ updateRoute: false });
            return;
        }
        if (route.name === 'clans') {
            openClans(route.id, { updateRoute: false });
            return;
        }
        if (route.name === 'raid-bosses') {
            if (route.id) {
                if (!state.snapshot) state.pendingRoute = route;
                else focusRaidBoss(route.id, false);
            } else openRaidBosses({ updateRoute: false });
            return;
        }
        if (route.name === 'actor') {
            if (!state.snapshot) state.pendingRoute = route;
            else selectActor(route.id, route.kind, true, false);
        }
    } finally {
        state.applyingRoute = false;
    }
}

function worldEpochChanged(epoch) {
    return Boolean(epoch && state.worldEpoch && String(epoch) !== String(state.worldEpoch));
}

function restartWorldBootstrap(epoch = null) {
    state.snapshot = null;
    state.worldRevision = 0;
    state.worldEpoch = epoch || null;
    state.worldStatusAt = 0;
    setTimeout(refresh, 0);
}

const COLORS = {
    hot: '#63d37b',
    warm: '#e2a84f',
    cold: '#7aa7ff',
    player: '#57c7e8',
    merchant: '#d8b96d',
    dead: '#e66d61',
    pk: '#ff3b30',
    mixed: '#d8b96d'
};

const PHASE_LABELS = Object.freeze({
    hot: 'Active',
    warm: 'Background',
    cold: 'Simulated',
    player: 'Player',
    players: 'Players',
    raidbosses: 'Raid bosses'
});

const ROLE_LABELS = Object.freeze({
    dps: 'Damage',
    tank: 'Tank',
    healer: 'Healer',
    buffer: 'Buffer',
    mage: 'Mage',
    archer: 'Archer',
    dagger: 'Dagger',
    crafter: 'Crafter',
    player: 'Player',
    member: 'Member'
});

const ACTIVITY_LABELS = Object.freeze({
    background_active: 'Active in background',
    background_resolve: 'Simulating',
    buy: 'Buying',
    complete_errand: 'Finishing an errand',
    crafting: 'Crafting',
    craft: 'Crafting',
    dead: 'Dead',
    find_party: 'Looking for party',
    focused: 'Focused',
    grouped: 'In a party',
    hunting: 'Hunting',
    idle: 'Idle',
    merchant: 'Trading',
    neutral: 'Neutral',
    offline: 'Offline',
    online: 'Online',
    party_wait: 'Looking for party',
    pk_hunting: 'PK hunting',
    progress_gear: 'Improving gear',
    recover: 'Recovering',
    resting: 'Resting',
    sell: 'Selling',
    shopping: 'Shopping',
    store: 'Store',
    trade: 'Trading',
    traveling: 'Traveling'
});

const RANKING_DISPLAY_LIMIT = 250;

const els = {
    observerShell: document.querySelector('.observer-shell'),
    serverLine: document.querySelector('#serverLine'),
    liveToggle: document.querySelector('#liveToggle'),
    liveLabel: document.querySelector('.live-label'),
    fitButton: document.querySelector('#fitButton'),
    zoomInButton: document.querySelector('#zoomInButton'),
    zoomOutButton: document.querySelector('#zoomOutButton'),
    filterStrip: document.querySelector('#filterStrip'),
    actorSearch: document.querySelector('#actorSearch'),
    minLevelFilter: document.querySelector('#minLevelFilter'),
    maxLevelFilter: document.querySelector('#maxLevelFilter'),
    classFilter: document.querySelector('#classFilter'),
    clearActorFilters: document.querySelector('#clearActorFilters'),
    worldMap: document.querySelector('#worldMap'),
    tileLayer: document.querySelector('#tileLayer'),
    gridLines: document.querySelector('#gridLines'),
    regionLabels: document.querySelector('#regionLabels'),
    pointsLayer: document.querySelector('#pointsLayer'),
    raidBossLayer: document.querySelector('#raidBossLayer'),
    selectedCard: document.querySelector('#selectedCard'),
    selectedInspector: document.querySelector('#selectedInspector'),
    botsTotal: document.querySelector('#botsTotal'),
    playersTotal: document.querySelector('#playersTotal'),
    populationSubline: document.querySelector('#populationSubline'),
    phaseBars: document.querySelector('#phaseBars'),
    marketScope: document.querySelector('#marketScope'),
    marketWts: document.querySelector('#marketWts'),
    marketWtb: document.querySelector('#marketWtb'),
    marketTrades: document.querySelector('#marketTrades'),
    marketAdena: document.querySelector('#marketAdena'),
    marketTowns: document.querySelector('#marketTowns'),
    marketTopItem: document.querySelector('#marketTopItem'),
    marketRecentTrades: document.querySelector('#marketRecentTrades'),
    marketTradeTop: document.querySelector('#marketTradeTop'),
    actorList: document.querySelector('#actorList'),
    lastRefresh: document.querySelector('#lastRefresh'),
    visibleCount: document.querySelector('#visibleCount'),
    inspectorFreshness: document.querySelector('#inspectorFreshness'),
    openRankings: document.querySelector('#openRankings'),
    rankingsModal: document.querySelector('#rankingsModal'),
    closeRankings: document.querySelector('#closeRankings'),
    rankingTabs: document.querySelector('#rankingTabs'),
    rankingRace: document.querySelector('#rankingRace'),
    rankingClass: document.querySelector('#rankingClass'),
    rankingPodium: document.querySelector('#rankingPodium'),
    rankingScope: document.querySelector('#rankingScope'),
    rankingList: document.querySelector('#rankingList'),
    openRaidBosses: document.querySelector('#openRaidBosses'),
    closeRaidBosses: document.querySelector('#closeRaidBosses'),
    raidBossesModal: document.querySelector('#raidBossesModal'),
    raidBossFilters: document.querySelector('#raidBossFilters'),
    raidBossSearch: document.querySelector('#raidBossSearch'),
    raidBossSummary: document.querySelector('#raidBossSummary'),
    raidBossScope: document.querySelector('#raidBossScope'),
    raidBossList: document.querySelector('#raidBossList'),
    raidBossAliveCount: document.querySelector('#raidBossAliveCount'),
    openClans: document.querySelector('#openClans'),
    closeClans: document.querySelector('#closeClans'),
    clansModal: document.querySelector('#clansModal'),
    clanCount: document.querySelector('#clanCount'),
    clanSummary: document.querySelector('#clanSummary'),
    clanSortTabs: document.querySelector('#clanSortTabs'),
    clanSearch: document.querySelector('#clanSearch'),
    clanScope: document.querySelector('#clanScope'),
    clanList: document.querySelector('#clanList'),
    clanDetail: document.querySelector('#clanDetail')
};

const DEFAULT_TILES = {
    rawBaseUrl: 'https://raw.githubusercontent.com/npetrovski/l2-world-map/main/Maps',
    blockSize: 32768,
    blockPx: 900,
    x: { min: 16, max: 26, mid: 20 },
    y: { min: 10, max: 25, mid: 18 },
    missingTiles: [
        '17_14',
        '18_13',
        '26_13',
        '26_15',
        '26_16',
        '26_17',
        '26_18',
        '26_19'
    ]
};

const RAID_BOSS_STATUS_LABELS = Object.freeze({
    alive: 'In world',
    respawning: 'Respawning',
    missing: 'Not in world'
});

function svgEl(name, attrs = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function text(value, fallback = '—') {
    return escapeHtml(value === null || value === undefined || value === '' ? fallback : value);
}

function number(value, fallback = '—') {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toLocaleString() : fallback;
}

function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

function formatTime(timestamp) {
    if (!timestamp) return '—';
    return new Date(Number(timestamp)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function compactNumber(value) {
    const amount = Math.max(0, Number(value || 0));
    if (amount < 1000) return amount.toLocaleString();
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: amount < 10000 ? 1 : 0 }).format(amount);
}

function formatRelative(timestamp) {
    if (!timestamp) return 'no update';
    const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp)) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    return `${Math.round(seconds / 60)}m ago`;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function mapMeta() {
    const tiles = state.snapshot?.mapTiles || DEFAULT_TILES;
    const width = (tiles.x.max - tiles.x.min + 1) * tiles.blockPx;
    const height = (tiles.y.max - tiles.y.min + 1) * tiles.blockPx;
    return { ...tiles, width, height };
}

function clampViewport(viewport) {
    const tiles = mapMeta();
    const minWidth = 240;
    const minHeight = 170;
    const width = clamp(viewport.width, minWidth, tiles.width);
    const height = clamp(viewport.height, minHeight, tiles.height);
    return {
        x: clamp(viewport.x, 0, Math.max(0, tiles.width - width)),
        y: clamp(viewport.y, 0, Math.max(0, tiles.height - height)),
        width,
        height
    };
}

function worldToMap(loc) {
    const tiles = mapMeta();
    const locX = Number(loc?.locX || 0);
    const locY = Number(loc?.locY || 0);
    const blockX = Math.floor(locX / tiles.blockSize) + tiles.x.mid;
    const blockY = Math.floor(locY / tiles.blockSize) + tiles.y.mid;
    let modX = (locX / tiles.blockSize) % 1;
    let modY = (locY / tiles.blockSize) % 1;
    if (modX < 0) modX += 1;
    if (modY < 0) modY += 1;

    return {
        x: ((blockX - tiles.x.min) * tiles.blockPx) + (modX * tiles.blockPx),
        y: ((blockY - tiles.y.min) * tiles.blockPx) + (modY * tiles.blockPx)
    };
}

function project(loc) {
    const point = worldToMap(loc);
    const tiles = mapMeta();
    return {
        x: clamp(point.x, 18, tiles.width - 18),
        y: clamp(point.y, 18, tiles.height - 18)
    };
}

function setViewBox() {
    const viewport = state.viewport || { x: 0, y: 0, width: mapMeta().width, height: mapMeta().height };
    els.worldMap.setAttribute('viewBox', `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`);
}

function setSvgViewBox() {
    const tiles = mapMeta();
    els.worldMap.querySelector('.sea').setAttribute('width', tiles.width);
    els.worldMap.querySelector('.sea').setAttribute('height', tiles.height);

    if (!state.viewport) {
        state.viewport = { x: 0, y: 0, width: tiles.width, height: tiles.height };
    }

    if (!state.fit || !state.snapshot) {
        state.viewport = clampViewport(state.viewport);
        setViewBox();
        return;
    }

    const locs = filteredActors().filter(isSurfaceActor).map(mapLocation).filter(Boolean);
    if (locs.length < 2) {
        state.viewport = { x: 0, y: 0, width: tiles.width, height: tiles.height };
        setViewBox();
        return;
    }

    const points = locs.map(worldToMap);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const pad = 900;
    const minX = clamp(Math.min(...xs) - pad, 0, tiles.width);
    const minY = clamp(Math.min(...ys) - pad, 0, tiles.height);
    const maxX = clamp(Math.max(...xs) + pad, 0, tiles.width);
    const maxY = clamp(Math.max(...ys) + pad, 0, tiles.height);
    state.viewport = clampViewport({
        x: minX,
        y: minY,
        width: Math.max(1800, maxX - minX),
        height: Math.max(1200, maxY - minY)
    });
    setViewBox();
}

function clientToMapPoint(clientX, clientY) {
    const viewport = state.viewport || { x: 0, y: 0, width: mapMeta().width, height: mapMeta().height };
    const metrics = mapViewportMetrics(viewport);
    return {
        x: viewport.x + ((clientX - metrics.left) / metrics.scale),
        y: viewport.y + ((clientY - metrics.top) / metrics.scale)
    };
}

function mapViewportMetrics(viewport = state.viewport || { x: 0, y: 0, width: mapMeta().width, height: mapMeta().height }) {
    const rect = els.worldMap.getBoundingClientRect();
    const scale = Math.max(0.0001, Math.min(rect.width / viewport.width, rect.height / viewport.height));
    const renderedWidth = viewport.width * scale;
    const renderedHeight = viewport.height * scale;
    return {
        rect,
        scale,
        left: rect.left + (rect.width - renderedWidth) / 2,
        top: rect.top + (rect.height - renderedHeight) / 2
    };
}

function applyViewport(viewport) {
    state.fit = false;
    els.fitButton.classList.remove('is-live');
    state.viewport = clampViewport(viewport);
    setViewBox();
    renderLabels();
    renderPoints();
}

function phaseColor(item) {
    if (item.isPk) return COLORS.pk;
    if (item.kind === 'player') return COLORS.player;
    if (item.mode === 'merchant') return COLORS.merchant;
    if (item.blockers?.includes('dead')) return COLORS.dead;
    return COLORS[item.phase] || COLORS.cold;
}

function actors() {
    const snap = state.snapshot;
    if (!snap) return [];
    return [
        ...snap.bots.map((bot) => ({ ...bot, kind: 'bot' })),
        ...snap.players.map((player) => ({
            ...player,
            kind: 'player',
            phase: 'player',
            mode: 'player',
            role: 'player',
            intent: player.online ? 'online' : 'offline'
        }))
    ];
}

function raidBossItems() {
    return state.snapshot?.raidBosses?.bosses || [];
}

function raidBossStatusLabel(status) {
    return RAID_BOSS_STATUS_LABELS[status] || RAID_BOSS_STATUS_LABELS.missing;
}

function raidBossCoordinates(loc) {
    if (!loc) return 'Coordinates unavailable';
    return `${number(Math.round(Number(loc.locX || 0)))} · ${number(Math.round(Number(loc.locY || 0)))} · ${number(Math.round(Number(loc.locZ || 0)))}`;
}

function filteredRaidBosses() {
    const query = state.raidBossSearch.trim().toLowerCase();
    return raidBossItems().filter((boss) => {
        if (state.raidBossFilter !== 'all' && boss.status !== state.raidBossFilter) return false;
        if (!query) return true;
        return [boss.name, boss.location?.name, boss.level, boss.id]
            .filter((value) => value !== null && value !== undefined)
            .join(' ')
            .toLowerCase()
            .includes(query);
    });
}

function renderRaidBosses() {
    const raidBossState = state.snapshot?.raidBosses;
    const counts = raidBossState?.counts || { alive: 0, respawning: 0, missing: 0 };
    const scrollTop = els.raidBossList?.scrollTop || 0;
    if (els.raidBossAliveCount) els.raidBossAliveCount.textContent = Number(counts.alive || 0).toLocaleString();
    if (!els.raidBossList || !els.raidBossSummary || !els.raidBossScope) return;
    if (!raidBossState) {
        els.raidBossSummary.textContent = 'Waiting for raid-boss data.';
        els.raidBossScope.textContent = '0 bosses';
        els.raidBossList.innerHTML = '<div class="list-empty">Waiting for raid-boss data.</div>';
        return;
    }

    els.raidBossSummary.textContent = `${number(counts.alive)} in world · ${number(counts.respawning)} respawning · ${number(counts.missing)} missing · ${number(raidBossState.total)} total`;
    const bosses = filteredRaidBosses();
    els.raidBossScope.textContent = `${number(bosses.length)} boss${bosses.length === 1 ? '' : 'es'}`;
    els.raidBossList.innerHTML = bosses.length
        ? bosses.map((boss) => {
            const clickable = boss.status === 'alive' && boss.loc;
            const timer = boss.status === 'alive'
                ? 'In world'
                : boss.status === 'respawning'
                    ? formatDuration(Math.max(0, Number(boss.respawnAt || 0) - Date.now()))
                    : 'Not found';
            return `<button class="raid-boss-row ${escapeHtml(boss.status)}${clickable ? '' : ' is-missing'}" type="button" data-raid-boss-id="${escapeHtml(boss.id)}" ${clickable ? '' : 'disabled'}>
                <i class="raid-boss-dot ${escapeHtml(boss.status)}"></i>
                <span class="raid-boss-identity"><strong>${text(boss.name)}</strong><span>Lv ${number(boss.level, '?')} · NPC ${number(boss.id)}</span></span>
                <span class="raid-boss-location"><strong>${text(boss.location?.name, 'Unknown location')}</strong><span>${text(raidBossCoordinates(boss.loc), 'Coordinates unavailable')}</span></span>
                <span class="raid-boss-timer"><strong>${text(timer)}</strong><span>${text(raidBossStatusLabel(boss.status))}</span></span>
                <span>${clickable ? '<span class="raid-boss-map-button">Show on map</span>' : ''}</span>
            </button>`;
        }).join('')
        : '<div class="list-empty">No raid bosses match this filter.</div>';
    els.raidBossList.scrollTop = scrollTop;
}

function rankingValue(actor, metric = state.rankingMetric) {
    const value = Leaderboards.metricValue(actor, metric);
    if (metric === 'level') return { primary: `Lv ${number(value, 1)}`, secondary: `${number(actor.exp || 0)} EXP` };
    if (metric === 'adena') return { primary: `${compactNumber(value)} A`, secondary: `${number(value)} Adena` };
    return { primary: `${compactNumber(value)} A`, secondary: 'estimated value' };
}

function rankingActorMeta(actor) {
    const phase = actor.kind === 'player' ? 'Online player' : phaseLabel(actor.phase || 'cold');
    return `${Leaderboards.raceName(actor) || 'Unknown race'} · ${phase}`;
}

function setRankingSelect(select, firstLabel, options, selected) {
    const html = [
        `<option value="all">${firstLabel}</option>`,
        ...options.map((option) => `<option value="${escapeHtml(option.key)}">${text(option.label)}</option>`)
    ].join('');
    if (select.innerHTML !== html) select.innerHTML = html;
    select.value = selected;
}

function renderRankingFilters(items) {
    const races = Leaderboards.raceOptions(items);
    if (state.rankingRaceKey !== 'all' && !races.some((option) => option.key === state.rankingRaceKey)) {
        state.rankingRaceKey = 'all';
    }
    const classes = Leaderboards.classOptions(items, state.rankingRaceKey);
    if (state.rankingClassKey !== 'all' && !classes.some((option) => option.key === state.rankingClassKey)) {
        state.rankingClassKey = 'all';
    }
    setRankingSelect(els.rankingRace, 'All races', races, state.rankingRaceKey);
    setRankingSelect(els.rankingClass, 'All classes', classes, state.rankingClassKey);
}

function renderRankings() {
    if (!state.snapshot) {
        els.rankingPodium.innerHTML = '';
        els.rankingList.innerHTML = '<div class="list-empty">Waiting for the world snapshot.</div>';
        els.rankingScope.textContent = '0 characters';
        return;
    }

    const items = actors();
    renderRankingFilters(items);
    const ranked = Leaderboards.rankActors(items, state.rankingMetric, {
        raceKey: state.rankingRaceKey,
        classKey: state.rankingClassKey
    });
    const scrollTop = els.rankingList.scrollTop;
    const displayed = ranked.slice(0, RANKING_DISPLAY_LIMIT);
    els.rankingScope.textContent = ranked.length > displayed.length
        ? `Top ${number(displayed.length)} of ${number(ranked.length)} characters`
        : `${number(ranked.length)} character${ranked.length === 1 ? '' : 's'}`;
    els.rankingPodium.innerHTML = ranked.slice(0, 3).map((actor, index) => {
        const value = rankingValue(actor);
        return `<button class="podium-entry" type="button" data-ranking-id="${escapeHtml(actor.id)}" data-ranking-kind="${escapeHtml(actor.kind)}">
            <span class="podium-rank">#${index + 1}</span>
            <strong>${text(actor.isPk ? `PK ${actor.name}` : actor.name)}</strong>
            <span>${text(value.primary)} · ${text(actorClassName(actor))}</span>
        </button>`;
    }).join('');
    els.rankingList.innerHTML = displayed.length ? displayed.map((actor, index) => {
        const value = rankingValue(actor);
        return `<div role="listitem"><button class="ranking-row" type="button" data-ranking-id="${escapeHtml(actor.id)}" data-ranking-kind="${escapeHtml(actor.kind)}">
            <span class="ranking-position">#${number(index + 1)}</span>
            <span class="ranking-identity"><strong>${text(actor.isPk ? `PK ${actor.name}` : actor.name)}</strong><span>${text(rankingActorMeta(actor))}</span></span>
            <span class="ranking-class"><strong>${text(actorClassName(actor))}</strong><span>Level ${number(actor.level, '?')}</span></span>
            <span class="ranking-kind ${escapeHtml(actor.kind)}">${text(actor.kind === 'player' ? 'Player' : phaseLabel(actor.phase || 'bot'))}</span>
            <span class="ranking-value">${text(value.primary)}<small>${text(value.secondary)}</small></span>
        </button></div>`;
    }).join('') : '<div class="list-empty">No characters match these filters.</div>';
    els.rankingList.scrollTop = scrollTop;
}

function openRankings({ updateRoute = true } = {}) {
    if (state.raidBossOpen) closeRaidBosses({ updateRoute: false });
    if (state.clanOpen) closeClans({ updateRoute: false });
    state.rankingOpen = true;
    state.rankingFocusReturn = document.activeElement;
    renderRankings();
    els.rankingsModal.hidden = false;
    document.body.classList.add('rankings-open');
    requestAnimationFrame(() => els.closeRankings.focus());
    if (updateRoute) commitRoute({ name: 'rankings' });
}

function closeRankings({ updateRoute = true } = {}) {
    if (!state.rankingOpen) return;
    state.rankingOpen = false;
    els.rankingsModal.hidden = true;
    if (!state.raidBossOpen && !state.clanOpen) document.body.classList.remove('rankings-open');
    state.rankingFocusReturn?.focus?.();
    state.rankingFocusReturn = null;
    if (updateRoute) commitRoute({ name: 'world' });
}

function openRaidBosses({ updateRoute = true } = {}) {
    if (state.rankingOpen) closeRankings({ updateRoute: false });
    if (state.clanOpen) closeClans({ updateRoute: false });
    state.raidBossOpen = true;
    state.raidBossFocusReturn = document.activeElement;
    renderRaidBosses();
    els.raidBossesModal.hidden = false;
    document.body.classList.add('rankings-open');
    requestAnimationFrame(() => els.closeRaidBosses.focus());
    if (updateRoute) commitRoute({ name: 'raid-bosses' });
}

function closeRaidBosses({ updateRoute = true } = {}) {
    if (!state.raidBossOpen) return;
    state.raidBossOpen = false;
    els.raidBossesModal.hidden = true;
    if (!state.rankingOpen && !state.clanOpen) document.body.classList.remove('rankings-open');
    state.raidBossFocusReturn?.focus?.();
    state.raidBossFocusReturn = null;
    if (updateRoute) commitRoute({ name: 'world' });
}

function clanItems() {
    return Array.isArray(state.clanDirectory?.clans) ? state.clanDirectory.clans : [];
}

function filteredClans() {
    const query = String(state.clanSearch || '').trim().toLowerCase();
    return clanItems().filter((clan) => {
        if (!query) return true;
        return [clan.name, clan.leaderName, clan.level, clan.memberCount, clan.botMembers]
            .filter((value) => value !== null && value !== undefined)
            .join(' ')
            .toLowerCase()
            .includes(query);
    }).sort((left, right) => {
        const primary = state.clanSort === 'members'
            ? Number(right.memberCount || 0) - Number(left.memberCount || 0)
            : Number(right.level || 0) - Number(left.level || 0);
        return primary
            || Number(right.memberCount || 0) - Number(left.memberCount || 0)
            || String(left.name).localeCompare(String(right.name));
    });
}

function clanSortLabel() {
    return state.clanSort === 'members' ? 'members' : 'level';
}

function clanOverviewSignature(clan) {
    if (!clan) return null;
    return JSON.stringify([
        clan.crestId,
        clan.crestUrl,
        clan.updatedAt,
        clan.memberCount,
        clan.onlineMembers,
        clan.hotMembers,
        clan.averageLevel,
        clan.highestLevel,
        clan.lowestLevel,
        clan.warehouse,
        clan.contributions,
        clan.market,
        clan.actions,
        clan.operations,
        clan.goal
    ]);
}

function revealSelectedClan() {
    requestAnimationFrame(() => {
        els.clanList?.querySelector('.clan-row.is-selected')?.scrollIntoView({ block: 'nearest' });
    });
}

function clanCrestMarkup(clan, size = 'small') {
    if (!clan?.crestUrl) return '';
    const label = `${clan.name || 'Clan'} crest`;
    return `<span class="clan-crest clan-crest-${size}"><img src="${escapeHtml(clan.crestUrl)}" alt="${escapeHtml(label)}" loading="lazy"></span>`;
}

function renderClans() {
    const directory = state.clanDirectory;
    const totals = directory?.totals || { members: 0, bots: 0, players: 0, online: 0, autonomous: 0, playerManaged: 0 };
    const clans = filteredClans();
    if (els.clanCount) els.clanCount.textContent = Number(directory?.total || 0).toLocaleString();
    if (els.clanSummary) {
        els.clanSummary.textContent = directory
            ? `${number(directory.total)} clans · ${number(totals.bots)} bots · ${number(totals.autonomous)} autonomous · ${number(totals.playerManaged)} player-managed`
            : 'Waiting for clan data.';
    }
    if (els.clanScope) {
        els.clanScope.textContent = directory
            ? `${number(clans.length)} ${clans.length === 1 ? 'clan' : 'clans'}`
            : '0 clans';
    }
    const sortHint = els.clanList?.previousElementSibling?.querySelector('span:last-child');
    if (sortHint) sortHint.textContent = `Sorted by ${clanSortLabel()}`;
    if (!els.clanList) return;
    if (state.clanError && !directory) {
        els.clanList.innerHTML = `<div class="list-empty">Clan data failed: ${text(state.clanError)}</div>`;
        renderClanDetail();
        return;
    }
    els.clanList.innerHTML = clans.length ? clans.map((clan) => `
        <button class="clan-row${Number(clan.id) === Number(state.selectedClanId) ? ' is-selected' : ''}" type="button" data-clan-id="${escapeHtml(clan.id)}">
            <span class="clan-level">L${number(clan.level, 0)}</span>
            <span class="clan-identity">
                <strong class="clan-name-line">${clanCrestMarkup(clan)}<span class="clan-name">${text(clan.name, 'Unnamed clan')}</span></strong>
                <span>${text(clan.leaderName, 'Unknown leader')} · ${number(clan.botMembers)}/${number(clan.memberCount)} bots</span>
            </span>
            <span class="clan-row-side"><strong>${number(clan.memberCount)}</strong><span>members</span></span>
        </button>
    `).join('') : '<div class="list-empty">No clans match this search.</div>';
    renderClanDetail();
}

function clanGoalSummary(goal, clan = null) {
    if (!goal) return clan?.automated
        ? { title: 'No active goal', progress: 'Waiting', percent: 0, meta: 'Waiting for the next clan decision' }
        : { title: 'No active goal', progress: 'Player directed', percent: 0, meta: 'No clan objective has been selected' };
    const target = goal.target?.itemName || goal.target?.npcName || goal.plan?.label || uiLabel('type', goal.type, 'Operation');
    const progressValue = number(goal.progress);
    const required = number(goal.required);
    const progress = required > 0 ? `${progressValue}/${required}` : 'Ready';
    const status = uiLabel('status', goal.status || 'active');
    const plan = uiLabel('plan', goal.plan?.kind, null);
    const reason = uiLabel('reason', goal.plan?.reasonCode, null);
    return {
        title: target,
        progress,
        percent: required > 0 ? Math.max(0, Math.min(100, Math.round((progressValue / required) * 100))) : 100,
        itemId: Number(goal.target?.itemId || 0) || null,
        iconUrl: goal.target?.iconUrl || null,
        meta: [status, reason || plan].filter(Boolean).join(' · ')
    };
}

function resetClanCrestDraft() {
    state.clanCrestSource?.close?.();
    state.clanCrestSource = null;
    state.clanCrestDraft = null;
    state.clanCrestSaving = false;
}

function clanCrestPixelsBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 1) binary += String.fromCharCode(bytes[offset]);
    return window.btoa(binary);
}

function buildClanCrestDraft(source, fileName = '') {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 12;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const sourceWidth = Number(source.width || source.naturalWidth);
    const sourceHeight = Number(source.height || source.naturalHeight);
    const scale = state.clanCrestFit === 'contain'
        ? Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight)
        : Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    state.clanCrestDraft = {
        fileName,
        pixels: clanCrestPixelsBase64(pixels),
        previewUrl: canvas.toDataURL('image/png')
    };
}

function clanCrestPreview(clan) {
    const source = state.clanCrestDraft?.previewUrl || clan.crestUrl;
    return source
        ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(clan.name || 'Clan')} crest preview">`
        : `<span>${uiIcon('shield')}<small>No crest</small></span>`;
}

function clanManagementMarkup(clan) {
    if (!state.clanManagerOpen || !clan.playerManaged) return '';
    const hasDraft = !!state.clanCrestDraft;
    const message = state.clanCrestMessage;
    return `
        <section class="clan-management" aria-label="Clan management">
            <div class="clan-management-heading">
                <div><span class="section-kicker">Clan management</span><strong>Identity</strong></div>
                <p>Upload a normal image. Observer prepares the 16 × 12 crest required by the C4 client.</p>
            </div>
            <div class="clan-crest-editor">
                <div class="clan-crest-preview">${clanCrestPreview(clan)}</div>
                <div class="clan-crest-editor-main">
                    <div class="clan-crest-editor-copy">
                        <strong>Clan crest</strong>
                        <span>PNG, JPEG, WebP, GIF or BMP · up to 5 MB</span>
                    </div>
                    <div class="clan-crest-fit" role="group" aria-label="Image fit">
                        <button class="${state.clanCrestFit === 'cover' ? 'is-active' : ''}" type="button" data-crest-fit="cover" aria-pressed="${state.clanCrestFit === 'cover'}">Crop</button>
                        <button class="${state.clanCrestFit === 'contain' ? 'is-active' : ''}" type="button" data-crest-fit="contain" aria-pressed="${state.clanCrestFit === 'contain'}">Fit</button>
                    </div>
                    <div class="clan-crest-actions">
                        <label class="clan-crest-upload">
                            ${uiIcon('upload')}<span>${hasDraft ? 'Choose another' : 'Choose image'}</span>
                            <input type="file" data-clan-crest-file accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden>
                        </label>
                        <button class="clan-crest-remove" type="button" data-remove-clan-crest ${clan.crestUrl && !state.clanCrestSaving ? '' : 'disabled'}>${uiIcon('trash')}Remove</button>
                    </div>
                    <div class="clan-crest-dropzone" data-clan-crest-dropzone>or drop an image here</div>
                </div>
                <div class="clan-management-save">
                    <button type="button" data-save-clan-crest ${hasDraft && !state.clanCrestSaving ? '' : 'disabled'}>${state.clanCrestSaving ? 'Saving…' : 'Save crest'}</button>
                    <span class="${message?.kind === 'error' ? 'is-error' : ''}">${text(message?.text || (hasDraft ? `${state.clanCrestDraft.fileName || 'Image'} ready to save` : 'Only the selected clan will change'))}</span>
                </div>
            </div>
        </section>
    `;
}

function renderClanDetail() {
    if (!els.clanDetail) return;
    const detail = state.clanDetail;
    if (state.clanDetailLoading && !detail) {
        els.clanDetail.innerHTML = '<div class="inspector-empty"><span class="loading-orbit"></span><strong>Loading clan</strong><p>Reading members and durable clan state.</p></div>';
        return;
    }
    if (!detail?.clan) {
        els.clanDetail.innerHTML = state.clanError
            ? `<div class="inspector-empty"><span class="empty-glyph">!</span><strong>Clan unavailable</strong><p>${text(state.clanError)}</p></div>`
            : '<div class="inspector-empty"><span class="empty-glyph">♘</span><strong>Select a clan</strong><p>Open a clan to inspect its bots, goal, warehouse, and operation history.</p></div>';
        return;
    }
    const clan = detail.clan;
    const goal = clanGoalSummary(clan.goal, clan);
    const members = detail.members || [];
    const warehouse = clan.warehouse || {};
    const operation = detail.operation;
    const events = (detail.events || []).slice(0, 8);
    const actionCount = Number(clan.actions?.pending || 0) + Number(clan.actions?.running || 0);
    els.clanDetail.innerHTML = `
        <div class="clan-detail-header">
            <div>
                <span class="section-kicker">${clan.autonomous ? 'Autonomous clan' : clan.playerManaged ? 'Player-managed clan' : 'Player clan'}</span>
                <h3>${clanCrestMarkup(clan, 'large')}${text(clan.name, 'Unnamed clan')}</h3>
                <p>Level ${number(clan.level, 0)} · leader ${text(clan.leaderName, 'Unknown')} · ${number(clan.memberCount)} members</p>
            </div>
            <div class="clan-detail-actions">
                ${clan.playerManaged ? `<button class="clan-manage-button${state.clanManagerOpen ? ' is-active' : ''}" type="button" data-clan-manage aria-expanded="${state.clanManagerOpen}">${uiIcon('settings')}Manage clan</button>` : ''}
                <span class="clan-level-badge">L${number(clan.level, 0)}</span>
            </div>
        </div>
        ${clanManagementMarkup(clan)}
        <div class="clan-metric-grid">
            <div><span>Members</span><strong>${number(clan.memberCount)}</strong><small>${number(clan.botMembers)} bots</small></div>
            <div><span>Average level</span><strong>${number(clan.averageLevel)}</strong><small>range ${number(clan.lowestLevel)}–${number(clan.highestLevel)}</small></div>
            <div><span>Warehouse</span><strong>${compactNumber(warehouse.adena)} A</strong><small>${number(warehouse.bloodMarks)} Blood Marks</small></div>
            <div><span>Operation</span><strong>${operation ? text(uiLabel('status', operation.status, 'Active')) : 'Idle'}</strong><small>${operation ? text(uiLabel('plan', operation.type, 'Operation')) : 'No active party'}</small></div>
        </div>
        <div class="clan-briefing">
            <section class="clan-goal-brief">
                <div class="clan-block-title"><span>${uiIcon('target')}Current goal</span><b>${text(goal.progress)}</b></div>
                <div class="clan-goal-primary">
                    ${goal.iconUrl ? `<span class="clan-goal-icon"><img src="${text(goal.iconUrl)}" alt="${text(goal.title)}" loading="lazy" decoding="async"></span>` : ''}
                    <div>
                        <strong class="clan-goal-title">${text(goal.title)}</strong>
                        <p>${text(goal.meta)}</p>
                    </div>
                </div>
                <div class="clan-goal-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${number(goal.percent)}"><i style="width:${number(goal.percent)}%"></i></div>
            </section>
            <div class="clan-briefing-facts">
                <div><span>Market demand</span><strong>${number(clan.market?.openDemands)} open</strong><small>${number(clan.market?.requestedUnits)} units requested</small></div>
                <div><span>Action queue</span><strong>${actionCount || 'Clear'}</strong><small>${number(clan.actions?.running)} running · ${number(clan.actions?.pending)} pending</small></div>
                <div><span>Progression</span><strong>${number(clan.contributions?.length || 0)} levels funded</strong><small>${(clan.contributions || []).length ? clan.contributions.map((entry) => `L${number(entry.targetLevel)} · ${compactNumber(entry.amount)} A`).join(' · ') : 'No ledger entries'}</small></div>
            </div>
        </div>
        <div class="clan-roster-layout">
            <section class="clan-members-section">
                <div class="clan-member-toolbar">
                    <strong>${uiIcon('users')}Members</strong>
                    <span>${number(members.length)} total · open a member on the map</span>
                </div>
                <div class="clan-member-list" role="list">
                    ${members.length ? members.map((member) => `
                        <button class="clan-member-row" type="button" data-clan-member-id="${escapeHtml(member.id)}" data-clan-member-kind="${escapeHtml(member.kind)}">
                            <span class="clan-member-main"><strong>${text(member.isLeader ? `♛ ${member.name}` : member.name)}</strong><span>${text(member.className, 'Unknown class')} · ${text(roleLabel(member.role || 'member'))} · Lv ${number(member.level, '?')}</span></span>
                            <span class="clan-member-state"><strong>${text(activityLabel(member.activity || member.phase), member.phase)}</strong><span>${text(member.region, 'Unknown location')}</span></span>
                        </button>
                    `).join('') : '<div class="list-empty">No clan members found.</div>'}
                </div>
            </section>
            <aside class="clan-events">
                <div class="clan-block-title"><span>${uiIcon('history')}Recent events</span><b>${number(events.length)} shown</b></div>
                ${events.length ? events.map((event) => `<div class="clan-event-row"><strong>${text(uiLabel('event', event.eventType, 'Clan update'))}</strong><span>${text(uiLabel('reason', event.reasonCode, null) || uiLabel('plan', event.plan, 'State update'))}</span><time>${text(formatTime(event.occurredAt))}</time></div>`).join('') : '<p>No clan events yet.</p>'}
            </aside>
        </div>
    `;
}

async function loadClanDetail(id, { updateRoute = true } = {}) {
    const clanId = Number(id);
    if (!clanId) return;
    const requestId = ++state.clanRequest;
    if (Number(state.selectedClanId) !== clanId) {
        resetClanCrestDraft();
        state.clanManagerOpen = false;
        state.clanCrestMessage = null;
    }
    state.selectedClanId = clanId;
    state.clanDetail = null;
    state.clanDetailSignature = null;
    state.clanDetailLoading = true;
    state.clanError = null;
    if (updateRoute) commitRoute({ name: 'clans', id: clanId });
    renderClans();
    revealSelectedClan();
    try {
        const response = await fetch(`/observer/api/clan/${encodeURIComponent(clanId)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const detail = await response.json();
        if (requestId !== state.clanRequest || Number(state.selectedClanId) !== clanId) return;
        state.clanDetail = detail;
        state.clanDetailSignature = clanOverviewSignature(clanItems().find((clan) => Number(clan.id) === clanId));
        if (state.clanOpen && detail.clan?.name) document.title = `${detail.clan.name} · Clans · World Observer`;
    } catch (error) {
        if (requestId === state.clanRequest) state.clanError = error.message;
    } finally {
        if (requestId === state.clanRequest) {
            state.clanDetailLoading = false;
            renderClans();
        }
    }
}

function clanCrestErrorMessage(code, fallback = 'Could not update the crest') {
    const messages = {
        invalid_clan: 'The selected clan is invalid',
        invalid_clan_crest: 'The generated crest is invalid',
        invalid_crest_pixels: 'The image could not be converted',
        level_too_low: 'Clan level 3 is required for a crest',
        target_not_player_managed: 'Only the player-managed clan can be edited'
    };
    return messages[code] || fallback;
}

async function decodeClanCrestImage(file) {
    if (window.createImageBitmap) {
        try {
            return await window.createImageBitmap(file);
        } catch (error) {
            // Fall through to the browser image decoder for formats such as BMP.
        }
    }
    return new Promise((resolve, reject) => {
        const sourceUrl = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(sourceUrl);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(sourceUrl);
            reject(new Error('Unsupported or damaged image'));
        };
        image.src = sourceUrl;
    });
}

async function loadClanCrestFile(file) {
    if (!file) return;
    const extensionAllowed = /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || '');
    if ((!String(file.type || '').startsWith('image/') && !extensionAllowed) || String(file.type || '').includes('svg')) {
        state.clanCrestMessage = { kind: 'error', text: 'Choose a PNG, JPEG, WebP, GIF or BMP image' };
        renderClanDetail();
        return;
    }
    if (file.size > 5 * 1024 * 1024) {
        state.clanCrestMessage = { kind: 'error', text: 'The image must be 5 MB or smaller' };
        renderClanDetail();
        return;
    }
    try {
        const source = await decodeClanCrestImage(file);
        const sourceWidth = Number(source.width || source.naturalWidth || 0);
        const sourceHeight = Number(source.height || source.naturalHeight || 0);
        if (!sourceWidth || !sourceHeight || sourceWidth > 8192 || sourceHeight > 8192 || sourceWidth * sourceHeight > 24000000) {
            source.close?.();
            throw new Error('Image dimensions are too large');
        }
        resetClanCrestDraft();
        state.clanCrestSource = source;
        buildClanCrestDraft(source, file.name || 'Image');
        state.clanCrestMessage = null;
    } catch (error) {
        state.clanCrestMessage = { kind: 'error', text: error.message || 'Could not read this image' };
    }
    renderClanDetail();
}

async function refreshManagedClan(clanId) {
    state.clanLastLoadedAt = 0;
    await loadClanDirectory({ force: true });
    await loadClanDetail(clanId, { updateRoute: false });
}

async function saveClanCrest() {
    const clanId = Number(state.clanDetail?.clan?.id || 0);
    if (!clanId || !state.clanCrestDraft || state.clanCrestSaving) return;
    state.clanCrestSaving = true;
    state.clanCrestMessage = null;
    renderClanDetail();
    try {
        const response = await fetch(`/observer/api/clan/${encodeURIComponent(clanId)}/crest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ width: 16, height: 12, pixels: state.clanCrestDraft.pixels })
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(clanCrestErrorMessage(result.code, result.error));
        resetClanCrestDraft();
        state.clanCrestMessage = { kind: 'success', text: 'Crest saved and sent to the game client' };
        await refreshManagedClan(clanId);
    } catch (error) {
        state.clanCrestSaving = false;
        state.clanCrestMessage = { kind: 'error', text: error.message || 'Could not save the crest' };
        renderClanDetail();
    }
}

async function removeClanCrest() {
    const clanId = Number(state.clanDetail?.clan?.id || 0);
    if (!clanId || state.clanCrestSaving || !window.confirm('Remove the clan crest? This cannot be undone.')) return;
    state.clanCrestSaving = true;
    state.clanCrestMessage = null;
    renderClanDetail();
    try {
        const response = await fetch(`/observer/api/clan/${encodeURIComponent(clanId)}/crest`, { method: 'DELETE' });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(clanCrestErrorMessage(result.code, result.error));
        resetClanCrestDraft();
        state.clanCrestMessage = { kind: 'success', text: 'Crest removed' };
        await refreshManagedClan(clanId);
    } catch (error) {
        state.clanCrestSaving = false;
        state.clanCrestMessage = { kind: 'error', text: error.message || 'Could not remove the crest' };
        renderClanDetail();
    }
}

async function loadClanDirectory({ force = false, selectFirst = false } = {}) {
    if (!force && !state.clanOpen && state.clanDirectory) return;
    if (!force && Date.now() - state.clanLastLoadedAt < 10000) return;
    try {
        const response = await fetch('/observer/api/clans', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const directory = await response.json();
        state.clanDirectory = directory;
        state.clanLastLoadedAt = Date.now();
        state.clanError = null;
        const selectedExists = clanItems().some((clan) => Number(clan.id) === Number(state.selectedClanId));
        if ((selectFirst || !selectedExists) && clanItems().length) state.selectedClanId = Number(clanItems()[0].id);
        renderClans();
        const detailClanId = Number(state.clanDetail?.clan?.id || 0);
        const selectedOverview = clanItems().find((clan) => Number(clan.id) === Number(state.selectedClanId));
        const selectedSignature = clanOverviewSignature(selectedOverview);
        const detailChanged = Boolean(state.clanDetail && selectedSignature !== state.clanDetailSignature);
        if (state.clanOpen && state.selectedClanId && (selectFirst || detailClanId !== Number(state.selectedClanId) || detailChanged)) {
            loadClanDetail(state.selectedClanId, { updateRoute: false });
        }
    } catch (error) {
        state.clanError = error.message;
        renderClans();
    }
}

function openClans(clanId = null, { updateRoute = true } = {}) {
    if (state.rankingOpen) closeRankings({ updateRoute: false });
    if (state.raidBossOpen) closeRaidBosses({ updateRoute: false });
    const requestedClanId = Number(clanId) || null;
    if (requestedClanId) {
        state.selectedClanId = requestedClanId;
        state.clanSearch = '';
        state.clanDetail = null;
        state.clanDetailSignature = null;
        state.clanError = null;
        if (els.clanSearch) els.clanSearch.value = '';
    }
    state.clanOpen = true;
    state.clanFocusReturn = document.activeElement;
    els.clansModal.hidden = false;
    els.observerShell?.setAttribute('aria-hidden', 'true');
    if (els.observerShell) els.observerShell.inert = true;
    document.body.classList.add('rankings-open');
    document.title = 'Clans · World Observer';
    renderClans();
    loadClanDirectory({ force: true, selectFirst: !requestedClanId });
    requestAnimationFrame(() => els.closeClans.focus());
    if (updateRoute) commitRoute({ name: 'clans', id: requestedClanId });
}

function closeClans({ updateRoute = true } = {}) {
    if (!state.clanOpen) return;
    state.clanOpen = false;
    els.clansModal.hidden = true;
    els.observerShell?.removeAttribute('aria-hidden');
    if (els.observerShell) els.observerShell.inert = false;
    if (!state.rankingOpen && !state.raidBossOpen) document.body.classList.remove('rankings-open');
    document.title = 'World Observer';
    state.clanFocusReturn?.focus?.();
    state.clanFocusReturn = null;
    state.clanManagerOpen = false;
    state.clanCrestMessage = null;
    resetClanCrestDraft();
    if (updateRoute) commitRoute({ name: 'world' });
}

function eligibleActors() {
    return actors().filter(ActorFilters.isEligible);
}

function actorSearchText(actor) {
    return [
        actor.name,
        actor.phase,
        phaseLabel(actor.phase),
        actor.mode,
        actor.intent,
        displayActivity(actor),
        actor.role,
        roleLabel(actor.role),
        actorClassName(actor),
        actor.build?.classFamily,
        actor.region,
        actor.area?.name,
        actor.area?.parentRegion,
        actor.home?.region,
        actor.spot?.name,
        actor.classId
    ].filter(Boolean).join(' ').toLowerCase();
}

function isVisible(actor) {
    if (state.phase !== 'all' && state.phase !== 'players' && actor.phase !== state.phase) return false;
    if (state.phase === 'players' && actor.kind !== 'player') return false;
    if (state.search && !actorSearchText(actor).includes(state.search)) return false;
    return ActorFilters.matches(actor, state);
}

function filteredActors() {
    const scope = state.clusterScope?.actorKeys;
    return eligibleActors().filter((actor) => (!scope || scope.has(actorKey(actor))) && isVisible(actor));
}

function actorKey(actor) {
    return `${actor.kind || 'bot'}:${actor.id}`;
}

function mapActorSignature(actor) {
    if (!actor) return null;
    const loc = mapLocation(actor);
    return JSON.stringify([
        actorKey(actor),
        Number(loc?.locX || 0),
        Number(loc?.locY || 0),
        Number(loc?.locZ || 0),
        actor.phase,
        phaseColor(actor),
        actorSearchText(actor),
        Number(actor.level || 0),
        ActorFilters.classKey(actor),
        ActorFilters.isEligible(actor),
        ActorFilters.isSurfaceActor(actor)
    ]);
}

function isSurfaceActor(actor) {
    return ActorFilters.isSurfaceActor(actor);
}

function mapLocation(actor) {
    return ActorFilters.mapLocation(actor);
}

function renderGrid() {
    const tiles = mapMeta();
    els.gridLines.innerHTML = '';
    for (let x = 0; x <= tiles.width; x += tiles.blockPx) {
        els.gridLines.appendChild(svgEl('line', { x1: x, x2: x, y1: 0, y2: tiles.height }));
    }
    for (let y = 0; y <= tiles.height; y += tiles.blockPx) {
        els.gridLines.appendChild(svgEl('line', { x1: 0, x2: tiles.width, y1: y, y2: y }));
    }
}

function renderTiles() {
    const tiles = mapMeta();
    const hiddenKey = JSON.stringify(tiles.hiddenRanges || []);
    const missingTiles = new Set(tiles.missingTiles || []);
    const missingKey = JSON.stringify(tiles.missingTiles || []);
    const tileKey = `${tiles.rawBaseUrl}|${tiles.x.min}-${tiles.x.max}|${tiles.y.min}-${tiles.y.max}|${tiles.blockPx}|${hiddenKey}|${missingKey}`;
    if (state.renderedTileKey === tileKey) return;

    els.tileLayer.innerHTML = '';
    for (let x = tiles.x.min; x <= tiles.x.max; x += 1) {
        for (let y = tiles.y.min; y <= tiles.y.max; y += 1) {
            const hidden = (tiles.hiddenRanges || []).some((range) => (
                x >= range.x1 && x <= range.x2 && y >= range.y1 && y <= range.y2
            ));
            if (hidden || missingTiles.has(`${x}_${y}`)) continue;

            els.tileLayer.appendChild(svgEl('image', {
                href: `${tiles.rawBaseUrl}/${x}_${y}.jpg`,
                x: (x - tiles.x.min) * tiles.blockPx,
                y: (y - tiles.y.min) * tiles.blockPx,
                width: tiles.blockPx,
                height: tiles.blockPx,
                preserveAspectRatio: 'none'
            }));
        }
    }
    state.renderedTileKey = tileKey;
}

function renderLabels() {
    const snap = state.snapshot;
    els.regionLabels.innerHTML = '';
    if (!snap) return;

    const viewportWidth = state.viewport?.width || mapMeta().width;
    const showLabels = viewportWidth < 7600;
    const labelSize = clamp(viewportWidth / 55, 44, 135);
    snap.labels.forEach((label) => {
        const point = project(label);
        els.regionLabels.appendChild(svgEl('circle', {
            cx: point.x,
            cy: point.y,
            r: label.kind === 'town' ? 48 : 36
        }));
        if (!showLabels) return;
        const labelText = svgEl('text', { x: point.x + 85, y: point.y - 70, style: `font-size:${labelSize}px` });
        labelText.textContent = label.name;
        els.regionLabels.appendChild(labelText);
    });
}

function clusterCellSize() {
    return screenUnits(58);
}

function screenUnits(pixels) {
    return pixels / mapViewportMetrics().scale;
}

function pointHitElement(screenSize = 30) {
    const size = screenUnits(screenSize);
    return svgEl('rect', {
        class: 'point-hit',
        x: -size / 2,
        y: -size / 2,
        width: size,
        height: size,
        fill: 'transparent'
    });
}

function clusterActors(items) {
    const projected = items.map((actor) => {
        const loc = mapLocation(actor);
        return loc ? { actor, point: project(loc) } : null;
    }).filter(Boolean);
    const groups = MapClusters.clusterProjected(projected, {
        cellSize: clusterCellSize(),
        viewport: state.viewport,
        margin: screenUnits(72)
    });

    return groups.map((group) => ({
        members: group.members,
        point: group.point,
        size: group.size,
        color: clusterColor(group.members),
        selected: group.members.some(({ actor }) => String(actor.id) === String(state.selectedId?.id))
    }));
}

function clusterColor(cluster) {
    if (cluster.some(({ actor }) => actor.isPk)) return COLORS.pk;
    const colors = new Set(cluster.map(({ actor }) => phaseColor(actor)));
    return colors.size === 1 ? colors.values().next().value : COLORS.mixed;
}

function actorLabel(actor) {
    return `${actor.isPk ? 'PK ' : ''}${actor.name} · Lv ${actor.level} · ${actorClassName(actor)} · ${displayActivity(actor)}`;
}

function addPointHandlers(group, handler) {
    group.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
    });
    group.addEventListener('pointerup', (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
    });
    group.addEventListener('click', (event) => {
        event.stopPropagation();
        handler();
    });
    group.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        handler();
    });
}

function renderSinglePoint(cluster) {
    const actor = cluster.members[0].actor;
    const point = cluster.point;
    const color = phaseColor(actor);
    const radius = screenUnits(actor.kind === 'player' ? 7.5 : actor.phase === 'hot' ? 7 : 5.5);
    const selected = String(actor.id) === String(state.selectedId?.id);
    const group = svgEl('g', {
        class: `point${selected ? ' is-selected' : ''}`,
        transform: `translate(${point.x}, ${point.y})`,
        tabindex: 0,
        role: 'button',
        'aria-label': actorLabel(actor)
    });
    addPointHandlers(group, () => selectActor(actor.id, actor.kind));
    group.appendChild(pointHitElement(30));
    group.appendChild(svgEl('circle', { class: 'point-ring', r: radius + screenUnits(3.5), stroke: color, 'vector-effect': 'non-scaling-stroke' }));
    group.appendChild(svgEl('circle', { class: 'point-core', r: radius, fill: color, 'vector-effect': 'non-scaling-stroke' }));

    const showName = actor.kind === 'player' || actor.phase === 'hot' || (state.viewport?.width || 99999) < 4200;
    if (showName) {
        const label = svgEl('text', {
            class: 'point-label',
            x: radius + screenUnits(7),
            y: screenUnits(3),
            style: `font-size:${screenUnits(11)}px;stroke-width:${screenUnits(3)}px`
        });
        label.textContent = actor.name;
        group.appendChild(label);
    }
    els.pointsLayer.appendChild(group);
}

function renderCluster(cluster) {
    const radiusPx = clamp(12 + (Math.log2(cluster.size) * 1.05), 14, 21);
    const radius = screenUnits(radiusPx);
    const selected = cluster.selected;
    const first = cluster.members[0].actor;
    const group = svgEl('g', {
        class: `point cluster-point${selected ? ' is-selected' : ''}`,
        transform: `translate(${cluster.point.x}, ${cluster.point.y})`,
        tabindex: 0,
        role: 'button',
        'aria-label': `${cluster.size} actors near ${clusterLocation(cluster)}`
    });
    addPointHandlers(group, () => focusCluster(cluster));
    group.appendChild(pointHitElement(Math.max(36, radiusPx * 2 + 8)));
    group.appendChild(svgEl('circle', { class: 'cluster-ring', r: radius + screenUnits(3), stroke: cluster.color, 'vector-effect': 'non-scaling-stroke' }));
    group.appendChild(svgEl('circle', { class: 'cluster-core', r: radius, fill: cluster.color, 'vector-effect': 'non-scaling-stroke' }));
    const count = svgEl('text', {
        class: 'cluster-count',
        x: 0,
        y: screenUnits(4.5),
        'text-anchor': 'middle',
        style: `font-size:${screenUnits(clamp(10.5 + Math.log2(cluster.size) * 0.38, 11, 13.5))}px`
    });
    count.textContent = cluster.size.toLocaleString();
    group.appendChild(count);
    const phaseCounts = Object.entries(cluster.members.reduce((counts, { actor }) => {
        const key = actor.kind === 'player' ? 'players' : actor.phase;
        counts[key] = (counts[key] || 0) + 1;
        return counts;
    }, {})).sort((a, b) => b[1] - a[1]).slice(0, 2);
    if (phaseCounts.length > 1) {
        const breakdown = svgEl('text', {
            class: 'cluster-breakdown',
            x: 0,
            y: radius + screenUnits(13),
            'text-anchor': 'middle',
            style: `font-size:${screenUnits(9)}px;stroke-width:${screenUnits(2.2)}px`
        });
        breakdown.textContent = phaseCounts.map(([key, count]) => `${phaseLabel(key)} ${count}`).join(' · ');
        group.appendChild(breakdown);
    }
    els.pointsLayer.appendChild(group);
}

function renderPoints() {
    els.pointsLayer.innerHTML = '';
    if (!state.snapshot) {
        renderRaidBossPoints();
        return;
    }

    const visible = filteredActors().filter(isSurfaceActor);
    const clusters = clusterActors(visible);
    clusters.forEach((cluster) => cluster.size === 1 ? renderSinglePoint(cluster) : renderCluster(cluster));
    renderRaidBossPoints();
}

function renderRaidBossPoints() {
    if (!els.raidBossLayer) return;
    els.raidBossLayer.innerHTML = '';
    if (state.phase !== 'raidbosses' && !state.selectedRaidBossId) return;
    const viewportWidth = state.viewport?.width || 99999;
    const bosses = raidBossItems()
        .filter((boss) => boss.status === 'alive' && boss.loc && (
            state.phase === 'raidbosses' || String(boss.id) === String(state.selectedRaidBossId)
        ));
    const clusters = state.phase === 'raidbosses'
        ? MapClusters.clusterProjected(bosses.map((boss) => ({ boss, point: project(boss.loc) })), {
            cellSize: screenUnits(48),
            viewport: state.viewport,
            margin: screenUnits(64)
        })
        : bosses.map((boss) => ({ members: [{ boss, point: project(boss.loc) }], point: project(boss.loc), size: 1 }));

    clusters.forEach((cluster) => {
        if (cluster.size > 1) {
            renderRaidBossCluster(cluster);
            return;
        }
        const boss = cluster.members[0].boss;
        const point = cluster.point;
        const selected = String(boss.id) === String(state.selectedRaidBossId);
        const radius = screenUnits(9);
        const group = svgEl('g', {
            class: `raid-boss-point${selected ? ' is-selected' : ''}`,
            transform: `translate(${point.x}, ${point.y})`,
            tabindex: 0,
            role: 'button',
            'aria-label': `${boss.name}, level ${boss.level}, ${boss.location?.name || 'unknown location'}`
        });
        addPointHandlers(group, () => focusRaidBoss(boss.id));
        group.appendChild(pointHitElement(34));
        group.appendChild(svgEl('circle', { class: 'raid-boss-ring', r: radius + screenUnits(4), 'vector-effect': 'non-scaling-stroke' }));
        group.appendChild(svgEl('path', {
            class: 'raid-boss-core',
            d: `M 0 ${-radius} L ${radius} 0 L 0 ${radius} L ${-radius} 0 Z`,
            'vector-effect': 'non-scaling-stroke'
        }));
        if (selected || viewportWidth < 4200) {
            const label = svgEl('text', {
                class: 'raid-boss-label',
                x: radius + screenUnits(8),
                y: screenUnits(4),
                style: `font-size:${screenUnits(11)}px`
            });
            label.textContent = boss.name;
            group.appendChild(label);
        }
        els.raidBossLayer.appendChild(group);
    });
}

function raidBossClusterLocation(cluster) {
    const labels = cluster.members.map(({ boss }) => boss.location?.name).filter(Boolean);
    if (!labels.length) return 'this area';
    const counts = labels.reduce((result, label) => result.set(label, (result.get(label) || 0) + 1), new Map());
    return [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0];
}

function renderRaidBossCluster(cluster) {
    const radiusPx = clamp(12 + Math.log2(cluster.size) * 1.2, 15, 21);
    const radius = screenUnits(radiusPx);
    const group = svgEl('g', {
        class: 'raid-boss-cluster',
        transform: `translate(${cluster.point.x}, ${cluster.point.y})`,
        tabindex: 0,
        role: 'button',
        'aria-label': `${cluster.size} raid bosses near ${raidBossClusterLocation(cluster)}`
    });
    addPointHandlers(group, () => focusMapPoints(cluster.members.map(({ point }) => point), 38));
    group.appendChild(pointHitElement(Math.max(36, radiusPx * 2 + 8)));
    group.appendChild(svgEl('circle', { class: 'raid-boss-cluster-ring', r: radius + screenUnits(3), 'vector-effect': 'non-scaling-stroke' }));
    group.appendChild(svgEl('circle', { class: 'raid-boss-cluster-core', r: radius, 'vector-effect': 'non-scaling-stroke' }));
    const count = svgEl('text', {
        class: 'raid-boss-cluster-count',
        x: 0,
        y: screenUnits(4),
        'text-anchor': 'middle',
        style: `font-size:${screenUnits(12)}px`
    });
    count.textContent = cluster.size.toLocaleString();
    group.appendChild(count);
    els.raidBossLayer.appendChild(group);
}

function focusRaidBoss(id) {
    const boss = raidBossItems().find((item) => String(item.id) === String(id));
    if (!boss || boss.status !== 'alive' || !boss.loc) return;
    state.selectedRaidBossId = boss.id;
    state.selectedId = null;
    state.clusterScope = null;
    state.detail = null;
    state.detailRequest += 1;
    closeRaidBosses({ updateRoute: false });
    const viewport = state.viewport || { x: 0, y: 0, width: mapMeta().width, height: mapMeta().height };
    const point = worldToMap(boss.loc);
    applyViewport({
        x: point.x - viewport.width * 0.5,
        y: point.y - viewport.height * 0.5,
        width: viewport.width,
        height: viewport.height
    });
    renderRaidBossPoints();
    renderRoster();
    renderSelected();
    commitRoute({ name: 'raid-bosses', id: boss.id });
}

function focusMapPoints(points, paddingPixels = 44) {
    if (!points.length) return;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const pad = screenUnits(paddingPixels);
    const rect = els.worldMap.getBoundingClientRect();
    const aspect = Math.max(1, rect.width / Math.max(1, rect.height));
    let width = Math.max(240, Math.max(...xs) - Math.min(...xs) + pad * 2);
    let height = Math.max(170, Math.max(...ys) - Math.min(...ys) + pad * 2);
    if (width / height < aspect) width = height * aspect;
    else height = width / aspect;
    applyViewport({
        x: ((Math.min(...xs) + Math.max(...xs)) / 2) - width / 2,
        y: ((Math.min(...ys) + Math.max(...ys)) / 2) - height / 2,
        width,
        height
    });
}

function renderFilterCounts() {
    const items = eligibleActors().filter((actor) => (
        (!state.search || actorSearchText(actor).includes(state.search))
        && ActorFilters.matches(actor, state)
    ));
    const counts = {
        all: items.length,
        hot: items.filter((actor) => actor.phase === 'hot').length,
        warm: items.filter((actor) => actor.phase === 'warm').length,
        cold: items.filter((actor) => actor.phase === 'cold').length,
        players: items.filter((actor) => actor.kind === 'player').length,
        raidbosses: Number(state.snapshot?.raidBosses?.counts?.alive || 0)
    };
    Object.entries(counts).forEach(([key, value]) => {
        const count = els.filterStrip.querySelector(`[data-count-for="${key}"]`);
        if (count) count.textContent = value.toLocaleString();
    });
}

function renderClassFilter() {
    const options = ActorFilters.classOptions(eligibleActors(), state.snapshot?.classes || []);
    const signature = options.map((option) => `${option.key}:${option.label}`).join('|');
    if (signature === state.classOptionsSignature) return;
    state.classOptionsSignature = signature;

    if (state.classKey !== 'all' && !options.some((option) => option.key === state.classKey)) {
        state.classKey = 'all';
    }
    els.classFilter.innerHTML = [
        '<option value="all">All classes</option>',
        ...options.map((option) => `<option value="${escapeHtml(option.key)}">${text(option.label)}</option>`)
    ].join('');
    els.classFilter.value = state.classKey;
    renderActorFilterState();
}

function renderActorFilterState() {
    const active = state.minLevel !== null || state.maxLevel !== null || state.classKey !== 'all';
    els.clearActorFilters.hidden = !active;
}

function renderFilteredActorViews({ counts = true } = {}) {
    if (counts) renderFilterCounts();
    if (state.fit) {
        setSvgViewBox();
        renderLabels();
    }
    renderPoints();
    renderRoster();
    renderActorFilterState();
}

function updateLevelFilter(changed) {
    state.minLevel = ActorFilters.normalizeLevel(els.minLevelFilter.value);
    state.maxLevel = ActorFilters.normalizeLevel(els.maxLevelFilter.value);
    if (state.minLevel !== null && state.maxLevel !== null && state.minLevel > state.maxLevel) {
        if (changed === 'min') {
            state.maxLevel = state.minLevel;
            els.maxLevelFilter.value = state.maxLevel;
        } else {
            state.minLevel = state.maxLevel;
            els.minLevelFilter.value = state.minLevel;
        }
    }
    renderFilteredActorViews();
}

function renderPopulation() {
    const snap = state.snapshot;
    const population = snap.population || {};
    const total = Number(population.total || snap.bots.length || 0);
    els.botsTotal.textContent = total.toLocaleString();
    els.playersTotal.textContent = (snap.players?.length || 0).toLocaleString();
    els.populationSubline.textContent = `${number(population.hot || 0)} active on field · ${number(population.persisted || total)} persisted · ${number(population.parties || 0)} background parties`;
    els.lastRefresh.textContent = formatTime(snap.generatedAt);

    const phaseTotal = Math.max(1, Number(population.hot || 0) + Number(population.warm || 0) + Number(population.cold || 0));
    els.phaseBars.innerHTML = ['hot', 'warm', 'cold'].map((phase) => {
        const count = Number(population[phase] || 0);
        const width = Math.max(count ? 2 : 0, (count / phaseTotal) * 100);
        return `<div class="population-bar-row">
            <span class="phase-label"><i class="legend-dot ${phase}"></i>${phaseLabel(phase)}</span>
            <div class="population-track"><div class="population-fill ${phase}" style="width:${width}%"></div></div>
            <strong>${count.toLocaleString()}</strong>
        </div>`;
    }).join('');
}

function renderMarket() {
    const market = state.snapshot?.population?.marketState || {};
    const dynamic = market.dynamic || {};
    const fixed = market.fixed || {};
    const activity = market.activity || {};
    const transactions = market.transactions || {};
    const trades = Number(activity.peerPurchases ?? activity.purchases ?? 0) + Number(activity.dynamicBuyerSales || 0);
    const tradedAdena = Number(activity.peerPurchaseAdena ?? activity.adenaTraded ?? 0) + Number(activity.dynamicBuyerAdena || 0);

    els.marketWts.textContent = compactNumber(dynamic.wts);
    els.marketWtb.textContent = compactNumber(dynamic.wtb);
    els.marketTrades.textContent = compactNumber(trades);
    els.marketAdena.textContent = compactNumber(tradedAdena);
    els.marketScope.textContent = `${number(fixed.wts || 0)} sell · ${number(fixed.wtb || 0)} buy stores`;

    const towns = Object.entries(market.byTown || {}).map(([name, town]) => ({ name, ...town }))
        .filter((town) => Number(town.dynamicWts || 0) + Number(town.dynamicWtb || 0) > 0)
        .sort((left, right) => (
            Number(right.dynamicWts || 0) + Number(right.dynamicWtb || 0)
            - Number(left.dynamicWts || 0) - Number(left.dynamicWtb || 0)
            || String(left.name).localeCompare(String(right.name))
        )).slice(0, 4);
    els.marketTowns.innerHTML = towns.length ? towns.map((town) => {
        const tradeTown = transactions.byPeerTown?.[town.name] || {};
        return `
        <div class="market-town-row" title="${text(`${town.fixedWts || 0} fixed WTS · ${town.fixedWtb || 0} fixed WTB · ${number(tradeTown.adena || 0)} peer Adena`)}">
            <strong>${text(town.name)}</strong>
            <span><b>${number(town.dynamicWts || 0)}</b> WTS</span>
            <span><b>${number(town.dynamicWtb || 0)}</b> WTB</span>
            <span><b>${number(tradeTown.trades || 0)}</b> trades</span>
        </div>
    `;
    }).join('') : '<div class="list-empty">No bot stores open.</div>';

    const top = (market.topItems || [])[0];
    const demand = top?.demand || {};
    els.marketTopItem.innerHTML = top
        ? `Most active <strong>${text(top.name)}</strong> · ${number(top.wtsUnits || 0)} listed · ${number(top.wtbUnits || 0)} wanted · ${number(demand.fundedUnits || 0)} funded · ${number(demand.bots || 0)} planned`
        : 'No active listings yet';

    const recent = (transactions.recentPeerTrades || []).slice(0, 3);
    els.marketRecentTrades.innerHTML = recent.length ? recent.map((trade) => {
        const side = trade.channel === 'wtb' ? 'WTB' : 'WTS';
        const counterparty = trade.channel === 'wtb' ? trade.buyer?.name : trade.seller?.name;
        const action = trade.channel === 'wtb' ? 'sold to' : 'bought from';
        const at = Number(trade.at || 0) > 0
            ? new Date(Number(trade.at)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '—';
        return `<div class="market-trade-row" title="${text(`${trade.seller?.name || 'Unknown seller'} → ${trade.buyer?.name || 'Unknown buyer'} · ${number(trade.adena || 0)} Adena`)}">
            <b>${side}</b>
            <strong>${text(`${trade.itemName || `Item ${trade.selfId}`} x${number(trade.quantity || 0)} ${action} ${counterparty || 'bot'}`)}</strong>
            <time>${text(at)}</time>
        </div>`;
    }).join('') : '<div class="list-empty">No trades yet.</div>';

    const topTrade = (transactions.byPeerItem || [])[0];
    const peerTrades = Number(topTrade?.channels?.wts?.trades || 0) + Number(topTrade?.channels?.wtb?.trades || 0);
    els.marketTradeTop.innerHTML = topTrade
        ? `Top traded <strong>${text(topTrade.name)}</strong> · ${number(peerTrades)} deals / ${compactNumber(topTrade.adena || 0)} Adena`
        : 'No completed trades yet';
}

function displayActivity(actor) {
    if (actor.kind === 'player') return actor.online ? 'Online' : 'Offline';
    return activityLabel(actor.intent || actor.mode || 'idle');
}

function renderRoster() {
    if (state.phase === 'raidbosses') {
        const alive = Number(state.snapshot?.raidBosses?.counts?.alive || 0);
        els.visibleCount.textContent = `${number(alive)} shown`;
        els.actorList.innerHTML = '<div class="list-empty">Raid bosses are shown on the map. Open the Raid bosses panel for full status.</div>';
        return;
    }
    const phaseRank = { hot: 0, warm: 1, cold: 2, player: 3 };
    const roster = filteredActors()
        .sort((a, b) => (phaseRank[a.phase] ?? 9) - (phaseRank[b.phase] ?? 9) || Number(b.level || 0) - Number(a.level || 0) || String(a.name).localeCompare(String(b.name)));
    const list = roster.slice(0, 90);
    els.visibleCount.textContent = list.length < roster.length
        ? `${list.length.toLocaleString()} of ${roster.length.toLocaleString()} listed`
        : `${roster.length.toLocaleString()} listed`;
    els.actorList.innerHTML = list.length ? list.map((actor) => `
        <button class="actor-row${String(actor.id) === String(state.selectedId?.id) ? ' is-selected' : ''}" type="button" data-roster-id="${escapeHtml(actor.id)}" data-roster-kind="${actor.kind}">
            <span class="phase-dot" style="background:${phaseColor(actor)}"></span>
            <span class="actor-main">
                <strong>${text(actor.isPk ? `PK ${actor.name}` : actor.name)}</strong>
                <span>${text(actor.kind === 'player' ? actorClassName(actor) : `${phaseLabel(actor.phase)} · ${actorClassName(actor)} · ${roleLabel(actor.role || 'dps')} · ${displayActivity(actor)}`)} · Lv ${number(actor.level, '?')}</span>
            </span>
            <span class="actor-loc">${text(readablePlace(actor.region || actor.home?.region || actor.spot?.name, ''))}</span>
        </button>
    `).join('') : '<div class="list-empty">No actors match this view.</div>';
}

function actorById(id, kind) {
    if (!state.snapshot) return null;
    return kind === 'player'
        ? state.snapshot.players.find((player) => String(player.id) === String(id))
        : state.snapshot.bots.find((bot) => String(bot.id) === String(id));
}

function selectedActor() {
    if (!state.selectedId) return null;
    return state.detail || actorById(state.selectedId.id, state.selectedId.kind);
}

function reconcileSelectedActor() {
    if (!state.selectedId || !state.snapshot) return;

    const id = String(state.selectedId.id);
    const player = state.snapshot.players.find((actor) => String(actor.id) === id);
    const bot = state.snapshot.bots.find((actor) => String(actor.id) === id);
    const actor = player || bot;
    if (!actor) {
        state.selectedId = null;
        state.detail = null;
        state.detailError = null;
        state.detailLoading = false;
        state.detailRequest += 1;
        return;
    }

    const kind = player ? 'player' : 'bot';
    if (state.selectedId.kind === kind) return;

    // A live character can move between the bot and player collections.
    // Never let an old bot detail shadow the authoritative player snapshot.
    state.selectedId = { id: actor.id, kind };
    state.detail = null;
    state.detailError = null;
    state.detailLoading = false;
    state.detailRequest += 1;
}

const BUILD_LABELS = Object.freeze({
    armor: {
        heavy: 'Heavy',
        light: 'Light',
        robe: 'Robe'
    },
    weapon: {
        one_handed_sword_or_blunt: 'One-handed sword or blunt',
        one_handed_blunt: 'One-handed blunt',
        caster_blunt_or_sword: 'Caster blunt or sword',
        caster_weapon: 'Caster weapon',
        bow: 'Bow',
        dagger: 'Dagger'
    },
    grade: {
        none: 'No-grade',
        d: 'D-grade',
        c: 'C-grade',
        b: 'B-grade',
        a: 'A-grade',
        s: 'S-grade'
    },
    playstyle: {
        simple_solo: 'Simple solo',
        solo_or_duo_grind: 'Solo or duo grind',
        safe_solo: 'Safe solo',
        support_learner: 'Support learner'
    }
});

const PRIORITY_LABELS = Object.freeze({
    pAtk: 'Physical attack',
    pDef: 'Physical defense',
    mAtk: 'Magic attack',
    mDef: 'Magic defense',
    crit: 'Critical chance',
    range: 'Range control',
    evasion: 'Evasion',
    hp: 'Max HP',
    maxMp: 'Max MP',
    cast_speed: 'Cast speed',
    shot_efficiency: 'Soulshot efficiency',
    spiritshot_efficiency: 'Spiritshot efficiency',
    shield_defense: 'Shield defense',
    aggro_control: 'Aggro control',
    backstab_windows: 'Backstab positioning',
    spoil_value: 'Spoil value',
    carry_weight: 'Carry capacity',
    craft_materials: 'Crafting materials',
    mp_conservation: 'MP conservation',
    buff_uptime: 'Buff uptime'
});

function humanizeToken(value) {
    return UiLanguage.humanize(value, '');
}

function readableToken(value) {
    return UiLanguage.humanize(value, '—');
}

function uiLabel(group, value, fallback = '—') {
    return UiLanguage.label(group, value, fallback);
}

function uiIcon(name, className = '') {
    return `<svg class="ui-icon${className ? ` ${escapeHtml(className)}` : ''}" aria-hidden="true"><use href="/observer/ui-icons.svg#${escapeHtml(name)}"></use></svg>`;
}

function phaseLabel(value) {
    return PHASE_LABELS[value] || readableToken(value);
}

function roleLabel(value) {
    return ROLE_LABELS[value] || readableToken(value);
}

function activityLabel(value) {
    return ACTIVITY_LABELS[value] || readableToken(value || 'idle');
}

function actorClassName(actor) {
    return ActorFilters.className(actor, state.snapshot?.classes || [])
        || (actor.build?.classFamily ? humanizeToken(actor.build.classFamily) : null)
        || (actor.kind === 'player' ? 'Player' : 'Unknown class');
}

function readablePlace(value, fallback = '—') {
    if (!value || /^-?\d+_-?\d+$/.test(String(value))) return fallback;
    return readableToken(value);
}

function readableBuildValue(value, kind = '') {
    if (value === null || value === undefined || value === '') return '—';
    return BUILD_LABELS[kind]?.[value] || humanizeToken(value);
}

function readablePriority(value) {
    return PRIORITY_LABELS[value] || humanizeToken(value);
}

function partyLeaderLink(actor) {
    const party = actor.party;
    if (!party) return 'Solo';

    const leader = party.leader && typeof party.leader === 'object'
        ? party.leader
        : { name: party.leader || party.leaderName || null };
    const leaderId = Number(party.leaderId || leader.id || 0) || null;
    const leaderName = leader.name || (leaderId ? `#${leaderId}` : 'Unknown');
    const leaderKind = ActorFilters.actorKind(leaderId, leader.kind, state.snapshot);
    const leaderValue = leaderId
        ? `<a class="inspector-link" href="#${escapeHtml(leaderKind)}-${escapeHtml(leaderId)}" data-party-leader-id="${escapeHtml(leaderId)}" data-party-leader-kind="${escapeHtml(leaderKind)}">${text(leaderName)}</a>`
        : text(leaderName);
    return `${text(roleLabel(party.role || actor.role || 'member'))} · leader ${leaderValue}`;
}

function actorClanLink(actor) {
    const clanId = Number(actor.clan?.id || 0);
    if (!clanId) return '—';
    const clanName = actor.clan?.name || `Clan #${clanId}`;
    return `<a class="inspector-link" href="#clan-${escapeHtml(clanId)}" data-actor-clan-id="${escapeHtml(clanId)}">${text(clanName)}</a>`;
}

function statCell(label, value) {
    return `<div class="stat-cell"><span>${text(label)}</span><strong>${number(value)}</strong></div>`;
}

function renderProgress(actor) {
    const stats = [
        actor.exp !== undefined ? ['EXP', actor.exp] : null,
        actor.sp !== undefined ? ['SP', actor.sp] : null,
        actor.adena !== undefined ? ['Adena', actor.adena] : null,
        actor.equipmentValue !== undefined ? ['Gear value', actor.equipmentValue] : null,
        actor.counters ? ['Wins', actor.counters.fightsWon ?? 0] : null,
        actor.counters ? ['Resolves', actor.counters.fightsResolved ?? 0] : null,
        actor.counters ? ['Deaths', actor.counters.deaths ?? 0] : null,
        actor.pvp !== undefined ? ['PvP', actor.pvp] : null,
        actor.pk !== undefined ? ['PK', actor.pk] : null,
        actor.karma !== undefined ? ['Karma', actor.karma] : null
    ].filter(Boolean);
    if (!stats.length) return '';
    return `<section class="inspector-block compact-block">
        <div class="inspector-block-title"><h3>Progress & wealth</h3><span>${text(Leaderboards.raceName(actor) || formatRelative(actor.updatedAt))}</span></div>
        <div class="combat-stats">${stats.map(([label, value]) => statCell(label, value)).join('')}</div>
    </section>`;
}

function vitalBar(label, vital, color) {
    const pct = clamp(Number(vital?.[`${label.toLowerCase()}Pct`] || 0), 0, 100);
    return `<div class="vital-row"><span>${label}</span><div class="vital-track"><div class="vital-fill" style="width:${pct}%;background:${color}"></div></div><strong>${pct}%</strong></div>`;
}

const PAPERDOLL_SLOTS = Object.freeze([
    { key: 'earring-left', label: 'Left earring', short: 'ER', slotIds: [1], edge: 'left' },
    { key: 'head', label: 'Head', short: 'HD', slotIds: [6] },
    { key: 'necklace', label: 'Necklace', short: 'NK', slotIds: [3], edge: 'right' },
    { key: 'ring-left', label: 'Left ring', short: 'RG', slotIds: [4], edge: 'left' },
    { key: 'chest', label: 'Chest / full armor', short: 'CH', slotIds: [10, 15] },
    { key: 'weapon', label: 'Weapon', short: 'WP', slotIds: [7, 14], edge: 'left' },
    { key: 'shield', label: 'Shield', short: 'SH', slotIds: [8], edge: 'right' },
    { key: 'gloves', label: 'Gloves', short: 'GL', slotIds: [9], edge: 'left' },
    { key: 'legs', label: 'Legs', short: 'LG', slotIds: [11] },
    { key: 'cloak', label: 'Cloak', short: 'CL', slotIds: [13], edge: 'right' },
    { key: 'feet', label: 'Feet', short: 'FT', slotIds: [12] },
    { key: 'ring-right', label: 'Right ring', short: 'RG', slotIds: [5], edge: 'right' },
    { key: 'earring-right', label: 'Right earring', short: 'ER', slotIds: [2], edge: 'right' }
]);

function paperdollItem(items, slotIds, used) {
    const item = items.find((candidate) => {
        const slotId = Number(candidate.slotId || 0);
        return slotIds.includes(slotId) && !used.has(candidate);
    });
    if (item) used.add(item);
    return item || null;
}

function itemStatRows(item) {
    const stats = item?.stats || {};
    return [
        ['P. Atk', stats.pAtk],
        ['P. Atk var.', stats.pAtkRnd],
        ['M. Atk', stats.mAtk],
        ['Atk. Spd', stats.atkSpd],
        ['P. Def', stats.pDef],
        ['M. Def', stats.mDef],
        ['Critical', stats.critical],
        ['Accuracy', stats.accuracy],
        ['Evasion', stats.evasion],
        ['Shield rate', stats.shieldRate],
        ['Bonus MP', stats.bonusMp],
        ['MP consume', stats.consumedMp]
    ].filter(([, value]) => Number(value || 0) !== 0);
}

function renderItemTooltip(item) {
    if (!item) return '';
    const stats = itemStatRows(item);
    const enchant = Number(item.enchant || 0);
    return `<div class="item-tooltip" role="tooltip">
        <strong>${text(item.name)}</strong>
        <span class="item-tooltip-meta">${text(item.slot)} · ${text(equipmentGrade(item.rank))}${enchant ? ` · +${number(enchant)}` : ''}</span>
        ${stats.length ? `<div class="item-tooltip-stats">${stats.map(([label, value]) => `<span><i>${text(label)}</i><b>${number(value)}</b></span>`).join('')}</div>` : '<span class="item-tooltip-empty">No item-specific stats</span>'}
        ${item.price ? `<span class="item-tooltip-price">Base price ${number(item.price)} Adena</span>` : ''}
    </div>`;
}

function renderPaperdollSlot(slot, item) {
    const edge = slot.edge ? ` edge-${slot.edge}` : '';
    if (!item) {
        return `<div class="paperdoll-slot paperdoll-slot-${text(slot.key)} is-empty${edge}" aria-label="${text(slot.label)} empty">
            <span class="paperdoll-slot-key">${text(slot.short)}</span>
            <span class="paperdoll-empty-mark">·</span>
        </div>`;
    }
    return `<div class="paperdoll-slot paperdoll-slot-${text(slot.key)} has-item${edge}" tabindex="0" aria-label="${text(`${slot.label}: ${item.name}`)}">
        <span class="paperdoll-slot-key">${text(slot.short)}</span>
        ${item.iconUrl ? `<img src="${text(item.iconUrl)}" alt="${text(item.name)}" loading="lazy" decoding="async">` : '<span class="paperdoll-missing-icon">?</span>'}
        ${Number(item.enchant || 0) ? `<b class="paperdoll-enchant">+${number(item.enchant)}</b>` : ''}
        ${renderItemTooltip(item)}
    </div>`;
}

function renderEquipment(equipment, combat) {
    if (!equipment) return '';
    const items = equipment.equipped || [];
    const totals = equipment.totals || combat || {};
    const used = new Set();
    return `<section class="inspector-block">
        <div class="inspector-block-title"><h3>Paperdoll</h3><span>${items.length} items · hover for stats</span></div>
        <div class="paperdoll" aria-label="Equipped items">
            <div class="paperdoll-center" aria-hidden="true"><span>W</span><small>C4</small></div>
            ${PAPERDOLL_SLOTS.map((slot) => renderPaperdollSlot(slot, paperdollItem(items, slot.slotIds, used))).join('')}
        </div>
        <div class="combat-stats">
            ${statCell('P. Atk', totals.pAtk)}
            ${statCell('M. Atk', totals.mAtk)}
            ${statCell('P. Def', totals.pDef)}
            ${statCell('M. Def', totals.mDef)}
        </div>
    </section>`;
}

function equipmentGrade(value) {
    const grade = String(value || 'no-grade').trim().toLowerCase().replaceAll('_', '-');
    if (['none', 'no-grade', 'nograde', '0'].includes(grade)) return 'No grade';
    return `${grade.toUpperCase()} grade`;
}

function renderBuild(build) {
    if (!build) return '';
    const gear = build.exampleGear?.length ? build.exampleGear.join(' · ') : `${build.armor || '—'} · ${build.weapon || '—'}`;
    const armor = readableBuildValue(build.armor, 'armor');
    const weapon = readableBuildValue(build.weapon, 'weapon');
    const grade = readableBuildValue(build.grade, 'grade');
    const playstyle = readableBuildValue(build.playstyle, 'playstyle');
    const priorities = (build.statPriority || []).map(readablePriority).join(' · ');
    return `<section class="inspector-block">
        <div class="inspector-block-title"><h3>Build</h3><span>${text(grade || build.classFamily || '')}</span></div>
        <p class="build-line"><strong>${text(armor)}</strong> armor · <strong>${text(weapon)}</strong> weapon</p>
        <p class="muted-copy">${text(playstyle === '—' ? gear : playstyle)}</p>
        ${priorities ? `<div class="priority-line"><span>Priority</span><strong>${text(priorities)}</strong></div>` : ''}
    </section>`;
}

function renderAction(actor) {
    const decision = actor.decisions?.combat || actor.decisions?.hunt || actor.decisions?.role || actor.roleDecision;
    const plan = actor.plan;
    const target = readablePlace(actor.target?.name || actor.spot?.name, null);
    const secondary = actor.travel?.reason
        ? `${activityLabel(actor.travel.reason)} → ${readablePlace(actor.travel.townName, 'field')}`
        : plan?.next?.npcName
            ? `${plan.next.npcName} at ${readablePlace(plan.next.spotId, 'next destination')}`
            : target
                ? `near ${target}`
                : actor.blockers?.[0] ? activityLabel(actor.blockers[0]) : 'No active target';
    return `<div class="activity-callout">
        <span>Doing now</span>
        <strong>${text(displayActivity(actor))}</strong>
        <p>${text(decision?.action ? readableToken(decision.action) : decisionReason(decision) || secondary)}</p>
    </div>`;
}

function readableDecisionValue(value) {
    if (value === null || value === undefined || value === '') return null;
    if (Array.isArray(value)) return value.map(readableDecisionValue).filter(Boolean).join(' · ') || null;
    if (typeof value !== 'object') return readableToken(value);
    const preferred = ['message', 'reason', 'label', 'action', 'route', 'target', 'spotId', 'code', 'type'];
    for (const key of preferred) {
        const readable = readableDecisionValue(value[key]);
        if (readable) return readable;
    }
    const parts = Object.entries(value)
        .map(([key, entry]) => {
            const readable = typeof entry === 'object' ? null : readableDecisionValue(entry);
            return readable ? `${UiLanguage.humanize(key)}: ${readable}` : null;
        })
        .filter(Boolean)
        .slice(0, 3);
    return parts.join(' · ') || null;
}

function decisionReason(decision) {
    if (!decision) return null;
    return readableDecisionValue(decision.reasons)
        || readableDecisionValue(decision.reason)
        || readableDecisionValue(decision.route)
        || (decision.targetNpcId ? `NPC ${decision.targetNpcId}` : null);
}

function renderDecisions(actor) {
    const decision = actor.decisions?.combat || actor.decisions?.hunt || actor.decisions?.role || actor.roleDecision || actor.lastResolve;
    if (!decision) return '';
    const reason = decisionReason(decision);
    if (!reason) return '';
    return `<section class="inspector-block compact-block">
        <div class="inspector-block-title"><h3>Last decision</h3><span>${text(humanizeToken(decision.action || 'resolve'))}</span></div>
        <p class="muted-copy">${text(reason)}</p>
    </section>`;
}

function renderSignals(actor) {
    const buffs = actor.buffs;
    const nearby = actor.nearby;
    const store = actor.trade?.store;
    const ambient = actor.ambient;
    if (!buffs && !nearby && !store && !ambient) return '';
    const buffText = buffs
        ? (buffs.needsRefresh ? 'Refresh needed' : `${buffs.active?.length || 0} active`)
        : null;
    const nearbyText = nearby
        ? `${nearby.realPlayers || 0} players · ${nearby.friendlyBots || 0} bots · ${nearby.attackableNpcs || 0} mobs`
        : null;
    const tradeText = store ? `${activityLabel(store.type || 'store')} · ${store.title || 'open'} · ${store.items || 0} lines` : null;
    const moodText = ambient ? `${activityLabel(ambient.mood || 'neutral')} · ${activityLabel(ambient.intent || 'idle')}` : null;
    return `<section class="inspector-block compact-block">
        <div class="inspector-block-title"><h3>Live context</h3><span>current</span></div>
        <div class="signal-list">
            ${buffText ? `<div><span>Buffs</span><strong>${text(buffText)}</strong></div>` : ''}
            ${nearbyText ? `<div><span>Nearby</span><strong>${text(nearbyText)}</strong></div>` : ''}
            ${tradeText ? `<div><span>Trade</span><strong>${text(tradeText)}</strong></div>` : ''}
            ${moodText ? `<div><span>Ambient</span><strong>${text(moodText)}</strong></div>` : ''}
        </div>
    </section>`;
}

function renderSelectedCard() {
    const actor = selectedActor();
    if (!actor) {
        const raidBoss = raidBossItems().find((boss) => String(boss.id) === String(state.selectedRaidBossId));
        if (raidBoss) {
            els.selectedCard.innerHTML = `
                <span class="eyeline">Selected raid boss</span>
                <strong>${text(raidBoss.name)}</strong>
                <p>Lv ${number(raidBoss.level, '?')} · ${text(raidBoss.location?.name, 'Unknown location')} · ${text(raidBossStatusLabel(raidBoss.status))}</p>
            `;
            return;
        }
        if (state.clusterScope) {
            els.selectedCard.innerHTML = `
                <span class="eyeline">Opened cluster</span>
                <strong>${number(state.clusterScope.actorKeys.size)} actors · ${text(state.clusterScope.label)}</strong>
                <p>Choose an actor from the scoped roster or open a smaller cluster.</p>
                <button class="selection-clear" type="button" data-clear-cluster>All actors</button>
            `;
            return;
        }
        els.selectedCard.innerHTML = '<span class="eyeline">Selection</span><strong>No actor selected</strong><p>Choose a point or cluster to inspect the bot.</p>';
        return;
    }
    const activity = readablePlace(actor.target?.name || actor.spot?.name, null) || displayActivity(actor);
    els.selectedCard.innerHTML = `
        <span class="eyeline">Selected ${text(phaseLabel(actor.phase || ''))}</span>
        <strong>${text(actor.isPk ? `PK ${actor.name}` : actor.name)}</strong>
        <p>Lv ${number(actor.level, '?')} · ${text(actorClassName(actor))} · ${text(activity)}</p>
        ${state.clusterScope ? '<button class="selection-clear" type="button" data-clear-cluster>All actors</button>' : ''}
    `;
}

function renderInspector() {
    const actor = selectedActor();
    if (!actor) {
        els.inspectorFreshness.textContent = 'live';
        if (state.clusterScope) {
            const scoped = filteredActors();
            const counts = scoped.reduce((result, item) => {
                const phase = item.kind === 'player' ? 'players' : item.phase;
                result[phase] = (result[phase] || 0) + 1;
                return result;
            }, {});
            els.selectedInspector.innerHTML = `
                <div class="cluster-inspector">
                    <span class="empty-glyph">◎</span>
                    <strong>${number(scoped.length)} actors in this cluster</strong>
                    <p>${text(state.clusterScope.label)} · roster is scoped to this area.</p>
                    <div class="cluster-phase-counts">
                        ${['hot', 'warm', 'cold', 'players'].filter((phase) => counts[phase]).map((phase) => `<span><i class="legend-dot ${phase === 'players' ? 'player' : phase}"></i>${phaseLabel(phase)} <strong>${number(counts[phase])}</strong></span>`).join('')}
                    </div>
                    <button class="selection-clear" type="button" data-clear-cluster>Show all actors</button>
                </div>
            `;
            return;
        }
        els.selectedInspector.innerHTML = `<div class="inspector-empty"><span class="empty-glyph">◎</span><strong>Nothing selected</strong><p>Click any actor on the map to see its current action and runtime status.</p></div>`;
        return;
    }

    if (state.detailLoading && !state.detail) {
        els.inspectorFreshness.textContent = 'loading';
        els.selectedInspector.innerHTML = '<div class="inspector-empty"><span class="loading-orbit"></span><strong>Loading actor info</strong><p>Reading the live status and persisted equipment snapshot.</p></div>';
        return;
    }

    if (state.detailError && !state.detail) {
        els.inspectorFreshness.textContent = 'error';
        els.selectedInspector.innerHTML = `<div class="inspector-empty detail-failure">
            <span class="empty-glyph">!</span>
            <strong>Actor info unavailable</strong>
            <p>${text(state.detailError)} · the compact map snapshot may be incomplete.</p>
            <button class="selection-clear" type="button" data-retry-detail>Retry</button>
        </div>`;
        return;
    }

    const build = actor.build;
    const family = actorClassName(actor);
    const location = actor.loc ? `${Math.round(actor.loc.locX)}, ${Math.round(actor.loc.locY)}, ${Math.round(actor.loc.locZ || 0)}` : 'Unknown';
    const party = partyLeaderLink(actor);
    const clan = actorClanLink(actor);
    const freshness = actor.updatedAt ? formatRelative(actor.updatedAt) : 'live';
    els.inspectorFreshness.textContent = state.detailError ? 'stale' : freshness;
    const detailWarning = state.detailError ? `<div class="detail-error">
        <span>Refresh failed · ${text(state.detailError)}</span>
        <button class="selection-clear" type="button" data-retry-detail>Retry</button>
    </div>` : '';
    els.selectedInspector.innerHTML = `
        ${detailWarning}
        <div class="inspector-hero">
            <div class="inspector-avatar" style="--avatar-color:${phaseColor(actor)}">${text(String(actor.name || '?').slice(0, 1).toUpperCase())}</div>
            <div class="inspector-name"><strong>${text(actor.isPk ? `PK ${actor.name}` : actor.name)}</strong><span>Lv ${number(actor.level, '?')} · ${text(family)} · ${text(roleLabel(actor.role || '—'))}</span></div>
            <span class="phase-badge ${text(actor.phase || 'cold')}">${text(phaseLabel(actor.phase || 'bot'))}</span>
        </div>
        <div class="inspector-vitals">
            ${vitalBar('HP', actor.vitals, '#63d37b')}
            ${vitalBar('MP', actor.vitals, '#57c7e8')}
        </div>
        ${renderAction(actor)}
        <div class="detail-grid">
            <div><span>Activity</span><strong>${text(activityLabel(actor.mode))}</strong></div>
            <div><span>Race</span><strong>${text(Leaderboards.raceName(actor))}</strong></div>
            <div><span>Region</span><strong>${text(readablePlace(actor.region || actor.home?.region))}</strong></div>
            <div><span>Clan</span><strong>${clan}</strong></div>
            <div><span>Party</span><strong>${party}</strong></div>
            <div><span>Position</span><strong>${text(location)}</strong></div>
            <div><span>Blockers</span><strong>${text(actor.blockers?.length ? actor.blockers.map(activityLabel).join(' · ') : 'None')}</strong></div>
        </div>
        ${renderSignals(actor)}
        ${actor.equipment || actor.combat ? renderEquipment(actor.equipment, actor.combat) : ''}
        ${renderBuild(build)}
        ${renderDecisions(actor)}
        ${renderProgress(actor)}
    `;
}

function renderSelected() {
    renderSelectedCard();
    renderInspector();
}

function renderSnapshot() {
    const snap = state.snapshot;
    if (!snap) return;

    const population = snap.population || {};
    els.serverLine.textContent = `${number(population.total || snap.bots.length)} bots in simulation · ${number(population.hot || 0)} active · uptime ${formatDuration(snap.uptimeMs)}`;
    setSvgViewBox();
    renderTiles();
    renderGrid();
    renderLabels();
    renderClassFilter();
    renderFilterCounts();
    renderPoints();
    renderPopulation();
    renderMarket();
    renderRaidBosses();
    renderRoster();
    renderSelected();
}

function renderActorUpdates({ mapChanged = true } = {}) {
    if (!state.snapshot) return;
    renderFilterCounts();
    if (mapChanged) {
        setSvgViewBox();
        renderPoints();
    }
    renderPopulation();
    renderRoster();
    renderSelected();
}

async function loadActorDetail(id, kind = state.selectedId?.kind || 'bot', showLoading = true) {
    if (!id || state.detailLoading) return;
    const requestId = ++state.detailRequest;
    state.detailLoading = showLoading;
    state.detailError = null;
    if (showLoading) renderSelected();
    try {
        let response = await fetch(`/observer/api/actor/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { cache: 'no-store' });
        // Keep bot inspection usable during a rolling server/UI restart where
        // the new static assets may be served before the process exposes the
        // unified actor endpoint.
        if (response.status === 404 && kind === 'bot') {
            response = await fetch(`/observer/api/bot/${encodeURIComponent(id)}`, { cache: 'no-store' });
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const detail = await response.json();
        if (requestId !== state.detailRequest || String(state.selectedId?.id) !== String(id) || state.selectedId?.kind !== kind) return;
        state.detail = detail;
    } catch (error) {
        if (requestId === state.detailRequest) state.detailError = error.message;
    } finally {
        if (requestId === state.detailRequest) {
            state.detailLoading = false;
            renderSelected();
        }
    }
}

function selectActor(id, kind = 'bot', focus = false, updateRoute = true) {
    state.selectedRaidBossId = null;
    state.selectedId = { id, kind };
    state.detail = null;
    state.detailError = null;
    state.detailLoading = false;
    if (focus) {
        const actor = actorById(id, kind);
        const loc = actor ? mapLocation(actor) : null;
        if (loc && isSurfaceActor(actor)) {
            const viewport = state.viewport || { x: 0, y: 0, width: mapMeta().width, height: mapMeta().height };
            const point = worldToMap(loc);
            applyViewport({
                x: point.x - viewport.width * 0.5,
                y: point.y - viewport.height * 0.5,
                width: viewport.width,
                height: viewport.height
            });
        }
    }
    renderPoints();
    renderRoster();
    renderSelected();
    loadActorDetail(id, kind);
    if (updateRoute) commitRoute({ name: 'actor', kind, id });
}

function focusCluster(cluster) {
    state.selectedRaidBossId = null;
    if (cluster.size === 1) {
        selectActor(cluster.members[0].actor.id, cluster.members[0].actor.kind);
        return;
    }
    state.clusterScope = {
        actorKeys: new Set(cluster.members.map(({ actor }) => actorKey(actor))),
        label: clusterLocation(cluster)
    };
    state.selectedId = null;
    state.detail = null;
    state.detailLoading = false;
    state.detailRequest += 1;
    commitRoute({ name: 'world' });

    focusMapPoints(cluster.members.map(({ point }) => point));
    renderRoster();
    renderSelected();
}

function clusterLocation(cluster) {
    const labels = cluster.members
        .map(({ actor }) => actor.area?.name || actor.region || actor.home?.region || actor.spot?.name)
        .filter((label) => label && !/^-?\d+_-?\d+$/.test(label));
    if (!labels.length) return 'this area';
    const counts = labels.reduce((result, label) => result.set(label, (result.get(label) || 0) + 1), new Map());
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function clearClusterScope(resetViewport = false) {
    state.clusterScope = null;
    if (resetViewport) {
        state.fit = true;
        els.fitButton.classList.add('is-live');
        setSvgViewBox();
        renderLabels();
    }
    renderPoints();
    renderRoster();
    renderSelected();
}

function applyWorldChanges(data) {
    if (!state.snapshot) return false;
    const mapChanged = Boolean(data.reset || data.removals?.length || data.upserts?.some((next) => {
        const kind = next.kind || 'bot';
        return mapActorSignature(actorById(next.id, kind)) !== mapActorSignature(next);
    }));
    const applied = WorldState.applyChanges(state.snapshot, data, Date.now());
    state.worldRevision = applied.revision;
    state.snapshot = applied.snapshot;
    const selected = state.selectedId;
    return {
        mapChanged,
        selectedChanged: !!selected && (data.reset || applied.changedKeys.has(`${selected.kind}:${Number(selected.id)}`))
    };
}

async function loadWorldStatus(force = false) {
    if (!state.snapshot || state.worldStatusLoading) return;
    if (!force && Date.now() - state.worldStatusAt < 30000) return;
    state.worldStatusLoading = true;
    try {
        const response = await fetch('/observer/api/world/status', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = await response.json();
        if (worldEpochChanged(status.epoch)) {
            restartWorldBootstrap(status.epoch);
            return;
        }
        state.worldEpoch = status.epoch || state.worldEpoch;
        state.worldStatusAt = Date.now();
        state.snapshot = { ...state.snapshot, ...status };
        const population = state.snapshot.population || {};
        els.serverLine.textContent = `${number(population.total || state.snapshot.bots.length)} bots in simulation · ${number(population.hot || 0)} active · uptime ${formatDuration(state.snapshot.uptimeMs)}`;
        renderFilterCounts();
        renderPopulation();
        renderMarket();
        renderRaidBosses();
        if (state.phase === 'raidbosses' || state.selectedRaidBossId) {
            renderRaidBossPoints();
            renderRoster();
            renderSelected();
        }
    } catch (error) {
        els.serverLine.textContent = `Observer status failed: ${error.message}`;
    } finally {
        state.worldStatusLoading = false;
    }
}

async function refresh() {
    if (!state.live || document.hidden || state.refreshing) return;
    state.refreshing = true;
    try {
        if (!state.snapshot) {
            const response = await fetch('/observer/api/world/bootstrap', { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bootstrap = WorldState.decodeBootstrap(await response.json());
            state.worldEpoch = bootstrap.epoch || null;
            state.worldRevision = Number(bootstrap.revision || 0);
            state.worldStatusAt = Date.now();
            state.snapshot = bootstrap;
            reconcileSelectedActor();
            renderSnapshot();
            loadClanDirectory();
            if (state.pendingRoute) applyRoute(state.pendingRoute);
            return;
        }
        const response = await fetch(`/observer/api/world/changes?since=${encodeURIComponent(state.worldRevision)}`, { cache: 'no-store' });
        if (response.status === 204) {
            const epoch = response.headers.get('X-Observer-Epoch');
            if (worldEpochChanged(epoch)) {
                restartWorldBootstrap(epoch);
                return;
            }
            state.worldEpoch = epoch || state.worldEpoch;
            loadWorldStatus();
            return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const changes = await response.json();
        if (worldEpochChanged(changes.epoch)) {
            restartWorldBootstrap(changes.epoch);
            return;
        }
        state.worldEpoch = changes.epoch || state.worldEpoch;
        const changed = applyWorldChanges(changes);
        reconcileSelectedActor();
        renderActorUpdates({ mapChanged: changed.mapChanged });
        if (changed.selectedChanged && state.selectedId && !state.detailLoading) {
            loadActorDetail(state.selectedId.id, state.selectedId.kind, false);
        }
        if (state.rankingOpen) renderRankings();
        loadClanDirectory();
        loadWorldStatus();
    } catch (error) {
        els.serverLine.textContent = `Observer snapshot failed: ${error.message}`;
    } finally {
        state.refreshing = false;
    }
}

els.openRankings?.addEventListener('click', openRankings);
els.closeRankings?.addEventListener('click', closeRankings);
els.openRaidBosses?.addEventListener('click', openRaidBosses);
els.closeRaidBosses?.addEventListener('click', closeRaidBosses);
els.openClans?.addEventListener('click', () => openClans());
els.closeClans?.addEventListener('click', closeClans);

els.rankingsModal?.addEventListener('click', (event) => {
    const actor = event.target.closest('[data-ranking-id]');
    if (actor) {
        selectActor(actor.dataset.rankingId, actor.dataset.rankingKind, true);
        closeRankings({ updateRoute: false });
        return;
    }
    if (event.target === els.rankingsModal) closeRankings();
});

els.raidBossesModal?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-raid-boss-id]');
    if (row && !row.disabled) {
        focusRaidBoss(row.dataset.raidBossId);
        return;
    }
    if (event.target === els.raidBossesModal) closeRaidBosses();
});

els.clansModal?.addEventListener('click', (event) => {
    const manage = event.target.closest('[data-clan-manage]');
    if (manage) {
        state.clanManagerOpen = !state.clanManagerOpen;
        state.clanCrestMessage = null;
        if (!state.clanManagerOpen) resetClanCrestDraft();
        renderClanDetail();
        return;
    }
    const fit = event.target.closest('[data-crest-fit]');
    if (fit) {
        state.clanCrestFit = fit.dataset.crestFit === 'contain' ? 'contain' : 'cover';
        if (state.clanCrestSource) buildClanCrestDraft(state.clanCrestSource, state.clanCrestDraft?.fileName || 'Image');
        renderClanDetail();
        return;
    }
    if (event.target.closest('[data-save-clan-crest]')) {
        saveClanCrest();
        return;
    }
    if (event.target.closest('[data-remove-clan-crest]')) {
        removeClanCrest();
        return;
    }
    const member = event.target.closest('[data-clan-member-id]');
    if (member) {
        selectActor(member.dataset.clanMemberId, member.dataset.clanMemberKind || 'bot', true);
        closeClans({ updateRoute: false });
        return;
    }
    const clan = event.target.closest('[data-clan-id]');
    if (clan) {
        loadClanDetail(clan.dataset.clanId);
        return;
    }
    if (event.target === els.clansModal) closeClans();
});

els.clansModal?.addEventListener('change', (event) => {
    const input = event.target.closest('[data-clan-crest-file]');
    if (input) loadClanCrestFile(input.files?.[0]);
});

els.clansModal?.addEventListener('dragover', (event) => {
    const dropzone = event.target.closest('[data-clan-crest-dropzone]');
    if (!dropzone) return;
    event.preventDefault();
    dropzone.classList.add('is-dragging');
});

els.clansModal?.addEventListener('dragleave', (event) => {
    event.target.closest('[data-clan-crest-dropzone]')?.classList.remove('is-dragging');
});

els.clansModal?.addEventListener('drop', (event) => {
    const dropzone = event.target.closest('[data-clan-crest-dropzone]');
    if (!dropzone) return;
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
    loadClanCrestFile(event.dataTransfer?.files?.[0]);
});

els.clanSortTabs?.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-clan-sort]');
    if (!tab) return;
    state.clanSort = tab.dataset.clanSort || 'level';
    els.clanSortTabs.querySelectorAll('[data-clan-sort]').forEach((item) => {
        const active = item === tab;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
    });
    renderClans();
});

els.clanSearch?.addEventListener('input', (event) => {
    state.clanSearch = String(event.target.value || '').trim().toLowerCase();
    if (els.clanList) els.clanList.scrollTop = 0;
    renderClans();
});

els.raidBossFilters?.addEventListener('click', (event) => {
    const filter = event.target.closest('[data-raid-filter]');
    if (!filter) return;
    state.raidBossFilter = filter.dataset.raidFilter || 'all';
    els.raidBossFilters.querySelectorAll('[data-raid-filter]').forEach((item) => {
        const active = item === filter;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
    });
    els.raidBossList.scrollTop = 0;
    renderRaidBosses();
});

els.raidBossSearch?.addEventListener('input', (event) => {
    state.raidBossSearch = String(event.target.value || '').trim().toLowerCase();
    els.raidBossList.scrollTop = 0;
    renderRaidBosses();
});

els.rankingTabs?.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-ranking-metric]');
    if (!tab) return;
    state.rankingMetric = tab.dataset.rankingMetric;
    els.rankingTabs.querySelectorAll('[data-ranking-metric]').forEach((item) => {
        const active = item === tab;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
    });
    els.rankingList.scrollTop = 0;
    renderRankings();
});

els.rankingRace?.addEventListener('change', (event) => {
    state.rankingRaceKey = String(event.target.value || 'all');
    state.rankingClassKey = 'all';
    els.rankingList.scrollTop = 0;
    renderRankings();
});

els.rankingClass?.addEventListener('change', (event) => {
    state.rankingClassKey = String(event.target.value || 'all');
    els.rankingList.scrollTop = 0;
    renderRankings();
});

els.liveToggle.addEventListener('click', () => {
    state.live = !state.live;
    els.liveToggle.classList.toggle('is-live', state.live);
    els.liveToggle.title = state.live ? 'Pause live refresh' : 'Resume live refresh';
    els.liveLabel.textContent = state.live ? 'Live' : 'Paused';
    if (state.live) refresh();
});

els.fitButton.addEventListener('click', () => {
    state.clusterScope = null;
    state.fit = true;
    els.fitButton.classList.add('is-live');
    setSvgViewBox();
    renderLabels();
    renderPoints();
    renderRoster();
    renderSelected();
});

function zoomMap(factor) {
    const viewport = state.viewport || { x: 0, y: 0, width: mapMeta().width, height: mapMeta().height };
    const width = viewport.width * factor;
    const height = viewport.height * factor;
    applyViewport({
        x: viewport.x + (viewport.width - width) / 2,
        y: viewport.y + (viewport.height - height) / 2,
        width,
        height
    });
}

els.zoomInButton?.addEventListener('click', () => zoomMap(0.7));
els.zoomOutButton?.addEventListener('click', () => zoomMap(1.3));

document.addEventListener('click', (event) => {
    const worldLink = event.target.closest('[data-spa-route="world"]');
    if (worldLink) {
        event.preventDefault();
        commitRoute({ name: 'world' });
        applyRoute({ name: 'world' });
        return;
    }
    const clanLink = event.target.closest('[data-actor-clan-id]');
    if (clanLink) {
        event.preventDefault();
        openClans(clanLink.dataset.actorClanId);
        return;
    }
    const leaderLink = event.target.closest('[data-party-leader-id]');
    if (leaderLink) {
        event.preventDefault();
        selectActor(leaderLink.dataset.partyLeaderId, leaderLink.dataset.partyLeaderKind || 'bot', true);
        return;
    }
    if (event.target.closest('[data-retry-detail]')) {
        if (state.selectedId) loadActorDetail(state.selectedId.id, state.selectedId.kind);
        return;
    }
    if (!event.target.closest('[data-clear-cluster]')) return;
    clearClusterScope(true);
});

els.filterStrip.addEventListener('click', (event) => {
    const button = event.target.closest('[data-phase]');
    if (!button) return;
    let selectionCleared = false;
    state.phase = button.dataset.phase;
    if (state.phase === 'raidbosses') {
        selectionCleared = Boolean(state.selectedId);
        state.selectedId = null;
        state.detail = null;
        state.detailError = null;
        state.detailLoading = false;
        state.clusterScope = null;
        state.detailRequest += 1;
    } else if (state.phase !== 'all') {
        selectionCleared = Boolean(state.selectedRaidBossId);
        state.selectedRaidBossId = null;
    }
    if (selectionCleared) commitRoute({ name: 'world' });
    els.filterStrip.querySelectorAll('.filter').forEach((item) => item.classList.toggle('is-active', item === button));
    renderFilteredActorViews({ counts: false });
    renderSelected();
});

els.actorSearch.addEventListener('input', (event) => {
    state.search = String(event.target.value || '').trim().toLowerCase();
    renderFilteredActorViews();
});

els.minLevelFilter.addEventListener('input', () => updateLevelFilter('min'));
els.maxLevelFilter.addEventListener('input', () => updateLevelFilter('max'));

els.classFilter.addEventListener('change', (event) => {
    state.classKey = String(event.target.value || 'all');
    renderFilteredActorViews();
});

els.clearActorFilters.addEventListener('click', () => {
    state.minLevel = null;
    state.maxLevel = null;
    state.classKey = 'all';
    els.minLevelFilter.value = '';
    els.maxLevelFilter.value = '';
    els.classFilter.value = 'all';
    renderFilteredActorViews();
});

els.actorList.addEventListener('click', (event) => {
    const row = event.target.closest('[data-roster-id]');
    if (!row) return;
    selectActor(row.dataset.rosterId, row.dataset.rosterKind, true);
});

els.worldMap.addEventListener('wheel', (event) => {
    event.preventDefault();
    const viewport = state.viewport || { x: 0, y: 0, width: mapMeta().width, height: mapMeta().height };
    const focus = clientToMapPoint(event.clientX, event.clientY);
    const zoomFactor = event.deltaY < 0 ? 0.82 : 1.22;
    const nextWidth = viewport.width * zoomFactor;
    const nextHeight = viewport.height * zoomFactor;
    const focusRatioX = (focus.x - viewport.x) / viewport.width;
    const focusRatioY = (focus.y - viewport.y) / viewport.height;
    applyViewport({
        x: focus.x - nextWidth * focusRatioX,
        y: focus.y - nextHeight * focusRatioY,
        width: nextWidth,
        height: nextHeight
    });
}, { passive: false });

els.worldMap.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest?.('.point')) return;
    els.worldMap.setPointerCapture(event.pointerId);
    state.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewport: { ...(state.viewport || { x: 0, y: 0, width: mapMeta().width, height: mapMeta().height }) }
    };
    els.worldMap.classList.add('is-dragging');
});

els.worldMap.addEventListener('pointermove', (event) => {
    if (!state.drag || state.drag.pointerId !== event.pointerId) return;
    const metrics = mapViewportMetrics(state.drag.viewport);
    const dx = (event.clientX - state.drag.startX) / metrics.scale;
    const dy = (event.clientY - state.drag.startY) / metrics.scale;
    applyViewport({ ...state.drag.viewport, x: state.drag.viewport.x - dx, y: state.drag.viewport.y - dy });
});

function finishDrag(event) {
    if (!state.drag || state.drag.pointerId !== event.pointerId) return;
    state.drag = null;
    els.worldMap.classList.remove('is-dragging');
}

els.worldMap.addEventListener('pointerup', finishDrag);
els.worldMap.addEventListener('pointercancel', finishDrag);

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.raidBossOpen) {
        event.preventDefault();
        closeRaidBosses();
        return;
    }
    if (event.key === 'Escape' && state.rankingOpen) {
        event.preventDefault();
        closeRankings();
        return;
    }
    if (event.key === 'Escape' && state.clanOpen && state.clanManagerOpen) {
        event.preventDefault();
        state.clanManagerOpen = false;
        state.clanCrestMessage = null;
        resetClanCrestDraft();
        renderClanDetail();
        return;
    }
    if (event.key === 'Escape' && state.clanOpen) {
        event.preventDefault();
        closeClans();
        return;
    }
    if (state.rankingOpen) {
        if (event.key === 'Tab') {
            const focusable = [...els.rankingsModal.querySelectorAll('button:not([disabled]), select:not([disabled])')]
                .filter((element) => !element.hidden && element.offsetParent !== null);
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        }
        return;
    }
    if (state.raidBossOpen) {
        if (event.key === 'Tab') {
            const focusable = [...els.raidBossesModal.querySelectorAll('button:not([disabled]), input:not([disabled])')]
                .filter((element) => !element.hidden && element.offsetParent !== null);
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        }
        return;
    }
    if (state.clanOpen) {
        if (event.key === 'Tab') {
            const focusable = [...els.clansModal.querySelectorAll('button:not([disabled]), input:not([disabled])')]
                .filter((element) => !element.hidden && element.offsetParent !== null);
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        }
        return;
    }
    if (event.key === '/' && document.activeElement !== els.actorSearch) {
        event.preventDefault();
        els.actorSearch.focus();
    }
    if (event.key === 'Escape' && document.activeElement === els.actorSearch) {
        els.actorSearch.value = '';
        state.search = '';
        renderFilteredActorViews();
        els.actorSearch.blur();
        return;
    }
    if (event.key === 'Escape' && state.clusterScope) clearClusterScope(true);
});

window.addEventListener('popstate', () => applyRoute());
applyRoute();
refresh();
setInterval(refresh, 2000);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
});
