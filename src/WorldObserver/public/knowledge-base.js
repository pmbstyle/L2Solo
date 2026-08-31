const Router = window.WorldObserverSpaRouter;

const state = {
    meta: null,
    kind: 'items',
    selectedId: null,
    query: '',
    page: 1,
    category: 'all',
    grade: 'all',
    minLevel: 1,
    maxLevel: 99,
    raid: 'all',
    request: 0,
    searchTimer: null
};

const els = {
    rateBadge: document.querySelector('#rateBadge'),
    databaseCounts: document.querySelector('#databaseCounts'),
    itemsTab: document.querySelector('#itemsTab'),
    npcsTab: document.querySelector('#npcsTab'),
    catalogView: document.querySelector('#catalogView'),
    detailView: document.querySelector('#detailView'),
    catalogSearch: document.querySelector('#catalogSearch'),
    npcFilters: document.querySelector('#npcFilters'),
    itemDirectory: document.querySelector('#itemDirectory'),
    itemDirectoryList: document.querySelector('#itemDirectoryList'),
    itemDirectoryReturn: document.querySelector('#itemDirectoryReturn'),
    catalogList: document.querySelector('#catalogList'),
    npcMinLevel: document.querySelector('#npcMinLevel'),
    npcMaxLevel: document.querySelector('#npcMaxLevel'),
    npcRaid: document.querySelector('#npcRaid'),
    resultCount: document.querySelector('#resultCount'),
    resultContext: document.querySelector('#resultContext'),
    catalogResults: document.querySelector('#catalogResults'),
    pagination: document.querySelector('#pagination'),
    loadingTemplate: document.querySelector('#loadingTemplate')
};

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
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toLocaleString() : fallback;
}

function compactNumber(value) {
    const parsed = Number(value || 0);
    if (parsed < 1000) return number(parsed);
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(parsed);
}

function readable(value) {
    return String(value || '')
        .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
        .replaceAll(/[._-]+/g, ' ')
        .replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
}

function chance(value) {
    const parsed = Math.max(0, Number(value || 0));
    if (parsed === 0) return '0%';
    if (parsed < 0.0001) return '<0.0001%';
    if (parsed < 0.01) return `${parsed.toFixed(4).replace(/0+$/, '')}%`;
    if (parsed < 1) return `${parsed.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
    return `${parsed.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

function icon(url, name, className = 'kb-icon') {
    return url
        ? `<img class="${className}" src="${text(url)}" alt="" loading="lazy">`
        : `<span class="${className} kb-icon-placeholder" aria-hidden="true">◇</span>`;
}

function rateLabel(profile) {
    if (!profile) return 'Server rates';
    const values = [profile.drop, profile.spoil, profile.adena];
    const same = values.every((value) => Number(value) === Number(values[0]));
    return same
        ? `${profile.preset || `x${values[0]}`} server rates`
        : `Drop x${profile.drop} · Spoil x${profile.spoil} · Adena x${profile.adena}`;
}

function routeFor(kind = state.kind, id = null) {
    return { name: kind === 'npcs' ? 'knowledge-npcs' : 'knowledge-items', id };
}

function commitRoute(route, { replace = false } = {}) {
    const href = Router.href(route);
    if (`${window.location.pathname}${window.location.search}` === href) return;
    window.history[replace ? 'replaceState' : 'pushState']({}, '', href);
}

function showLoading(target) {
    target.replaceChildren(els.loadingTemplate.content.cloneNode(true));
}

async function requestJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}

function renderMeta() {
    if (!state.meta) return;
    const counts = state.meta.counts || {};
    els.rateBadge.textContent = rateLabel(state.meta.rateProfile);
    els.databaseCounts.innerHTML = `
        <span><b>${compactNumber(counts.items)}</b><small>Items</small></span>
        <span><b>${compactNumber(counts.mobs)}</b><small>NPCs</small></span>
        <span><b>${compactNumber(counts.spawnDefinitions)}</b><small>Spawns</small></span>`;
    els.itemDirectoryList.innerHTML = (state.meta.itemDirectory || []).map(itemDirectoryRow).join('');
}

function gradeLabel(grade, { short = false } = {}) {
    if (grade === 'no-grade') return short ? 'NG' : 'No grade';
    return String(grade || '').toUpperCase();
}

function itemCatalogHref(category = 'all', grade = 'all', query = '') {
    const params = new URLSearchParams();
    if (category !== 'all') params.set('category', category);
    if (grade !== 'all') params.set('grade', grade);
    if (query) params.set('q', query);
    const suffix = params.toString();
    return `${Router.href(routeFor('items'))}${suffix ? `?${suffix}` : ''}`;
}

function itemDirectoryRow(entry, index) {
    const isEquipment = ['weapons', 'armor', 'jewelry'].includes(entry.key);
    const grades = isEquipment ? (entry.grades || []) : [];
    const allHref = itemCatalogHref(entry.key);
    return `<section class="kb-directory-row">
        <span class="kb-directory-index">${String(index + 1).padStart(2, '0')}</span>
        <div class="kb-directory-name"><h3>${text(entry.label)}</h3><p>${text(entry.description)}</p></div>
        <span class="kb-directory-total"><b>${number(entry.total)}</b><small>items</small></span>
        <nav class="kb-grade-nav" aria-label="${text(entry.label)} grades">
            <a href="${text(allHref)}" data-item-category="${text(entry.key)}" data-item-grade="all"><span>All</span><small>${number(entry.total)}</small></a>
            ${grades.map((grade) => `<a href="${itemCatalogHref(entry.key, grade.key)}" data-item-category="${text(entry.key)}" data-item-grade="${text(grade.key)}" title="${text(`${entry.label} · ${gradeLabel(grade.key)}`)}"><span>${text(gradeLabel(grade.key, { short: true }))}</span><small>${number(grade.count)}</small></a>`).join('')}
        </nav>
    </section>`;
}

function setActiveKind(kind) {
    state.kind = kind === 'npcs' ? 'npcs' : 'items';
    els.itemsTab.classList.toggle('is-active', state.kind === 'items');
    els.npcsTab.classList.toggle('is-active', state.kind === 'npcs');
    els.npcFilters.hidden = state.kind !== 'npcs';
    els.resultContext.textContent = state.kind === 'items' ? 'Sorted alphabetically' : 'Grouped by level';
}

function itemRow(item) {
    return `<a class="kb-item-row" href="${Router.href(routeFor('items', item.id))}" data-detail-kind="items" data-detail-id="${item.id}">
        ${icon(item.iconUrl, item.name)}
        <span class="kb-primary"><strong>${text(item.name)}</strong><small>ID ${number(item.id)} · ${text(readable(item.category))}</small></span>
        <span class="kb-cell kb-kind"><b>${text(readable(item.kind))}</b><small>${text(String(item.grade).toUpperCase())}</small></span>
        <span class="kb-cell kb-price"><b>${item.price ? `${number(item.price)} A` : '—'}</b><small>Base price</small></span>
        <span class="kb-cell kb-sources"><b>${number(item.sourceCount)}</b><small>Sources</small></span>
        <span class="kb-chevron">›</span>
    </a>`;
}

function npcRow(npc, previousLevel) {
    const divider = Number(previousLevel) === Number(npc.level) ? '' : `<div class="kb-level-divider"><span>Level ${number(npc.level)}</span></div>`;
    return `${divider}<a class="kb-npc-row" href="${Router.href(routeFor('npcs', npc.id))}" data-detail-kind="npcs" data-detail-id="${npc.id}">
        <span class="kb-level">${number(npc.level)}</span>
        <span class="kb-primary"><strong>${text(npc.name)}</strong><small>ID ${number(npc.id)}${npc.raidBoss ? ' · Raid boss' : ''}</small></span>
        <span class="kb-cell kb-kind">${npc.raidBoss ? '<i class="kb-tag raid">Raid</i>' : `<b>${text(readable(npc.aiType || npc.kind))}</b>`}<small>${npc.knownReachable ? 'Known in world' : 'No known route'}</small></span>
        <span class="kb-cell kb-rewards"><b>${number(npc.dropCount)} drop · ${number(npc.spoilCount)} spoil</b><small>Reward entries</small></span>
        <span class="kb-cell kb-spawns"><b>${number(npc.spawnCount)}</b><small>Spawn groups</small></span>
        <span class="kb-chevron">›</span>
    </a>`;
}

function renderPagination(data) {
    if (data.pages <= 1) {
        els.pagination.innerHTML = '';
        return;
    }
    const page = Number(data.page);
    const pages = Number(data.pages);
    const visible = [...new Set([1, page - 1, page, page + 1, pages].filter((value) => value >= 1 && value <= pages))];
    let previous = 0;
    const buttons = [];
    buttons.push(`<button data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Previous page">←</button>`);
    visible.forEach((value) => {
        if (previous && value - previous > 1) buttons.push('<button disabled aria-hidden="true">…</button>');
        buttons.push(`<button class="${value === page ? 'is-active' : ''}" data-page="${value}" aria-label="Page ${value}" ${value === page ? 'aria-current="page"' : ''}>${value}</button>`);
        previous = value;
    });
    buttons.push(`<button data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Next page">→</button>`);
    els.pagination.innerHTML = buttons.join('');
}

function catalogUrl() {
    const params = new URLSearchParams({ q: state.query, page: state.page, limit: 60 });
    if (state.kind === 'items') {
        params.set('category', state.category);
        params.set('grade', state.grade);
    } else {
        params.set('minLevel', state.minLevel);
        params.set('maxLevel', state.maxLevel);
        params.set('raid', state.raid);
    }
    return `/observer/api/knowledge/${state.kind}?${params}`;
}

function itemDirectoryEntry(category = state.category) {
    return (state.meta?.itemDirectory || []).find((entry) => entry.key === category) || null;
}

function itemResultContext() {
    if (state.query) return `Search across every item · “${state.query}”`;
    const category = itemDirectoryEntry();
    if (!category) return 'Sorted alphabetically';
    return `${category.label}${state.grade === 'all' ? '' : ` · ${gradeLabel(state.grade)}`}`;
}

function showItemDirectory() {
    state.request += 1;
    els.catalogView.hidden = false;
    els.detailView.hidden = true;
    els.itemDirectory.hidden = false;
    els.catalogList.hidden = true;
    els.itemDirectoryReturn.hidden = true;
    document.title = 'Items · Server Database';
}

function shouldShowItemDirectory() {
    return state.kind === 'items' && !state.query && state.category === 'all' && state.grade === 'all';
}

function refreshCatalogView() {
    if (shouldShowItemDirectory()) showItemDirectory();
    else loadCatalog();
}

async function loadCatalog() {
    const request = ++state.request;
    els.catalogView.hidden = false;
    els.detailView.hidden = true;
    els.itemDirectory.hidden = true;
    els.catalogList.hidden = false;
    els.itemDirectoryReturn.hidden = state.kind !== 'items';
    showLoading(els.catalogResults);
    els.pagination.innerHTML = '';
    try {
        const data = await requestJson(catalogUrl());
        if (request !== state.request) return;
        els.rateBadge.textContent = rateLabel(data.rateProfile);
        const resultLabel = state.kind === 'items'
            ? (data.total === 1 ? 'item' : 'items')
            : (data.total === 1 ? 'NPC' : 'NPCs');
        els.resultCount.textContent = `${number(data.total)} ${resultLabel}`;
        els.resultContext.textContent = state.kind === 'items' ? itemResultContext() : 'Grouped by level';
        if (!data.items.length) {
            els.catalogResults.innerHTML = '<div class="kb-empty">Nothing matches these filters.</div>';
        } else if (state.kind === 'items') {
            els.catalogResults.innerHTML = data.items.map(itemRow).join('');
        } else {
            let previousLevel = null;
            els.catalogResults.innerHTML = data.items.map((npc) => {
                const row = npcRow(npc, previousLevel);
                previousLevel = npc.level;
                return row;
            }).join('');
        }
        renderPagination(data);
    } catch (error) {
        if (request !== state.request) return;
        els.catalogResults.innerHTML = `<div class="kb-error">Could not load the database: ${text(error.message)}</div>`;
        els.resultCount.textContent = 'Database unavailable';
    }
}

function statGrid(entries) {
    const normalized = entries.filter(([, value]) => value !== null && value !== undefined && value !== '' && Number(value) !== 0);
    return normalized.length ? `<div class="kb-stat-grid">${normalized.map(([label, value]) => `
        <div class="kb-stat"><span>${text(label)}</span><strong>${typeof value === 'number' ? number(value) : text(value)}</strong></div>`).join('')}</div>` : '<div class="kb-empty">No additional values.</div>';
}

function rewardRows(groups) {
    const items = (groups || []).flatMap((group) => group.items || []);
    if (!items.length) return '<div class="kb-empty">No entries in this table.</div>';
    return `<div class="kb-reward-list">${items.map((item) => `
        <a class="kb-reward" href="${Router.href(routeFor('items', item.itemId))}" data-detail-kind="items" data-detail-id="${item.itemId}">
            ${icon(item.iconUrl, item.name)}
            <strong>${text(item.name)}</strong>
            <span class="amount">${number(item.minAmount)}${Number(item.maxAmount) !== Number(item.minAmount) ? `–${number(item.maxAmount)}` : ''}</span>
            <span class="chance">${chance(item.chancePercent)}</span>
        </a>`).join('')}</div>`;
}

function sourceRows(items) {
    if (!items?.length) return '<div class="kb-empty">No known server sources.</div>';
    return `<div class="kb-reward-list">${items.map((npc) => `
        <a class="kb-source" href="${Router.href(routeFor('npcs', npc.id))}" data-detail-kind="npcs" data-detail-id="${npc.id}">
            <span class="kb-level">${number(npc.level)}</span>
            <span class="kb-primary"><strong>${text(npc.name)}</strong><small>ID ${number(npc.id)} · ${npc.spawnCount ? `${number(npc.spawnCount)} spawn groups` : 'no direct spawn'}</small></span>
            <span class="chance">${chance(npc.chancePercent)}</span>
            <span class="kb-cell"><b>${number(Math.round(Number(npc.expectedAmountPerKill || 0)))}</b><small>Expected / kill</small></span>
            <span class="kb-chevron">›</span>
        </a>`).join('')}</div>`;
}

function renderItemDetail(item) {
    const stats = item.stats || {};
    const template = item.template || {};
    return `
        <a class="kb-detail-return" href="${Router.href(routeFor('items'))}" data-catalog-kind="items">← All items</a>
        <header class="kb-detail-hero">
            ${icon(item.iconUrl, item.name, 'kb-detail-icon')}
            <div><span class="kb-detail-id">ITEM · ${number(item.id)}</span><h2>${text(item.name)}</h2><p>${text(readable(item.kind))} · ${text(String(item.grade).toUpperCase())}</p></div>
        </header>
        <div class="kb-detail-layout">
            <div>
                <section class="kb-section"><h3>Properties</h3>${statGrid([
                    ['Grade', String(item.grade).toUpperCase()], ['Type', readable(item.kind)], ['Base price', template.price ? `${number(template.price)} Adena` : '—'],
                    ['Weight', template.mass], ['Crystals', template.crystals], ['Soulshots', template.soulshot], ['Spiritshots', template.spiritshot]
                ])}</section>
                <section class="kb-section"><h3>Combat stats</h3>${statGrid(Object.entries(stats).map(([key, value]) => [readable(key), value]))}</section>
            </div>
            <div>
                <section class="kb-section"><h3>Dropped by · ${text(rateLabel(item.rateProfile))}</h3>${sourceRows(item.sources?.drops)}</section>
                <section class="kb-section"><h3>Spoiled from · ${text(rateLabel(item.rateProfile))}</h3>${sourceRows(item.sources?.spoils)}</section>
            </div>
        </div>`;
}

function npcRelations(title, items) {
    if (!items?.length) return '';
    return `<section class="kb-section"><h3>${text(title)}</h3><div class="kb-level-links">${items.map((npc) => `
        <a href="${Router.href(routeFor('npcs', npc.id))}" data-detail-kind="npcs" data-detail-id="${npc.id}">Lv ${number(npc.level)} · ${text(npc.name)}</a>`).join('')}</div></section>`;
}

function renderNpcDetail(npc) {
    const stats = npc.stats || {};
    const progression = npc.progression || {};
    const mapPoints = (npc.spawns || []).reduce((sum, spawn) => sum + Number(spawn.mapPoints?.length || 0), 0);
    return `
        <a class="kb-detail-return" href="${Router.href(routeFor('npcs'))}" data-catalog-kind="npcs">← All NPCs</a>
        <header class="kb-detail-hero">
            <span class="kb-detail-icon kb-icon-placeholder kb-level">${number(npc.level)}</span>
            <div><span class="kb-detail-id">NPC · ${number(npc.id)}</span><h2>${text(npc.name)}</h2><p>${npc.raidBoss ? 'Raid boss' : text(readable(npc.kind))} · Level ${number(npc.level)}${npc.title ? ` · ${text(npc.title)}` : ''}</p></div>
            ${mapPoints ? `<a class="kb-map-link" href="${Router.href({ name: 'world', npcId: npc.id })}"><svg aria-hidden="true"><use href="/observer/ui-icons.svg#map"></use></svg>Show ${number(mapPoints)} locations on map</a>` : '<span class="kb-tag">No mapped spawn</span>'}
        </header>
        <div class="kb-detail-layout">
            <div>
                <section class="kb-section"><h3>Creature</h3>${statGrid([
                    ['Level', npc.level], ['Race', readable(npc.race)], ['AI', readable(npc.aiType)], ['Hostile', npc.hostile ? 'Yes' : 'No'],
                    ['Undead', npc.undead ? 'Yes' : 'No'], ['EXP', progression.baseExp], ['SP', progression.baseSp], ['Spawn groups', npc.spawnCount]
                ])}</section>
                <section class="kb-section"><h3>Effective stats</h3>${statGrid([
                    ['HP', stats.maxHp], ['MP', stats.maxMp], ['P. Atk', stats.pAtk], ['M. Atk', stats.mAtk], ['P. Def', stats.pDef], ['M. Def', stats.mDef],
                    ['Accuracy', stats.accuracy], ['Evasion', stats.evasion], ['Atk. Speed', stats.attackSpeed], ['Cast Speed', stats.castSpeed], ['Run Speed', stats.runSpeed]
                ])}</section>
                ${npc.skills?.length ? `<section class="kb-section"><h3>Skills</h3><div class="kb-level-links">${npc.skills.map((skill) => `<span class="kb-tag">${text(skill.name)} · Lv ${number(skill.level)}</span>`).join('')}</div></section>` : ''}
                ${npcRelations('Raid minions', npc.minions)}
                ${npcRelations('Minion of', npc.minionOf)}
            </div>
            <div>
                <section class="kb-section"><h3>Drop · ${text(rateLabel(npc.rateProfile))}</h3>${rewardRows(npc.drops)}</section>
                <section class="kb-section"><h3>Spoil · ${text(rateLabel(npc.rateProfile))}</h3>${rewardRows(npc.spoils)}</section>
            </div>
        </div>`;
}

async function loadDetail(kind, id) {
    const request = ++state.request;
    state.selectedId = Number(id);
    els.catalogView.hidden = true;
    els.detailView.hidden = false;
    showLoading(els.detailView);
    try {
        const detail = await requestJson(`/observer/api/knowledge/${kind}/${Number(id)}`);
        if (request !== state.request) return;
        els.rateBadge.textContent = rateLabel(detail.rateProfile);
        els.detailView.innerHTML = kind === 'items' ? renderItemDetail(detail) : renderNpcDetail(detail);
        document.title = `${detail.name} · Server Database`;
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
        if (request !== state.request) return;
        els.detailView.innerHTML = `<a class="kb-detail-return" href="${Router.href(routeFor(kind))}" data-catalog-kind="${kind}">← Back to catalog</a><div class="kb-error">Could not load this entry: ${text(error.message)}</div>`;
    }
}

function applyRoute(route = Router.parse(`${window.location.pathname}${window.location.search}`)) {
    if (!['knowledge-items', 'knowledge-npcs'].includes(route.name)) {
        window.location.assign('/observer/database/items');
        return;
    }
    const kind = route.name === 'knowledge-npcs' ? 'npcs' : 'items';
    setActiveKind(kind);
    if (route.id) {
        loadDetail(kind, route.id);
        return;
    }
    state.selectedId = null;
    if (kind === 'items') {
        const params = new URLSearchParams(window.location.search);
        const requestedCategory = params.get('category') || 'all';
        const directoryEntry = itemDirectoryEntry(requestedCategory);
        const requestedGrade = params.get('grade') || 'all';
        const validGrade = requestedGrade === 'all' || directoryEntry?.grades?.some((grade) => grade.key === requestedGrade);
        state.query = String(params.get('q') || '').trim();
        state.category = state.query ? 'all' : (directoryEntry ? requestedCategory : 'all');
        state.grade = state.query ? 'all' : (validGrade ? requestedGrade : 'all');
        state.page = 1;
        els.catalogSearch.value = state.query;
    }
    document.title = `${kind === 'items' ? 'Items' : 'NPCs'} · Server Database`;
    refreshCatalogView();
}

function openCatalog(kind, { updateRoute = true } = {}) {
    setActiveKind(kind);
    state.selectedId = null;
    state.page = 1;
    if (kind === 'items') {
        state.query = '';
        state.category = 'all';
        state.grade = 'all';
        els.catalogSearch.value = '';
    }
    if (updateRoute) commitRoute(routeFor(kind));
    document.title = `${kind === 'items' ? 'Items' : 'NPCs'} · Server Database`;
    refreshCatalogView();
}

function scheduleCatalogReload({ syncRoute = false } = {}) {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
        state.page = 1;
        if (syncRoute && state.kind === 'items') {
            const href = itemCatalogHref(state.category, state.grade, state.query);
            if (`${window.location.pathname}${window.location.search}` !== href) {
                window.history.replaceState({}, '', href);
            }
        }
        refreshCatalogView();
    }, 180);
}

document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-kind]');
    if (tab) {
        event.preventDefault();
        openCatalog(tab.dataset.kind);
        return;
    }
    const itemBranch = event.target.closest('[data-item-category]');
    if (itemBranch) {
        event.preventDefault();
        state.kind = 'items';
        state.query = '';
        state.category = itemBranch.dataset.itemCategory || 'all';
        state.grade = itemBranch.dataset.itemGrade || 'all';
        state.page = 1;
        els.catalogSearch.value = '';
        const href = itemCatalogHref(state.category, state.grade);
        if (`${window.location.pathname}${window.location.search}` !== href) {
            window.history.pushState({}, '', href);
        }
        loadCatalog();
        return;
    }
    const itemDirectory = event.target.closest('[data-item-directory]');
    if (itemDirectory) {
        event.preventDefault();
        openCatalog('items');
        return;
    }
    const detail = event.target.closest('[data-detail-kind]');
    if (detail) {
        event.preventDefault();
        const kind = detail.dataset.detailKind;
        const id = Number(detail.dataset.detailId);
        setActiveKind(kind);
        commitRoute(routeFor(kind, id));
        loadDetail(kind, id);
        return;
    }
    const catalog = event.target.closest('[data-catalog-kind]');
    if (catalog) {
        event.preventDefault();
        openCatalog(catalog.dataset.catalogKind);
    }
});

els.catalogSearch.addEventListener('input', (event) => {
    state.query = String(event.target.value || '').trim();
    if (state.kind === 'items' && state.query) {
        state.category = 'all';
        state.grade = 'all';
    }
    scheduleCatalogReload({ syncRoute: true });
});
els.npcMinLevel.addEventListener('input', (event) => { state.minLevel = Number(event.target.value || 1); scheduleCatalogReload(); });
els.npcMaxLevel.addEventListener('input', (event) => { state.maxLevel = Number(event.target.value || 99); scheduleCatalogReload(); });
els.npcRaid.addEventListener('change', (event) => { state.raid = event.target.value; scheduleCatalogReload(); });
els.pagination.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (!button || button.disabled) return;
    state.page = Number(button.dataset.page || 1);
    loadCatalog();
    window.scrollTo({ top: els.catalogView.offsetTop - 80, behavior: 'smooth' });
});

document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        event.preventDefault();
        if (!els.catalogView.hidden) els.catalogSearch.focus();
    }
});
window.addEventListener('popstate', () => applyRoute());

(async function init() {
    try {
        state.meta = await requestJson('/observer/api/knowledge/meta');
        renderMeta();
        applyRoute();
    } catch (error) {
        els.catalogResults.innerHTML = `<div class="kb-error">Could not open the server database: ${text(error.message)}</div>`;
        els.resultCount.textContent = 'Database unavailable';
    }
}());
