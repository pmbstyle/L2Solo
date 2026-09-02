const marketState = {
    data: null,
    loading: false,
    live: true,
    query: '',
    side: 'all',
    town: 'all',
    source: 'all',
    sort: 'activity',
    selectedId: null,
    history: null,
    historyRange: '24h',
    historyItemId: null,
    historyLoadedAt: 0,
    historyRequest: 0,
    timer: null
};

const marketEls = {
    freshness: document.querySelector('#marketFreshness'),
    wts: document.querySelector('#marketPageWts'),
    wtb: document.querySelector('#marketPageWtb'),
    sellUnits: document.querySelector('#marketPageSellUnits'),
    buyUnits: document.querySelector('#marketPageBuyUnits'),
    trades: document.querySelector('#marketPageTrades'),
    volume: document.querySelector('#marketPageVolume'),
    tradeUnits: document.querySelector('#marketPageTradeUnits'),
    volumeScope: document.querySelector('#marketPageVolumeScope'),
    search: document.querySelector('#marketSearch'),
    sideTabs: document.querySelector('#marketSideTabs'),
    town: document.querySelector('#marketTown'),
    source: document.querySelector('#marketSource'),
    sort: document.querySelector('#marketSort'),
    resultCount: document.querySelector('#marketResultCount'),
    body: document.querySelector('#marketTableBody'),
    detail: document.querySelector('#marketItemDetail'),
    towns: document.querySelector('#marketTownRows'),
    recent: document.querySelector('#marketTradeRows'),
    historyTitle: document.querySelector('#marketHistoryTitle'),
    historyMeta: document.querySelector('#marketHistoryMeta'),
    historyVwap: document.querySelector('#marketHistoryVwap'),
    historyMedian: document.querySelector('#marketHistoryMedian'),
    historyPriceRange: document.querySelector('#marketHistoryRange'),
    historyVolume: document.querySelector('#marketHistoryVolume'),
    rangeTabs: document.querySelector('#marketRangeTabs'),
    chart: document.querySelector('#marketChartShell'),
    liveToggle: document.querySelector('#marketLiveToggle'),
    liveLabel: document.querySelector('#marketLiveToggle .live-label')
};

function escapeMarketHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function marketNumber(value, fallback = '—') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toLocaleString() : fallback;
}

function compactMarketNumber(value) {
    const amount = Math.max(0, Number(value || 0));
    if (amount < 1000) return amount.toLocaleString();
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: amount < 10000 ? 1 : 0 }).format(amount);
}

function relativeMarketTime(timestamp) {
    if (!timestamp) return 'not updated';
    const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp)) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    return `${Math.round(seconds / 60)}m ago`;
}

function marketSourceLabel(source) {
    return ({ player: 'Online player', afk_player: 'AFK player', bot: 'Dynamic bot', fixed: 'Fixed trader' })[source] || source;
}

function itemIcon(item, className = 'market-item-icon') {
    return item?.iconUrl
        ? `<img class="${className}" src="${escapeMarketHtml(item.iconUrl)}" alt="" loading="lazy">`
        : `<span class="${className} is-fallback">${escapeMarketHtml(String(item?.name || '?').slice(0, 1).toUpperCase())}</span>`;
}

function filteredMarketItems() {
    const query = marketState.query.trim().toLowerCase();
    const rows = (marketState.data?.items || []).filter((item) => {
        if (query && !String(item.name || '').toLowerCase().includes(query) && !String(item.selfId).includes(query)) return false;
        if (marketState.side === 'wts' && Number(item.wts?.units || 0) <= 0) return false;
        if (marketState.side === 'wtb' && Number(item.wtb?.units || 0) <= 0) return false;
        if (marketState.side === 'demand' && Number(item.demand?.units || 0) <= 0) return false;
        if (marketState.town !== 'all' && !(item.towns || []).includes(marketState.town)) return false;
        if (marketState.source !== 'all' && !(item.sources || []).includes(marketState.source)) return false;
        return true;
    });
    const sorters = {
        activity: (left, right) => (
            Number(right.wts?.organicUnits || 0) + Number(right.wtb?.organicUnits || 0) + Number(right.demand?.fundedUnits || 0) + Number(right.trades || 0)
            - Number(left.wts?.organicUnits || 0) - Number(left.wtb?.organicUnits || 0) - Number(left.demand?.fundedUnits || 0) - Number(left.trades || 0)
        ),
        demand: (left, right) => Number(right.demand?.fundedUnits || 0) - Number(left.demand?.fundedUnits || 0),
        traded: (left, right) => Number(right.tradedAdena || 0) - Number(left.tradedAdena || 0),
        ask: (left, right) => Number(left.wts?.minPrice || Number.MAX_SAFE_INTEGER) - Number(right.wts?.minPrice || Number.MAX_SAFE_INTEGER),
        bid: (left, right) => Number(right.wtb?.maxPrice || 0) - Number(left.wtb?.maxPrice || 0),
        name: (left, right) => String(left.name).localeCompare(String(right.name))
    };
    return rows.sort((left, right) => sorters[marketState.sort](left, right) || String(left.name).localeCompare(String(right.name)));
}

function renderMarketSummary() {
    const summary = marketState.data?.summary || {};
    const week = marketState.data?.history?.windows?.week || summary;
    marketEls.wts.textContent = marketNumber(summary.wtsStores);
    marketEls.wtb.textContent = marketNumber(summary.wtbStores);
    marketEls.sellUnits.textContent = `${compactMarketNumber(summary.sellUnits)} units listed`;
    marketEls.buyUnits.textContent = `${compactMarketNumber(summary.buyUnits)} units wanted`;
    marketEls.trades.textContent = compactMarketNumber(week.trades);
    marketEls.volume.textContent = compactMarketNumber(week.adena ?? summary.tradedAdena);
    marketEls.tradeUnits.textContent = `${compactMarketNumber(week.units || 0)} units exchanged`;
    marketEls.volumeScope.textContent = marketState.data?.historyScope === 'persistent_90d' ? 'persistent Adena turnover' : 'runtime Adena turnover';
    const scope = marketState.data?.historyScope === 'persistent_90d' ? '90-day persistent journal' : 'runtime trade history';
    marketEls.freshness.textContent = `Active stores across players and bots · refreshed ${relativeMarketTime(marketState.data?.generatedAt)} · ${scope}`;
}

function renderMarketTownOptions() {
    const towns = Object.keys(marketState.data?.byTown || {}).sort();
    const value = marketState.town;
    marketEls.town.innerHTML = `<option value="all">All towns</option>${towns.map((town) => `<option value="${escapeMarketHtml(town)}">${escapeMarketHtml(town)}</option>`).join('')}`;
    marketEls.town.value = towns.includes(value) ? value : 'all';
    marketState.town = marketEls.town.value;
}

function renderMarketTable() {
    const rows = filteredMarketItems();
    marketEls.resultCount.textContent = `${marketNumber(rows.length, '0')} item${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) {
        marketEls.body.innerHTML = '<tr><td colspan="7" class="list-empty">No items match these filters.</td></tr>';
        renderMarketDetail();
        return;
    }
    if (!rows.some((item) => Number(item.selfId) === Number(marketState.selectedId))) marketState.selectedId = rows[0].selfId;
    marketEls.body.innerHTML = rows.map((item) => {
        const funded = Number(item.demand?.fundedUnits || 0);
        const selected = Number(item.selfId) === Number(marketState.selectedId);
        return `<tr class="market-item-row${selected ? ' is-selected' : ''}" data-market-item="${Number(item.selfId)}" tabindex="0">
            <td><div class="market-item-cell">${itemIcon(item)}<span><strong>${escapeMarketHtml(item.name)}</strong><small>#${Number(item.selfId)} · ${escapeMarketHtml(item.grade || item.category || 'Item')}</small></span></div></td>
            <td><strong>${marketNumber(item.wts?.organicUnits || 0)}</strong><small>${item.wts?.fixedUnits ? `${marketNumber(item.wts.fixedUnits)} fixed · ` : ''}${marketNumber(item.wts?.stores || 0)} stores</small></td>
            <td class="market-price ask">${item.wts?.minPrice ? `${marketNumber(item.wts.minPrice)} A` : '—'}</td>
            <td><strong>${marketNumber(item.demand?.units || 0)}</strong><small>${funded ? `${marketNumber(funded)} funded` : `${marketNumber(item.demand?.bots || 0)} plans`} · ${marketNumber(item.wtb?.organicUnits || 0)} bid</small></td>
            <td class="market-price bid">${item.wtb?.maxPrice ? `${marketNumber(item.wtb.maxPrice)} A` : '—'}</td>
            <td><strong>${marketNumber(item.trades || 0)}</strong><small>${marketNumber(item.tradedUnits || 0)} units</small></td>
            <td class="market-price">${item.tradedAdena ? `${compactMarketNumber(item.tradedAdena)} A` : '—'}</td>
        </tr>`;
    }).join('');
    renderMarketDetail();
}

function selectedMarketItem() {
    return (marketState.data?.items || []).find((item) => Number(item.selfId) === Number(marketState.selectedId)) || null;
}

function selectedOffers(item) {
    return (marketState.data?.stores || []).flatMap((store) => (
        store.items.filter((line) => Number(line.selfId) === Number(item.selfId)).map((line) => ({ store, line }))
    )).sort((left, right) => (
        Number(left.store.storeType) - Number(right.store.storeType)
        || (left.store.side === 'wts' ? Number(left.line.price) - Number(right.line.price) : Number(right.line.price) - Number(left.line.price))
    ));
}

function marketHistoryPrice(value) {
    return value === null || value === undefined ? '—' : `${marketNumber(Math.round(Number(value)))} A`;
}

function marketHistoryTime(timestamp) {
    const date = new Date(Number(timestamp));
    return marketState.historyRange === '7d'
        ? date.toLocaleDateString([], { month: 'short', day: 'numeric' })
        : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function marketChartSegments(rows, xFor, yFor, key, bucketMs) {
    const segments = [];
    let current = [];
    rows.forEach((row, index) => {
        const previous = rows[index - 1];
        if (previous && Number(row.at) - Number(previous.at) > Number(bucketMs) * 1.8) {
            if (current.length) segments.push(current);
            current = [];
        }
        if (Number.isFinite(Number(row[key]))) current.push(`${xFor(row).toFixed(1)},${yFor(row[key]).toFixed(1)}`);
    });
    if (current.length) segments.push(current);
    return segments;
}

function renderMarketHistory() {
    const history = marketState.history;
    const item = selectedMarketItem();
    if (!history || !item || Number(history.selfId) !== Number(item.selfId)) return;
    const summary = history.summary || {};
    marketEls.historyTitle.textContent = `${item.name} price history`;
    marketEls.historyMeta.textContent = `${marketState.historyRange} · ${history.bucketMs >= 24 * 60 * 60 * 1000 ? 'daily' : 'hourly'} buckets · ${marketNumber(summary.trades || 0)} trades`;
    marketEls.historyVwap.textContent = marketHistoryPrice(summary.vwap);
    marketEls.historyMedian.textContent = marketHistoryPrice(summary.median);
    marketEls.historyPriceRange.textContent = summary.low === null || summary.low === undefined ? '—' : `${compactMarketNumber(summary.low)}–${compactMarketNumber(summary.high)} A`;
    marketEls.historyVolume.textContent = `${compactMarketNumber(summary.units || 0)} units`;

    const rows = (history.buckets || []).filter((row) => Number.isFinite(Number(row.vwap)));
    if (!rows.length) {
        marketEls.chart.innerHTML = '<div class="market-chart-empty">No completed trades for this item in the selected range.</div>';
        return;
    }

    const width = 1000;
    const height = 280;
    const left = 58;
    const right = 18;
    const top = 16;
    const bottom = 45;
    const plotBottom = height - bottom;
    const plotWidth = width - left - right;
    const plotHeight = plotBottom - top;
    const prices = rows.flatMap((row) => [row.low, row.high, row.vwap, row.median]).map(Number).filter(Number.isFinite);
    let low = Math.min(...prices);
    let high = Math.max(...prices);
    const padding = Math.max(1, (high - low) * 0.1, high * 0.015);
    low = Math.max(0, low - padding);
    high += padding;
    const span = Math.max(1, high - low);
    const from = Number(history.from);
    const to = Number(history.to);
    const xFor = (row) => left + Math.max(0, Math.min(1, (Number(row.at) + Number(history.bucketMs) / 2 - from) / Math.max(1, to - from))) * plotWidth;
    const yFor = (price) => top + (high - Number(price)) / span * plotHeight;
    const maxUnits = Math.max(1, ...rows.map((row) => Number(row.units || 0)));
    const barWidth = Math.max(3, Math.min(28, plotWidth / Math.max(1, rows.length) * 0.6));
    const grid = Array.from({ length: 5 }, (_, index) => {
        const ratio = index / 4;
        const y = top + ratio * plotHeight;
        const price = high - ratio * span;
        return `<line class="chart-grid" x1="${left}" y1="${y.toFixed(1)}" x2="${width - right}" y2="${y.toFixed(1)}"></line><text class="chart-label" x="${left - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end">${escapeMarketHtml(compactMarketNumber(Math.round(price)))}</text>`;
    }).join('');
    const ticks = Array.from({ length: 5 }, (_, index) => {
        const ratio = index / 4;
        const x = left + ratio * plotWidth;
        const timestamp = from + ratio * (to - from);
        return `<text class="chart-label" x="${x.toFixed(1)}" y="${height - 13}" text-anchor="middle">${escapeMarketHtml(marketHistoryTime(timestamp))}</text>`;
    }).join('');
    const volumes = rows.map((row) => {
        const x = xFor(row) - barWidth / 2;
        const barHeight = Math.max(2, Number(row.units || 0) / maxUnits * Math.min(62, plotHeight * 0.3));
        return `<rect class="chart-volume" x="${x.toFixed(1)}" y="${(plotBottom - barHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}"></rect>`;
    }).join('');
    const vwapSegments = marketChartSegments(rows, xFor, yFor, 'vwap', history.bucketMs);
    const medianSegments = marketChartSegments(rows, xFor, yFor, 'median', history.bucketMs);
    const areas = vwapSegments.map((points) => {
        if (!points.length) return '';
        const firstX = points[0].split(',')[0];
        const lastX = points.at(-1).split(',')[0];
        return `<polygon class="chart-vwap-area" points="${firstX},${plotBottom} ${points.join(' ')} ${lastX},${plotBottom}"></polygon>`;
    }).join('');
    const lines = `${vwapSegments.map((points) => `<polyline class="chart-vwap" points="${points.join(' ')}"></polyline>`).join('')}${medianSegments.map((points) => `<polyline class="chart-median" points="${points.join(' ')}"></polyline>`).join('')}`;

    marketEls.chart.innerHTML = `<svg class="market-price-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="VWAP, weighted median, and traded volume for ${escapeMarketHtml(item.name)}">
        <defs><linearGradient id="marketPriceArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#d8b96d" stop-opacity=".16"></stop><stop offset="1" stop-color="#d8b96d" stop-opacity="0"></stop></linearGradient></defs>
        ${grid}${volumes}${areas}${lines}${ticks}
        <line class="chart-crosshair" x1="0" y1="${top}" x2="0" y2="${plotBottom}"></line>
        <circle class="chart-point" cx="0" cy="0" r="4"></circle>
        <rect class="chart-hit-area" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" fill="transparent"></rect>
    </svg><div class="market-chart-tooltip"></div>`;

    const svg = marketEls.chart.querySelector('svg');
    const crosshair = svg.querySelector('.chart-crosshair');
    const point = svg.querySelector('.chart-point');
    const tooltip = marketEls.chart.querySelector('.market-chart-tooltip');
    svg.addEventListener('pointermove', (event) => {
        const rect = svg.getBoundingClientRect();
        const shellRect = marketEls.chart.getBoundingClientRect();
        const svgX = (event.clientX - rect.left) / Math.max(1, rect.width) * width;
        const row = rows.reduce((nearest, candidate) => (
            Math.abs(xFor(candidate) - svgX) < Math.abs(xFor(nearest) - svgX) ? candidate : nearest
        ), rows[0]);
        const x = xFor(row);
        const y = yFor(row.vwap);
        crosshair.setAttribute('x1', x);
        crosshair.setAttribute('x2', x);
        crosshair.classList.add('is-active');
        point.setAttribute('cx', x);
        point.setAttribute('cy', y);
        point.classList.add('is-active');
        tooltip.innerHTML = `<strong>${escapeMarketHtml(marketHistoryTime(Number(row.at) + Number(history.bucketMs) / 2))}</strong><span>VWAP <b>${escapeMarketHtml(marketHistoryPrice(row.vwap))}</b></span><span>Median <b>${escapeMarketHtml(marketHistoryPrice(row.median))}</b></span><span>Volume <b>${marketNumber(row.units)} units</b></span>`;
        tooltip.classList.add('is-visible');

        const edge = 8;
        const gap = 10;
        const tooltipWidth = tooltip.offsetWidth;
        const tooltipHeight = tooltip.offsetHeight;
        const pointX = marketEls.chart.scrollLeft + rect.left - shellRect.left + x / width * rect.width;
        const pointY = marketEls.chart.scrollTop + rect.top - shellRect.top + y / height * rect.height;
        const minX = marketEls.chart.scrollLeft + edge + tooltipWidth / 2;
        const maxX = marketEls.chart.scrollLeft + marketEls.chart.clientWidth - edge - tooltipWidth / 2;
        const tooltipX = minX <= maxX
            ? Math.max(minX, Math.min(maxX, pointX))
            : marketEls.chart.scrollLeft + marketEls.chart.clientWidth / 2;
        const visibleTop = marketEls.chart.scrollTop + edge;
        const visibleBottom = marketEls.chart.scrollTop + marketEls.chart.clientHeight - edge;
        const fitsAbove = pointY - tooltipHeight - gap >= visibleTop;
        const fitsBelow = pointY + tooltipHeight + gap <= visibleBottom;

        tooltip.style.left = `${tooltipX}px`;
        tooltip.style.top = `${pointY}px`;
        tooltip.classList.toggle('is-below', !fitsAbove && fitsBelow);
    });
    svg.addEventListener('pointerleave', () => {
        crosshair.classList.remove('is-active');
        point.classList.remove('is-active');
        tooltip.classList.remove('is-visible');
    });
}

async function loadMarketHistory(item, { force = false } = {}) {
    if (!item) return;
    const same = Number(marketState.historyItemId) === Number(item.selfId)
        && marketState.history?.range === marketState.historyRange;
    if (!force && same && Date.now() - marketState.historyLoadedAt < 9000) {
        renderMarketHistory();
        return;
    }
    const request = ++marketState.historyRequest;
    marketState.historyItemId = Number(item.selfId);
    marketEls.historyTitle.textContent = `${item.name} price history`;
    marketEls.historyMeta.textContent = `Loading ${marketState.historyRange} persistent history…`;
    marketEls.historyVwap.textContent = '—';
    marketEls.historyMedian.textContent = '—';
    marketEls.historyPriceRange.textContent = '—';
    marketEls.historyVolume.textContent = '—';
    marketEls.chart.innerHTML = '<div class="market-chart-empty">Loading completed trades.</div>';
    try {
        const response = await fetch(`/observer/api/market/history?itemId=${Number(item.selfId)}&range=${marketState.historyRange}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Market history ${response.status}`);
        const history = await response.json();
        if (request !== marketState.historyRequest) return;
        marketState.history = history;
        marketState.historyLoadedAt = Date.now();
        renderMarketHistory();
    } catch (error) {
        if (request !== marketState.historyRequest) return;
        marketEls.historyMeta.textContent = `History unavailable: ${error.message}`;
        marketEls.chart.innerHTML = '<div class="market-chart-empty">Persistent price history could not be loaded.</div>';
    }
}

function renderMarketDetail() {
    const item = selectedMarketItem();
    if (!item) {
        marketEls.detail.innerHTML = '<div class="inspector-empty"><span class="empty-glyph">◎</span><strong>Select an item</strong><p>See the exact sellers, buyers, quantities, and prices behind the market depth.</p></div>';
        marketState.historyRequest += 1;
        marketState.historyItemId = null;
        marketEls.historyTitle.textContent = 'Select an item to inspect price history';
        marketEls.historyMeta.textContent = 'Persistent trades are retained for 90 days.';
        marketEls.chart.innerHTML = '<div class="market-chart-empty">Select a traded item to load its persistent price history.</div>';
        return;
    }
    const offers = selectedOffers(item);
    const spread = item.wts?.minPrice && item.wtb?.maxPrice ? Number(item.wts.minPrice) - Number(item.wtb.maxPrice) : null;
    marketEls.detail.innerHTML = `
        <header class="market-detail-header">
            ${itemIcon(item, 'market-detail-icon')}
            <div><span class="section-kicker">Selected item</span><h2>${escapeMarketHtml(item.name)}</h2><p>#${Number(item.selfId)} · ${escapeMarketHtml(item.grade || item.category || 'Item')}</p></div>
            <a href="/observer/database/items/${Number(item.selfId)}" title="Open item database">↗</a>
        </header>
        <div class="market-detail-stats">
            <div><span>Ask</span><strong>${item.wts?.minPrice ? `${marketNumber(item.wts.minPrice)} A` : '—'}</strong></div>
            <div><span>Bid</span><strong>${item.wtb?.maxPrice ? `${marketNumber(item.wtb.maxPrice)} A` : '—'}</strong></div>
            <div><span>Spread</span><strong>${spread === null ? '—' : `${marketNumber(spread)} A`}</strong></div>
        </div>
        <div class="market-demand-line"><span>Planned demand</span><strong>${marketNumber(item.demand?.units || 0)} units</strong><small>${marketNumber(item.demand?.fundedUnits || 0)} funded · ${marketNumber(item.demand?.readyBots || 0)} ready bots</small></div>
        <div class="market-offer-head"><span>Active order book</span><span>${offers.length} offers</span></div>
        <div class="market-offer-list">${offers.length ? offers.map(({ store, line }) => `
            <div class="market-offer-row ${store.side}">
                <b>${store.side.toUpperCase()}</b>
                <span><strong>${escapeMarketHtml(store.ownerName)}</strong><small>${escapeMarketHtml(store.town)} · ${escapeMarketHtml(marketSourceLabel(store.source))}${store.title ? ` · ${escapeMarketHtml(store.title)}` : ''}</small></span>
                <span><strong>${marketNumber(line.price)} A</strong><small>${marketNumber(line.count)} units</small></span>
            </div>`).join('') : '<div class="list-empty">No active store offers. Demand comes from bot plans.</div>'}</div>`;
    loadMarketHistory(item);
}

function renderMarketTowns() {
    const rows = Object.entries(marketState.data?.byTown || {}).map(([name, town]) => ({ name, ...town }))
        .sort((left, right) => Number(right.wts || 0) + Number(right.wtb || 0) - Number(left.wts || 0) - Number(left.wtb || 0));
    marketEls.towns.innerHTML = rows.length ? rows.map((town) => `<button type="button" class="market-town-ledger-row" data-market-town="${escapeMarketHtml(town.name)}">
        <strong>${escapeMarketHtml(town.name)}</strong><span><b>${marketNumber(town.wts)}</b> WTS</span><span><b>${marketNumber(town.wtb)}</b> WTB</span><span>${compactMarketNumber(town.sellUnits)} listed</span><span>${compactMarketNumber(town.buyUnits)} wanted</span>
    </button>`).join('') : '<div class="list-empty">No active trading towns.</div>';
}

function renderMarketTrades() {
    const rows = (marketState.data?.transactions?.recent || []).slice(0, 18);
    marketEls.recent.innerHTML = rows.length ? rows.map((trade) => {
        const wtb = trade.channel === 'wtb' || trade.channel === 'static_wtb';
        const counterparty = wtb ? trade.buyer?.name : trade.seller?.name;
        return `<div class="market-trade-ledger-row">
            <b class="${wtb ? 'wtb' : 'wts'}">${wtb ? 'WTB' : 'WTS'}</b>
            <span><strong>${escapeMarketHtml(trade.itemName || `Item ${trade.selfId}`)} ×${marketNumber(trade.quantity)}</strong><small>${escapeMarketHtml(trade.town || 'Unknown')} · ${escapeMarketHtml(counterparty || trade.sourceType || 'Market')}</small></span>
            <span><strong>${marketNumber(trade.unitPrice)} A</strong><small>${new Date(Number(trade.at)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></span>
        </div>`;
    }).join('') : '<div class="list-empty">No trades recorded since server start.</div>';
}

function renderMarketPage() {
    if (!marketState.data) return;
    renderMarketSummary();
    renderMarketTownOptions();
    renderMarketTable();
    renderMarketTowns();
    renderMarketTrades();
}

async function refreshMarket() {
    if (marketState.loading) return;
    marketState.loading = true;
    try {
        const response = await fetch('/observer/api/market', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Market API ${response.status}`);
        marketState.data = await response.json();
        renderMarketPage();
    } catch (error) {
        marketEls.freshness.textContent = `Market unavailable: ${error.message}`;
    } finally {
        marketState.loading = false;
    }
}

marketEls.search.addEventListener('input', () => { marketState.query = marketEls.search.value; renderMarketTable(); });
marketEls.sideTabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-market-side]');
    if (!button) return;
    marketState.side = button.dataset.marketSide;
    marketEls.sideTabs.querySelectorAll('button').forEach((entry) => entry.classList.toggle('is-active', entry === button));
    renderMarketTable();
});
marketEls.town.addEventListener('change', () => { marketState.town = marketEls.town.value; renderMarketTable(); });
marketEls.source.addEventListener('change', () => { marketState.source = marketEls.source.value; renderMarketTable(); });
marketEls.sort.addEventListener('change', () => { marketState.sort = marketEls.sort.value; renderMarketTable(); });
marketEls.rangeTabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-market-range]');
    if (!button || button.dataset.marketRange === marketState.historyRange) return;
    marketState.historyRange = button.dataset.marketRange;
    marketEls.rangeTabs.querySelectorAll('button').forEach((entry) => entry.classList.toggle('is-active', entry === button));
    const item = selectedMarketItem();
    if (item) loadMarketHistory(item, { force: true });
});
marketEls.body.addEventListener('click', (event) => {
    const row = event.target.closest('[data-market-item]');
    if (!row) return;
    marketState.selectedId = Number(row.dataset.marketItem);
    renderMarketTable();
});
marketEls.body.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    const row = event.target.closest('[data-market-item]');
    if (!row) return;
    event.preventDefault();
    marketState.selectedId = Number(row.dataset.marketItem);
    renderMarketTable();
});
marketEls.towns.addEventListener('click', (event) => {
    const row = event.target.closest('[data-market-town]');
    if (!row) return;
    marketState.town = row.dataset.marketTown;
    marketEls.town.value = marketState.town;
    renderMarketTable();
    document.querySelector('.market-depth')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
marketEls.liveToggle.addEventListener('click', () => {
    marketState.live = !marketState.live;
    marketEls.liveToggle.classList.toggle('is-live', marketState.live);
    marketEls.liveLabel.textContent = marketState.live ? 'Live' : 'Paused';
    marketEls.liveToggle.title = marketState.live ? 'Pause live refresh' : 'Resume live refresh';
    if (marketState.live) refreshMarket();
});
document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== marketEls.search) {
        event.preventDefault();
        marketEls.search.focus();
    }
});
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && marketState.live) refreshMarket();
});

refreshMarket();
marketState.timer = window.setInterval(() => {
    if (marketState.live && !document.hidden) refreshMarket();
}, 10000);
