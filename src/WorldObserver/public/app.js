const state = {
    snapshot: null,
    selectedId: null,
    phase: 'all',
    search: '',
    live: true,
    fit: false,
    renderedTileKey: null,
    viewport: null,
    drag: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    detailRequest: 0,
    clusterScope: null
};

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

const els = {
    serverLine: document.querySelector('#serverLine'),
    liveToggle: document.querySelector('#liveToggle'),
    liveLabel: document.querySelector('.live-label'),
    fitButton: document.querySelector('#fitButton'),
    filterStrip: document.querySelector('#filterStrip'),
    actorSearch: document.querySelector('#actorSearch'),
    worldMap: document.querySelector('#worldMap'),
    tileLayer: document.querySelector('#tileLayer'),
    gridLines: document.querySelector('#gridLines'),
    regionLabels: document.querySelector('#regionLabels'),
    pointsLayer: document.querySelector('#pointsLayer'),
    selectedCard: document.querySelector('#selectedCard'),
    selectedInspector: document.querySelector('#selectedInspector'),
    botsTotal: document.querySelector('#botsTotal'),
    playersTotal: document.querySelector('#playersTotal'),
    populationSubline: document.querySelector('#populationSubline'),
    phaseBars: document.querySelector('#phaseBars'),
    actorList: document.querySelector('#actorList'),
    lastRefresh: document.querySelector('#lastRefresh'),
    visibleCount: document.querySelector('#visibleCount'),
    inspectorFreshness: document.querySelector('#inspectorFreshness')
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

    const locs = [...state.snapshot.bots, ...state.snapshot.players].map((item) => item.loc).filter(Boolean);
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

function actorSearchText(actor) {
    return [
        actor.name,
        actor.phase,
        actor.mode,
        actor.intent,
        actor.role,
        actor.home?.region,
        actor.spot?.name,
        actor.classId
    ].filter(Boolean).join(' ').toLowerCase();
}

function isVisible(actor) {
    if (state.phase !== 'all' && state.phase !== 'players' && actor.phase !== state.phase) return false;
    if (state.phase === 'players' && actor.kind !== 'player') return false;
    return !state.search || actorSearchText(actor).includes(state.search);
}

function filteredActors() {
    const scope = state.clusterScope?.actorKeys;
    return actors().filter((actor) => (!scope || scope.has(actorKey(actor))) && isVisible(actor));
}

function actorKey(actor) {
    return `${actor.kind || 'bot'}:${actor.id}`;
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
    return Math.max(12, screenUnits(66));
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
    const mergeDistance = clusterCellSize();
    const groups = [];

    items.forEach((actor) => {
        if (!actor.loc) return;
        const point = project(actor.loc);
        let group = groups.find((candidate) => Math.hypot(point.x - candidate.x, point.y - candidate.y) <= mergeDistance);
        if (!group) {
            group = { members: [], x: point.x, y: point.y };
            groups.push(group);
        }
        group.members.push({ actor, point });
        const size = group.members.length;
        group.x += (point.x - group.x) / size;
        group.y += (point.y - group.y) / size;
    });

    let merged = true;
    while (merged) {
        merged = false;
        mergeLoop: for (let left = 0; left < groups.length; left += 1) {
            for (let right = left + 1; right < groups.length; right += 1) {
                const a = groups[left];
                const b = groups[right];
                if (Math.hypot(a.x - b.x, a.y - b.y) > mergeDistance) continue;
                const total = a.members.length + b.members.length;
                a.x = ((a.x * a.members.length) + (b.x * b.members.length)) / total;
                a.y = ((a.y * a.members.length) + (b.y * b.members.length)) / total;
                a.members.push(...b.members);
                groups.splice(right, 1);
                merged = true;
                break mergeLoop;
            }
        }
    }

    return groups.map((group) => ({
        members: group.members,
        point: { x: group.x, y: group.y },
        size: group.members.length,
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
    return `${actor.isPk ? 'PK ' : ''}${actor.name} · Lv ${actor.level} · ${actor.intent || actor.mode || 'idle'}`;
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
    const radiusPx = clamp(16 + (Math.log2(cluster.size) * 2.1), 18, 29);
    const radius = screenUnits(radiusPx);
    const selected = cluster.selected;
    const first = cluster.members[0].actor;
    const group = svgEl('g', {
        class: `point cluster-point${selected ? ' is-selected' : ''}`,
        transform: `translate(${cluster.point.x}, ${cluster.point.y})`,
        tabindex: 0,
        role: 'button',
        'aria-label': `${cluster.size} actors near ${first.home?.region || first.spot?.name || 'this area'}`
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
        style: `font-size:${screenUnits(clamp(12 + Math.log2(cluster.size) * 0.55, 12, 16))}px`
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
        breakdown.textContent = phaseCounts.map(([key, count]) => `${key} ${count}`).join(' · ');
        group.appendChild(breakdown);
    }
    els.pointsLayer.appendChild(group);
}

function renderPoints() {
    els.pointsLayer.innerHTML = '';
    if (!state.snapshot) return;

    const visible = filteredActors();
    const clusters = clusterActors(visible);
    clusters.forEach((cluster) => cluster.size === 1 ? renderSinglePoint(cluster) : renderCluster(cluster));
    els.visibleCount.textContent = state.clusterScope
        ? `${visible.length.toLocaleString()} in cluster · ${clusters.length.toLocaleString()} groups`
        : `${visible.length.toLocaleString()} shown · ${clusters.length.toLocaleString()} groups`;
}

function renderFilterCounts() {
    const items = actors().filter((actor) => !state.search || actorSearchText(actor).includes(state.search));
    const counts = {
        all: items.length,
        hot: items.filter((actor) => actor.phase === 'hot').length,
        warm: items.filter((actor) => actor.phase === 'warm').length,
        cold: items.filter((actor) => actor.phase === 'cold').length,
        players: items.filter((actor) => actor.kind === 'player').length
    };
    Object.entries(counts).forEach(([key, value]) => {
        const count = els.filterStrip.querySelector(`[data-count-for="${key}"]`);
        if (count) count.textContent = value.toLocaleString();
    });
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
            <span class="phase-label"><i class="legend-dot ${phase}"></i>${phase}</span>
            <div class="population-track"><div class="population-fill ${phase}" style="width:${width}%"></div></div>
            <strong>${count.toLocaleString()}</strong>
        </div>`;
    }).join('');
}

function displayActivity(actor) {
    if (actor.kind === 'player') return actor.online ? 'online' : 'offline';
    return actor.intent || actor.mode || 'idle';
}

function renderRoster() {
    const phaseRank = { hot: 0, warm: 1, cold: 2, player: 3 };
    const list = filteredActors()
        .sort((a, b) => (phaseRank[a.phase] ?? 9) - (phaseRank[b.phase] ?? 9) || Number(b.level || 0) - Number(a.level || 0) || String(a.name).localeCompare(String(b.name)))
        .slice(0, 90);
    els.actorList.innerHTML = list.length ? list.map((actor) => `
        <button class="actor-row${String(actor.id) === String(state.selectedId?.id) ? ' is-selected' : ''}" type="button" data-roster-id="${escapeHtml(actor.id)}" data-roster-kind="${actor.kind}">
            <span class="phase-dot" style="background:${phaseColor(actor)}"></span>
            <span class="actor-main">
                <strong>${text(actor.isPk ? `PK ${actor.name}` : actor.name)}</strong>
                <span>${text(actor.kind === 'player' ? displayActivity(actor) : `${actor.phase} · ${actor.role || 'dps'} · ${displayActivity(actor)}`)} · Lv ${number(actor.level, '?')}</span>
            </span>
            <span class="actor-loc">${text(actor.home?.region || actor.spot?.name || '')}</span>
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

function statCell(label, value) {
    return `<div class="stat-cell"><span>${text(label)}</span><strong>${number(value)}</strong></div>`;
}

function vitalBar(label, vital, color) {
    const pct = clamp(Number(vital?.[`${label.toLowerCase()}Pct`] || 0), 0, 100);
    return `<div class="vital-row"><span>${label}</span><div class="vital-track"><div class="vital-fill" style="width:${pct}%;background:${color}"></div></div><strong>${pct}%</strong></div>`;
}

function renderEquipment(equipment, combat) {
    if (!equipment) return '';
    const items = equipment.equipped || [];
    const totals = equipment.totals || combat || {};
    return `<section class="inspector-block">
        <div class="inspector-block-title"><h3>Equipped</h3><span>${items.length} items</span></div>
        <div class="combat-stats">
            ${statCell('P. Atk', totals.pAtk)}
            ${statCell('M. Atk', totals.mAtk)}
            ${statCell('P. Def', totals.pDef)}
            ${statCell('M. Def', totals.mDef)}
        </div>
        <div class="equipment-list">${items.length ? items.map((item) => `
            <div class="equipment-row">
                <span class="equipment-slot">${text(item.slot)}</span>
                <strong>${text(item.name)}</strong>
                <span class="equipment-rank">${text(item.rank, '—')}</span>
            </div>
        `).join('') : '<div class="list-empty">No equipment snapshot</div>'}</div>
    </section>`;
}

function renderBuild(build) {
    if (!build) return '';
    const gear = build.exampleGear?.length ? build.exampleGear.join(' · ') : `${build.armor || '—'} · ${build.weapon || '—'}`;
    return `<section class="inspector-block">
        <div class="inspector-block-title"><h3>Build</h3><span>${text(build.grade || build.classFamily || '')}</span></div>
        <p class="build-line"><strong>${text(build.armor || '—')}</strong> armor · <strong>${text(build.weapon || '—')}</strong> weapon</p>
        <p class="muted-copy">${text(build.playstyle || gear)}</p>
        ${build.statPriority?.length ? `<div class="priority-line">Priority <strong>${text(build.statPriority.join(' · '))}</strong></div>` : ''}
    </section>`;
}

function renderAction(actor) {
    const decision = actor.decisions?.combat || actor.decisions?.hunt || actor.decisions?.role || actor.roleDecision;
    const plan = actor.plan;
    const target = actor.target?.name || actor.target?.id || actor.spot?.name || actor.spot?.id;
    const secondary = actor.travel?.reason
        ? `${actor.travel.reason} → ${actor.travel.townName || 'field'}`
        : plan?.next?.npcName
            ? `${plan.next.npcName} at ${plan.next.spotId || 'next spot'}`
            : target
                ? `near ${target}`
                : actor.blockers?.[0] || 'no active target';
    return `<div class="activity-callout">
        <span>Doing now</span>
        <strong>${text(actor.intent || actor.mode || 'idle')}</strong>
        <p>${text(decision?.action || decisionReason(decision) || secondary)}</p>
    </div>`;
}

function readableDecisionValue(value) {
    if (value === null || value === undefined || value === '') return null;
    if (Array.isArray(value)) return value.map(readableDecisionValue).filter(Boolean).join(' · ') || null;
    if (typeof value !== 'object') return String(value);
    const preferred = ['message', 'reason', 'label', 'action', 'route', 'target', 'spotId', 'code', 'type'];
    for (const key of preferred) {
        const readable = readableDecisionValue(value[key]);
        if (readable) return readable;
    }
    const parts = Object.entries(value)
        .map(([key, entry]) => {
            const readable = typeof entry === 'object' ? null : readableDecisionValue(entry);
            return readable ? `${key} ${readable}` : null;
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
    return `<section class="inspector-block compact-block">
        <div class="inspector-block-title"><h3>Last decision</h3><span>${text(decision.action || 'resolve')}</span></div>
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
        ? (buffs.needsRefresh ? 'refresh needed' : `${buffs.active?.length || 0} active`)
        : null;
    const nearbyText = nearby
        ? `${nearby.realPlayers || 0} players · ${nearby.friendlyBots || 0} bots · ${nearby.attackableNpcs || 0} mobs`
        : null;
    const tradeText = store ? `${store.type || 'store'} · ${store.title || 'open'} · ${store.items || 0} lines` : null;
    const moodText = ambient ? `${ambient.mood || 'neutral'} · ${ambient.intent || 'idle'}` : null;
    return `<section class="inspector-block compact-block">
        <div class="inspector-block-title"><h3>Runtime signals</h3><span>bot info</span></div>
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
        if (state.clusterScope) {
            els.selectedCard.innerHTML = `
                <span class="eyeline">Opened cluster</span>
                <strong>${number(state.clusterScope.actorKeys.size)} actors · ${text(state.clusterScope.label)}</strong>
                <p>Choose a bot from the scoped roster or open a smaller cluster.</p>
                <button class="selection-clear" type="button" data-clear-cluster>All actors</button>
            `;
            return;
        }
        els.selectedCard.innerHTML = '<span class="eyeline">Selection</span><strong>No actor selected</strong><p>Choose a point or cluster to inspect the bot.</p>';
        return;
    }
    const activity = actor.target?.name || actor.spot?.name || actor.intent || actor.mode || 'idle';
    els.selectedCard.innerHTML = `
        <span class="eyeline">Selected ${text(actor.phase || '')}</span>
        <strong>${text(actor.isPk ? `PK ${actor.name}` : actor.name)}</strong>
        <p>Lv ${number(actor.level, '?')} · ${text(actor.role || actor.classFamily || 'bot')} · ${text(activity)}</p>
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
                        ${['hot', 'warm', 'cold', 'players'].filter((phase) => counts[phase]).map((phase) => `<span><i class="legend-dot ${phase === 'players' ? 'player' : phase}"></i>${phase} <strong>${number(counts[phase])}</strong></span>`).join('')}
                    </div>
                    <button class="selection-clear" type="button" data-clear-cluster>Show all actors</button>
                </div>
            `;
            return;
        }
        els.selectedInspector.innerHTML = `<div class="inspector-empty"><span class="empty-glyph">◎</span><strong>Nothing selected</strong><p>Click any bot on the map to see its equipment, current action and runtime status.</p></div>`;
        return;
    }

    if (state.detailLoading && !state.detail) {
        els.inspectorFreshness.textContent = 'loading';
        els.selectedInspector.innerHTML = '<div class="inspector-empty"><span class="loading-orbit"></span><strong>Loading bot info</strong><p>Reading the live status and persisted equipment snapshot.</p></div>';
        return;
    }

    if (state.detailError && !state.detail) {
        els.inspectorFreshness.textContent = 'error';
        els.selectedInspector.innerHTML = `<div class="inspector-empty detail-failure">
            <span class="empty-glyph">!</span>
            <strong>Bot info unavailable</strong>
            <p>${text(state.detailError)} · the compact map snapshot may be incomplete.</p>
            <button class="selection-clear" type="button" data-retry-detail>Retry</button>
        </div>`;
        return;
    }

    const build = actor.build;
    const family = build?.classFamily || (actor.classId ? `class ${actor.classId}` : (actor.kind === 'player' ? 'player' : 'bot'));
    const location = actor.loc ? `${Math.round(actor.loc.locX)}, ${Math.round(actor.loc.locY)}, ${Math.round(actor.loc.locZ || 0)}` : 'unknown';
    const party = actor.party
        ? actor.party.leader?.name
            ? `${actor.party.role || actor.role || 'member'} · leader ${actor.party.leader.name}`
            : `${actor.party.role || actor.role || 'member'} · leader ${actor.party.leaderId || 'unknown'}`
        : 'solo';
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
            <div class="inspector-name"><strong>${text(actor.isPk ? `PK ${actor.name}` : actor.name)}</strong><span>Lv ${number(actor.level, '?')} · ${text(family)} · ${text(actor.role || '—')}</span></div>
            <span class="phase-badge ${text(actor.phase || 'cold')}">${text(actor.phase || 'bot')}</span>
        </div>
        <div class="inspector-vitals">
            ${vitalBar('HP', actor.vitals, '#63d37b')}
            ${vitalBar('MP', actor.vitals, '#57c7e8')}
        </div>
        ${renderAction(actor)}
        <div class="detail-grid">
            <div><span>Mode</span><strong>${text(actor.mode)}</strong></div>
            <div><span>Region</span><strong>${text(actor.region || actor.home?.region)}</strong></div>
            <div><span>Spot</span><strong>${text(actor.spot?.name || actor.spot?.id)}</strong></div>
            <div><span>Party</span><strong>${text(party)}</strong></div>
            <div><span>Position</span><strong>${text(location)}</strong></div>
            <div><span>Blockers</span><strong>${text(actor.blockers?.join(' · '), 'none')}</strong></div>
        </div>
        ${renderSignals(actor)}
        ${actor.equipment || actor.combat ? renderEquipment(actor.equipment, actor.combat) : ''}
        ${renderBuild(build)}
        ${renderDecisions(actor)}
        ${actor.counters ? `<section class="inspector-block compact-block"><div class="inspector-block-title"><h3>Progress</h3><span>${formatRelative(actor.updatedAt)}</span></div><div class="combat-stats">${statCell('Wins', actor.counters.fightsWon)}${statCell('Resolves', actor.counters.fightsResolved)}${statCell('Deaths', actor.counters.deaths)}${statCell('Adena', actor.adena)}</div></section>` : ''}
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
    renderFilterCounts();
    renderPoints();
    renderPopulation();
    renderRoster();
    renderSelected();
}

async function loadBotDetail(id, showLoading = true) {
    if (!id || state.detailLoading) return;
    const requestId = ++state.detailRequest;
    state.detailLoading = showLoading;
    state.detailError = null;
    if (showLoading) renderSelected();
    try {
        const response = await fetch(`/observer/api/bot/${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const detail = await response.json();
        if (requestId !== state.detailRequest || String(state.selectedId?.id) !== String(id)) return;
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

function selectActor(id, kind = 'bot', focus = false) {
    state.selectedId = { id, kind };
    state.detail = null;
    state.detailError = null;
    state.detailLoading = false;
    if (focus) {
        const actor = actorById(id, kind);
        if (actor?.loc) {
            const viewport = state.viewport || { x: 0, y: 0, width: mapMeta().width, height: mapMeta().height };
            const point = worldToMap(actor.loc);
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
    if (kind === 'bot') loadBotDetail(id);
}

function focusCluster(cluster) {
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

    const points = cluster.members.map(({ point }) => point);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const pad = screenUnits(44);
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
    renderRoster();
    renderSelected();
}

function clusterLocation(cluster) {
    const labels = cluster.members
        .map(({ actor }) => actor.home?.region || actor.region || actor.spot?.name)
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

async function refresh() {
    if (!state.live) return;
    try {
        const response = await fetch('/observer/api/snapshot', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.snapshot = await response.json();
        renderSnapshot();
        if (state.selectedId?.kind === 'bot' && !state.detailLoading) loadBotDetail(state.selectedId.id, false);
    } catch (error) {
        els.serverLine.textContent = `Observer snapshot failed: ${error.message}`;
    }
}

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

document.addEventListener('click', (event) => {
    if (event.target.closest('[data-retry-detail]')) {
        if (state.selectedId?.kind === 'bot') loadBotDetail(state.selectedId.id);
        return;
    }
    if (!event.target.closest('[data-clear-cluster]')) return;
    clearClusterScope(true);
});

els.filterStrip.addEventListener('click', (event) => {
    const button = event.target.closest('[data-phase]');
    if (!button) return;
    state.phase = button.dataset.phase;
    els.filterStrip.querySelectorAll('.filter').forEach((item) => item.classList.toggle('is-active', item === button));
    renderPoints();
    renderRoster();
});

els.actorSearch.addEventListener('input', (event) => {
    state.search = String(event.target.value || '').trim().toLowerCase();
    renderFilterCounts();
    renderPoints();
    renderRoster();
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
    if (event.key === '/' && document.activeElement !== els.actorSearch) {
        event.preventDefault();
        els.actorSearch.focus();
    }
    if (event.key === 'Escape' && document.activeElement === els.actorSearch) {
        els.actorSearch.value = '';
        state.search = '';
        renderFilterCounts();
        renderPoints();
        renderRoster();
        els.actorSearch.blur();
        return;
    }
    if (event.key === 'Escape' && state.clusterScope) clearClusterScope(true);
});

refresh();
setInterval(refresh, 2000);
