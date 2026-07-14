const state = {
    snapshot: null,
    selectedId: null,
    phase: 'all',
    live: true,
    fit: false,
    renderedTileKey: null,
    viewport: null,
    drag: null
};

const COLORS = {
    hot: '#63d37b',
    warm: '#e2a84f',
    cold: '#7aa7ff',
    player: '#57c7e8',
    merchant: '#d8b96d',
    dead: '#e66d61',
    pk: '#ff3b30'
};

const els = {
    serverLine: document.querySelector('#serverLine'),
    liveToggle: document.querySelector('#liveToggle'),
    fitButton: document.querySelector('#fitButton'),
    filterStrip: document.querySelector('#filterStrip'),
    worldMap: document.querySelector('#worldMap'),
    tileLayer: document.querySelector('#tileLayer'),
    gridLines: document.querySelector('#gridLines'),
    regionLabels: document.querySelector('#regionLabels'),
    pointsLayer: document.querySelector('#pointsLayer'),
    selectedCard: document.querySelector('#selectedCard'),
    botsTotal: document.querySelector('#botsTotal'),
    playersTotal: document.querySelector('#playersTotal'),
    movingTotal: document.querySelector('#movingTotal'),
    targetsTotal: document.querySelector('#targetsTotal'),
    phaseBars: document.querySelector('#phaseBars'),
    modeList: document.querySelector('#modeList'),
    actorList: document.querySelector('#actorList'),
    eventList: document.querySelector('#eventList'),
    lastRefresh: document.querySelector('#lastRefresh'),
    heapLine: document.querySelector('#heapLine'),
    visibleCount: document.querySelector('#visibleCount')
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

function svgEl(name, attrs = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
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

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function clampViewport(viewport) {
    const tiles = mapMeta();
    const minWidth = 700;
    const minHeight = 500;
    const width = clamp(viewport.width, minWidth, tiles.width);
    const height = clamp(viewport.height, minHeight, tiles.height);
    return {
        x: clamp(viewport.x, 0, Math.max(0, tiles.width - width)),
        y: clamp(viewport.y, 0, Math.max(0, tiles.height - height)),
        width,
        height
    };
}

function mapMeta() {
    const tiles = state.snapshot?.mapTiles || DEFAULT_TILES;
    const width = (tiles.x.max - tiles.x.min + 1) * tiles.blockPx;
    const height = (tiles.y.max - tiles.y.min + 1) * tiles.blockPx;
    return { ...tiles, width, height };
}

function worldToMap(loc) {
    const tiles = mapMeta();
    const blockX = Math.floor(Number(loc.locX || 0) / tiles.blockSize) + tiles.x.mid;
    const blockY = Math.floor(Number(loc.locY || 0) / tiles.blockSize) + tiles.y.mid;
    let modX = (Number(loc.locX || 0) / tiles.blockSize) % 1;
    let modY = (Number(loc.locY || 0) / tiles.blockSize) % 1;
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

function setSvgViewBox() {
    const tiles = mapMeta();
    els.worldMap.querySelector('.sea').setAttribute('width', tiles.width);
    els.worldMap.querySelector('.sea').setAttribute('height', tiles.height);

    if (!state.viewport) {
        state.viewport = { x: 0, y: 0, width: tiles.width, height: tiles.height };
    }

    if (!state.fit || !state.snapshot) {
        const viewport = clampViewport(state.viewport);
        state.viewport = viewport;
        els.worldMap.setAttribute('viewBox', `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`);
        return;
    }

    const locs = [...state.snapshot.bots, ...state.snapshot.players].map((item) => item.loc).filter(Boolean);
    if (locs.length < 2) {
        state.viewport = { x: 0, y: 0, width: tiles.width, height: tiles.height };
        els.worldMap.setAttribute('viewBox', `0 0 ${tiles.width} ${tiles.height}`);
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
    els.worldMap.setAttribute('viewBox', `${state.viewport.x} ${state.viewport.y} ${state.viewport.width} ${state.viewport.height}`);
}

function clientToMapPoint(clientX, clientY) {
    const rect = els.worldMap.getBoundingClientRect();
    const viewport = state.viewport || {
        x: 0,
        y: 0,
        width: mapMeta().width,
        height: mapMeta().height
    };
    return {
        x: viewport.x + ((clientX - rect.left) / rect.width) * viewport.width,
        y: viewport.y + ((clientY - rect.top) / rect.height) * viewport.height
    };
}

function applyViewport(viewport) {
    state.fit = false;
    els.fitButton.classList.remove('is-live');
    state.viewport = clampViewport(viewport);
    els.worldMap.setAttribute('viewBox', `${state.viewport.x} ${state.viewport.y} ${state.viewport.width} ${state.viewport.height}`);
}

function phaseColor(item) {
    if (item.isPk) return COLORS.pk;
    if (item.kind === 'player') return COLORS.player;
    if (item.mode === 'merchant') return COLORS.merchant;
    if (item.blockers && item.blockers.includes('dead')) return COLORS.dead;
    return COLORS[item.phase] || COLORS.cold;
}

function isVisible(item) {
    if (state.phase === 'all') return true;
    if (state.phase === 'players') return item.kind === 'player';
    return item.kind !== 'player' && item.phase === state.phase;
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

            const image = svgEl('image', {
                href: `${tiles.rawBaseUrl}/${x}_${y}.jpg`,
                x: (x - tiles.x.min) * tiles.blockPx,
                y: (y - tiles.y.min) * tiles.blockPx,
                width: tiles.blockPx,
                height: tiles.blockPx,
                preserveAspectRatio: 'none'
            });
            els.tileLayer.appendChild(image);
        }
    }

    state.renderedTileKey = tileKey;
}

function renderLabels() {
    const snap = state.snapshot;
    els.regionLabels.innerHTML = '';
    if (!snap) return;

    snap.labels.forEach((label) => {
        const point = project(label);
        els.regionLabels.appendChild(svgEl('circle', {
            cx: point.x,
            cy: point.y,
            r: label.kind === 'town' ? 48 : 36
        }));
        const text = svgEl('text', {
            x: point.x + 85,
            y: point.y - 70
        });
        text.textContent = label.name;
        els.regionLabels.appendChild(text);
    });
}

function renderPoints() {
    const snap = state.snapshot;
    els.pointsLayer.innerHTML = '';
    if (!snap) return;

    const actors = [
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

    actors.forEach((actor) => {
        if (!actor.loc) return;

        const point = project(actor.loc);
        const color = phaseColor(actor);
        const visible = isVisible(actor);
        const group = svgEl('g', {
            class: `point${visible ? '' : ' is-muted'}`,
            transform: `translate(${point.x}, ${point.y})`,
            tabindex: 0,
            role: 'button',
            'data-actor-id': actor.id,
            'data-actor-kind': actor.kind,
            'aria-label': actor.name
        });
        group.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });
        group.addEventListener('pointerup', (event) => {
            event.stopPropagation();
            selectActor(actor.id, actor.kind);
        });
        group.addEventListener('click', (event) => {
            event.stopPropagation();
            selectActor(actor.id, actor.kind);
        });
        group.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectActor(actor.id, actor.kind);
            }
        });

        const radius = actor.kind === 'player' ? 72 : actor.phase === 'hot' ? 62 : 45;
        group.appendChild(svgEl('circle', {
            class: 'point-hit',
            r: radius + 92,
            fill: 'transparent'
        }));
        group.appendChild(svgEl('circle', {
            class: 'point-ring',
            r: radius + 58,
            stroke: color,
            opacity: visible ? 0.45 : 0.12
        }));
        group.appendChild(svgEl('circle', {
            class: 'point-core',
            r: radius,
            fill: color
        }));

        if (actor.phase === 'hot' || actor.kind === 'player') {
            const text = svgEl('text', {
                class: 'point-label',
                x: radius + 84,
                y: 42
            });
            text.textContent = actor.name;
            group.appendChild(text);
        }

        els.pointsLayer.appendChild(group);
    });

    els.visibleCount.textContent = `${actors.filter(isVisible).length} visible`;
}

function sortedEntries(object) {
    return Object.entries(object || {}).sort((a, b) => b[1] - a[1]);
}

function renderPhaseBars() {
    const counts = state.snapshot?.stats?.botsByPhase || {};
    const total = Math.max(1, Object.values(counts).reduce((sum, value) => sum + value, 0));
    els.phaseBars.innerHTML = '';

    ['hot', 'warm', 'cold'].forEach((phase) => {
        const count = counts[phase] || 0;
        const row = document.createElement('div');
        row.className = 'bar-row';
        row.innerHTML = `
            <span>${phase}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (count / total) * 100)}%;background:${COLORS[phase]}"></div></div>
            <strong>${count}</strong>
        `;
        els.phaseBars.appendChild(row);
    });
}

function renderModeList() {
    const entries = sortedEntries(state.snapshot?.stats?.botsByMode).slice(0, 8);
    els.modeList.innerHTML = '';

    entries.forEach(([mode, count]) => {
        const row = document.createElement('div');
        row.className = 'mode-row';
        row.innerHTML = `<span>${mode}</span><strong>${count}</strong>`;
        els.modeList.appendChild(row);
    });
}

function renderActorList() {
    const bots = [...(state.snapshot?.bots || [])]
        .sort((a, b) => {
            const phaseRank = { hot: 0, warm: 1, cold: 2 };
            return (phaseRank[a.phase] ?? 9) - (phaseRank[b.phase] ?? 9) || String(a.name).localeCompare(String(b.name));
        })
        .slice(0, 70);

    els.actorList.innerHTML = '';
    bots.forEach((bot) => {
        const button = document.createElement('button');
        button.className = 'actor-row';
        button.type = 'button';
        button.addEventListener('click', () => selectActor(bot.id, 'bot'));
        button.innerHTML = `
            <span class="phase-dot" style="background:${phaseColor(bot)}"></span>
            <span class="actor-main">
                <strong>${bot.isPk ? 'PK ' : ''}${bot.name}</strong>
                <span>${bot.phase} / ${bot.mode} / Lv ${bot.level}</span>
            </span>
            <span class="actor-vitals">
                <span>HP ${bot.vitals?.hpPct ?? 0}%</span>
                <span>MP ${bot.vitals?.mpPct ?? 0}%</span>
            </span>
        `;
        els.actorList.appendChild(button);
    });
}

function renderEvents() {
    const events = state.snapshot?.events || [];
    els.eventList.innerHTML = '';

    events.slice(0, 18).forEach((event) => {
        const row = document.createElement('div');
        row.className = 'event-row';
        row.innerHTML = `
            <strong>${event.type || 'event'}</strong>
            <p>${event.summary || 'No summary'}</p>
        `;
        els.eventList.appendChild(row);
    });
}

function actorById(id, kind) {
    const snap = state.snapshot;
    if (!snap) return null;
    if (kind === 'player') return snap.players.find((player) => String(player.id) === String(id));
    return snap.bots.find((bot) => String(bot.id) === String(id));
}

function selectActor(id, kind = 'bot') {
    state.selectedId = { id, kind };
    renderSelected();
}

function renderSelected() {
    if (!state.selectedId) return;
    const actor = actorById(state.selectedId.id, state.selectedId.kind);
    if (!actor) return;

    const loc = actor.loc ? `${Math.round(actor.loc.locX)}, ${Math.round(actor.loc.locY)}, ${Math.round(actor.loc.locZ || 0)}` : 'unknown';
    const hpPct = actor.vitals?.hpPct ?? 0;
    const mpPct = actor.vitals?.mpPct ?? 0;
    const kind = actor.isPk ? 'PK' : 'Player';
    const detail = actor.kind === 'player' || state.selectedId.kind === 'player'
        ? `${kind} / ${actor.online ? 'online' : 'offline'}`
        : `${actor.phase} / ${actor.mode} / ${actor.intent || 'idle'} / ${actor.role}`;
    const target = actor.target?.name ? `Target: ${actor.target.name}` : actor.spot?.name ? `Spot: ${actor.spot.name}` : 'No target';

    els.selectedCard.innerHTML = `
        <span class="eyeline">Selected</span>
        <strong>${actor.name}</strong>
        <p class="selected-meta">Lv ${actor.level} / ${detail}</p>
        <div class="selected-bars" aria-label="Selected actor vitals">
            <div class="selected-bar">
                <span>HP</span>
                <div class="selected-bar-track"><div class="selected-bar-fill hp" style="width:${hpPct}%"></div></div>
                <strong>${hpPct}%</strong>
            </div>
            <div class="selected-bar">
                <span>MP</span>
                <div class="selected-bar-track"><div class="selected-bar-fill mp" style="width:${mpPct}%"></div></div>
                <strong>${mpPct}%</strong>
            </div>
        </div>
        <p>${target}<br>Loc ${loc}</p>
    `;
}

function renderSnapshot() {
    const snap = state.snapshot;
    if (!snap) return;

    els.botsTotal.textContent = snap.bots.length;
    els.playersTotal.textContent = snap.players.length;
    els.movingTotal.textContent = snap.stats.moving || 0;
    els.targetsTotal.textContent = snap.stats.activeTargets || 0;
    els.lastRefresh.textContent = new Date(snap.generatedAt).toLocaleTimeString();
    els.heapLine.textContent = `heap ${snap.runtime.heapUsedMb} MB`;
    els.serverLine.textContent = `uptime ${formatDuration(snap.uptimeMs)} / hot ${snap.population.hot} / warm ${snap.population.warm} / cold ${snap.population.cold}`;

    setSvgViewBox();
    renderTiles();
    renderGrid();
    renderLabels();
    renderPoints();
    renderPhaseBars();
    renderModeList();
    renderActorList();
    renderEvents();
    renderSelected();
}

async function refresh() {
    if (!state.live) return;
    try {
        const response = await fetch('/observer/api/snapshot', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.snapshot = await response.json();
        renderSnapshot();
    } catch (err) {
        els.serverLine.textContent = `Observer snapshot failed: ${err.message}`;
    }
}

els.liveToggle.addEventListener('click', () => {
    state.live = !state.live;
    els.liveToggle.classList.toggle('is-live', state.live);
    els.liveToggle.title = state.live ? 'Pause live refresh' : 'Resume live refresh';
    els.liveToggle.lastChild.textContent = state.live ? 'Live' : 'Paused';
    if (state.live) refresh();
});

els.fitButton.addEventListener('click', () => {
    state.fit = true;
    els.fitButton.classList.add('is-live');
    setSvgViewBox();
    renderLabels();
    renderPoints();
});

els.filterStrip.addEventListener('click', (event) => {
    const button = event.target.closest('[data-phase]');
    if (!button) return;
    state.phase = button.dataset.phase;
    els.filterStrip.querySelectorAll('.filter').forEach((item) => {
        item.classList.toggle('is-active', item === button);
    });
    renderPoints();
});

els.worldMap.addEventListener('wheel', (event) => {
    event.preventDefault();
    const viewport = state.viewport || {
        x: 0,
        y: 0,
        width: mapMeta().width,
        height: mapMeta().height
    };
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
    if (event.button !== 0) return;
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
    const rect = els.worldMap.getBoundingClientRect();
    const dx = ((event.clientX - state.drag.startX) / rect.width) * state.drag.viewport.width;
    const dy = ((event.clientY - state.drag.startY) / rect.height) * state.drag.viewport.height;

    applyViewport({
        ...state.drag.viewport,
        x: state.drag.viewport.x - dx,
        y: state.drag.viewport.y - dy
    });
});

function finishDrag(event) {
    if (!state.drag || state.drag.pointerId !== event.pointerId) return;
    state.drag = null;
    els.worldMap.classList.remove('is-dragging');
}

els.worldMap.addEventListener('pointerup', finishDrag);
els.worldMap.addEventListener('pointercancel', finishDrag);

refresh();
setInterval(refresh, 2000);
