/* eslint-env browser */
/* global MarketModel */

const marketState = {
    data: null,
    loading: false,
    live: true,
    query: new URLSearchParams(location.search).get('q') || '',
    side: 'wts',
    town: 'all',
    source: 'market',
    category: 'all',
    sort: 'shops',
    view: 'items',
    limit: 100,
    offers: [],
    selectedId: Number(new URLSearchParams(location.search).get('item')) || null,
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
    counterRows: document.querySelector('#marketCounterRows'),
    adenaRows: document.querySelector('#marketAdenaRows'),
    search: document.querySelector('#marketSearch'),
    sideTabs: document.querySelector('#marketSideTabs'),
    town: document.querySelector('#marketTown'),
    source: document.querySelector('#marketSource'),
    category: document.querySelector('#marketCategory'),
    sort: document.querySelector('#marketSort'),
    viewTabs: document.querySelector('#marketViewTabs'),
    orderHeading: document.querySelector('#marketOrderHeading'),
    tableHead: document.querySelector('#marketTableHead'),
    more: document.querySelector('#marketMore'),
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
    return ({ player: 'Online player', afk_player: 'AFK player', bot: 'Bot', afk_bot: 'AFK bot', fixed: 'Fixed trader' })[source] || source;
}

function itemIcon(item, className = 'market-item-icon') {
    return item?.iconUrl
        ? `<img class="${className}" src="${escapeMarketHtml(item.iconUrl)}" alt="" loading="lazy">`
        : `<span class="${className} is-fallback">${escapeMarketHtml(String(item?.name || '?').slice(0, 1).toUpperCase())}</span>`;
}

function marketFilters(side = marketState.side, query = marketState.query) {
    return { side, query, town: marketState.town, source: marketState.source, category: marketState.category };
}

function filteredMarketOffers() {
    return MarketModel.filterOffers(marketState.offers, marketFilters());
}

function marketItemCell(item) {
    return `<div class="market-item-cell">${itemIcon(item)}<span><strong>${escapeMarketHtml(item.name)}</strong><small>#${Number(item.selfId)} · ${escapeMarketHtml(item.grade || item.category || 'Item')}</small></span></div>`;
}

function renderMarketSummary() {
    const sales = MarketModel.summary(MarketModel.filterOffers(marketState.offers, { side: 'wts', source: 'market' }));
    const buys = MarketModel.summary(MarketModel.filterOffers(marketState.offers, { side: 'wtb', source: 'market' }));
    const week = marketState.data?.history?.windows?.week || {};
    marketEls.wts.textContent = marketNumber(sales.shops);
    marketEls.wtb.textContent = marketNumber(buys.shops);
    marketEls.sellUnits.textContent = `${marketNumber(sales.listings)} offers · ${compactMarketNumber(sales.units)} units`;
    marketEls.buyUnits.textContent = `${marketNumber(buys.listings)} offers · ${compactMarketNumber(buys.units)} units`;
    marketEls.trades.textContent = compactMarketNumber(week.trades || 0);
    marketEls.volume.textContent = `${compactMarketNumber(week.adena || 0)} A`;
    marketEls.tradeUnits.textContent = `${compactMarketNumber(week.units || 0)} units · all channels`;
    marketEls.volumeScope.textContent = 'includes fixed traders';
    marketEls.freshness.textContent = `Player and bot shops · fixed traders shown separately · refreshed ${relativeMarketTime(marketState.data?.generatedAt)}`;
}

function renderMarketTownOptions() {
    const available = MarketModel.filterOffers(marketState.offers, {
        side: marketState.side, source: marketState.source
    });
    const towns = [...new Set(available.map((offer) => offer.town))].sort();
    const value = marketState.town;
    const html = `<option value="all">All towns</option>${towns.map((town) => `<option value="${escapeMarketHtml(town)}">${escapeMarketHtml(town)}</option>`).join('')}`;
    if (marketEls.town.innerHTML !== html) marketEls.town.innerHTML = html;
    marketEls.town.value = towns.includes(value) ? value : 'all';
    marketState.town = marketEls.town.value;
}

function renderMarketTable() {
    const offers = filteredMarketOffers();
    const itemView = marketState.view === 'items';
    const rows = MarketModel.sortRows(itemView ? MarketModel.groupOffers(offers, marketState.side) : offers, marketState);
    const sideLabel = marketState.side === 'wts' ? 'for sale' : 'wanted';
    marketEls.orderHeading.textContent = marketState.side === 'wts' ? 'Items for sale' : 'Items being bought';
    marketEls.resultCount.textContent = `${marketNumber(rows.length)} ${itemView ? 'items' : 'offers'} ${sideLabel} · ${marketNumber(offers.length)} active offers${marketState.source === 'market' ? ' · fixed traders excluded' : ''}`;
    marketEls.tableHead.innerHTML = itemView
        ? `<tr><th>Item</th><th>${marketState.side === 'wts' ? 'Best ask' : 'Best bid'}</th><th>Best offer in</th><th>Offers</th><th>Units</th></tr>`
        : `<tr><th>Item</th><th>Unit price</th><th>Town</th><th>Trader</th><th>Quantity</th></tr>`;
    marketEls.more.hidden = rows.length <= marketState.limit;
    marketEls.more.textContent = `Show more · ${marketNumber(rows.length - marketState.limit)} remaining`;
    if (!rows.length) {
        marketState.selectedId = null;
        marketEls.body.innerHTML = `<tr><td colspan="5" class="list-empty">No active ${sideLabel} offers match these filters.</td></tr>`;
        renderMarketDetail();
        return;
    }
    const selectedIndex = rows.findIndex((row) => Number(row.selfId) === Number(marketState.selectedId));
    if (selectedIndex < 0) marketState.selectedId = rows[0].selfId;
    else if (selectedIndex >= marketState.limit) marketState.limit = selectedIndex + 1;
    marketEls.body.innerHTML = rows.slice(0, marketState.limit).map((row) => {
        const best = itemView ? row.best : row;
        const selected = Number(row.selfId) === Number(marketState.selectedId);
        const traders = itemView ? new Set(row.offers.map((offer) => offer.ownerId || offer.ownerName)).size : 0;
        return `<tr class="market-item-row${selected ? ' is-selected' : ''}" data-market-item="${Number(row.selfId)}" tabindex="0" aria-selected="${selected}">
            <td>${marketItemCell(row)}</td>
            <td data-label="${marketState.side === 'wts' ? 'Best ask' : 'Best bid'}" class="market-price ${marketState.side === 'wts' ? 'ask' : 'bid'}">${marketNumber(best.price)} A${itemView ? `<small>${marketNumber(best.count)} ${best.count === 1 ? 'unit' : 'units'} at this price</small>` : ''}</td>
            <td data-label="Town"><strong>${escapeMarketHtml(best.town)}</strong>${itemView ? `<small>${escapeMarketHtml(best.ownerName)}</small>` : ''}</td>
            <td data-label="${itemView ? 'Offers' : 'Trader'}">${itemView ? `<strong>${marketNumber(row.offers.length)}</strong><small>${marketNumber(traders)} ${traders === 1 ? 'trader' : 'traders'}</small>` : `<strong>${escapeMarketHtml(row.ownerName)}</strong><small>${escapeMarketHtml(marketSourceLabel(row.source))}</small>`}</td>
            <td data-label="Quantity"><strong>${marketNumber(itemView ? row.units : row.count)}</strong>${!itemView && row.enchant ? `<small>+${marketNumber(row.enchant)}</small>` : ''}</td>
        </tr>`;
    }).join('');
    renderMarketDetail();
}

function selectedMarketItem() {
    return (marketState.data?.items || []).find((item) => Number(item.selfId) === Number(marketState.selectedId)) || null;
}

function selectedOffers(item) {
    if (!item) return [];
    const matches = MarketModel.filterOffers(marketState.offers, marketFilters(null, ''))
        .filter((offer) => offer.selfId === Number(item.selfId));
    return matches.sort((left, right) => left.side.localeCompare(right.side)
        || (left.side === 'wts' ? left.price - right.price : right.price - left.price));
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
    if (!force && same && Date.now() - marketState.historyLoadedAt < 60000) {
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

function marketLocation(offer) {
    const loc = offer.loc;
    if (!loc || !Number.isFinite(Number(loc.locX)) || !Number.isFinite(Number(loc.locY))) return '';
    return `${Math.round(Number(loc.locX))}, ${Math.round(Number(loc.locY))}, ${Math.round(Number(loc.locZ || 0))}`;
}

function marketOfferRow(offer) {
    const location = marketLocation(offer);
    return `<div class="market-offer-row ${offer.side}">
        <span class="market-offer-location"><strong>${escapeMarketHtml(offer.town)}</strong><small>${location ? escapeMarketHtml(location) : 'Town location'}</small></span>
        <span class="market-offer-owner"><strong>${escapeMarketHtml(offer.ownerName)}</strong><small>${escapeMarketHtml(marketSourceLabel(offer.source))}${offer.title ? ` · ${escapeMarketHtml(offer.title)}` : ''}</small></span>
        <span class="market-offer-price"><strong>${marketNumber(offer.price)} A</strong><small>${marketNumber(offer.count)} units${offer.enchant ? ` · +${marketNumber(offer.enchant)}` : ''}</small></span>
    </div>`;
}

function renderMarketDetail() {
    const item = selectedMarketItem();
    if (!item) {
        marketEls.detail.innerHTML = '<div class="inspector-empty"><span class="empty-glyph">◎</span><strong>Select an item</strong><p>See exact traders, towns, quantities, and prices.</p></div>';
        delete marketEls.detail.dataset.marketSelectedId;
        marketState.historyRequest += 1;
        marketState.historyItemId = null;
        marketEls.historyTitle.textContent = 'Select an item for its price history';
        marketEls.historyMeta.textContent = 'The 90-day journal covers all trade channels, including fixed traders.';
        marketEls.historyVwap.textContent = '—';
        marketEls.historyMedian.textContent = '—';
        marketEls.historyPriceRange.textContent = '—';
        marketEls.historyVolume.textContent = '—';
        marketEls.chart.innerHTML = '<div class="market-chart-empty">Select an item to load completed trades.</div>';
        return;
    }
    const sameItem = Number(marketEls.detail.dataset.marketSelectedId) === Number(item.selfId);
    const scrollTop = sameItem ? marketEls.detail.scrollTop : 0;
    const sideScroll = sameItem ? Object.fromEntries([...marketEls.detail.querySelectorAll('.market-book-side')]
        .map((section) => [section.classList.contains('wtb') ? 'wtb' : 'wts', section.querySelector('.market-offer-list')?.scrollTop || 0])) : {};
    const offers = selectedOffers(item);
    const sales = offers.filter((offer) => offer.side === 'wts').sort((left, right) => left.price - right.price);
    const buys = offers.filter((offer) => offer.side === 'wtb').sort((left, right) => right.price - left.price);
    const spread = sales.length && buys.length ? sales[0].price - buys[0].price : null;
    const section = (side, rows) => `<section class="market-book-side ${side}"><div class="market-offer-head"><span>${side === 'wts' ? 'For sale' : 'Buying'}</span><span>${marketNumber(rows.length)} offers · ${marketNumber(rows.reduce((total, row) => total + row.count, 0))} units</span></div>
        <div class="market-offer-list">${rows.length ? rows.map(marketOfferRow).join('') : `<div class="market-book-empty">No active ${side === 'wts' ? 'sellers' : 'buyers'} in these traders and towns.</div>`}</div></section>`;
    marketEls.detail.innerHTML = `
        <header class="market-detail-header">
            ${itemIcon(item, 'market-detail-icon')}
            <div><span class="section-kicker">Active order book</span><h2>${escapeMarketHtml(item.name)}</h2><p>#${Number(item.selfId)} · ${escapeMarketHtml(item.grade || item.category || 'Item')}</p></div>
            <a href="/observer/database/items/${Number(item.selfId)}" title="Open item database" aria-label="Open ${escapeMarketHtml(item.name)} in database">↗</a>
        </header>
        <div class="market-detail-stats">
            <div><span>Lowest ask</span><strong>${sales.length ? `${marketNumber(sales[0].price)} A` : '—'}</strong></div>
            <div><span>Highest bid</span><strong>${buys.length ? `${marketNumber(buys[0].price)} A` : '—'}</strong></div>
            <div><span>Spread</span><strong>${spread === null ? '—' : `${marketNumber(spread)} A`}</strong></div>
        </div>
        <p class="market-book-scope">${marketState.source === 'market' ? 'Player and bot shops' : marketEls.source.selectedOptions[0].textContent} · ${marketState.town === 'all' ? 'all towns' : escapeMarketHtml(marketState.town)}. Prices are per unit.</p>
        ${marketState.side === 'wtb' ? `${section('wtb', buys)}${section('wts', sales)}` : `${section('wts', sales)}${section('wtb', buys)}`}
        <div class="market-demand-line"><span>Bot purchase plans</span><strong>${marketNumber(item.demand?.units || 0)} units</strong><small>${marketNumber(item.demand?.fundedUnits || 0)} funded · plans are not active buy offers</small></div>`;
    marketEls.detail.dataset.marketSelectedId = String(item.selfId);
    marketEls.detail.scrollTop = scrollTop;
    marketEls.detail.querySelectorAll('.market-book-side').forEach((entry) => {
        entry.querySelector('.market-offer-list').scrollTop = sideScroll[entry.classList.contains('wtb') ? 'wtb' : 'wts'] || 0;
    });
    loadMarketHistory(item);
}

function renderMarketTowns() {
    const offers = MarketModel.filterOffers(marketState.offers, { ...marketFilters(marketState.side), town: 'all' });
    const byTown = new Map();
    offers.forEach((offer) => {
        let town = byTown.get(offer.town);
        if (!town) {
            town = { name: offer.town, offers: 0, units: 0, shops: new Set() };
            byTown.set(offer.town, town);
        }
        town.offers += 1;
        town.units += offer.count;
        town.shops.add(offer.ownerId || offer.ownerName);
    });
    const rows = [...byTown.values()].sort((left, right) => right.offers - left.offers || left.name.localeCompare(right.name));
    marketEls.towns.innerHTML = rows.length ? rows.map((town) => `<button type="button" class="market-town-ledger-row" data-market-town="${escapeMarketHtml(town.name)}">
        <strong>${escapeMarketHtml(town.name)}</strong><span><b>${marketNumber(town.offers)}</b> offers</span><span><b>${marketNumber(town.shops.size)}</b> shops</span><span>${compactMarketNumber(town.units)} units</span>
    </button>`).join('') : '<div class="list-empty">No active offers for these filters.</div>';
}

function renderMarketTrades() {
    const rows = (marketState.data?.transactions?.recent || []).slice(0, 18);
    marketEls.recent.innerHTML = rows.length ? rows.map((trade) => {
        const wtb = trade.channel === 'wtb' || trade.channel === 'static_wtb';
        const counterparty = wtb ? trade.buyer?.name : trade.seller?.name;
        return `<div class="market-trade-ledger-row">
            <b class="${wtb ? 'wtb' : 'wts'}">${wtb ? 'Bought' : 'Sold'}</b>
            <span><strong>${escapeMarketHtml(trade.itemName || `Item ${trade.selfId}`)} ×${marketNumber(trade.quantity)}</strong><small>${escapeMarketHtml(trade.town || 'Unknown')} · ${escapeMarketHtml(counterparty || trade.sourceType || 'Market')}</small></span>
            <span><strong>${marketNumber(trade.unitPrice)} A</strong><small>${new Date(Number(trade.at)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></span>
        </div>`;
    }).join('') : '<div class="list-empty">No trades recorded since server start.</div>';
}

function renderMarketEconomy() {
    const economy = MarketModel.economy(marketState.data);
    const labels = { gear: 'Equipment', shot: 'Shots', recipe: 'Recipes', material: 'Materials' };
    marketEls.counterRows.innerHTML = economy.counters.length ? economy.counters.map((row) => `<tr>
        <td>${escapeMarketHtml(labels[row.kind] || row.kind)}</td><td>${escapeMarketHtml(row.grade === 'none' ? 'No grade' : row.grade.toUpperCase())}</td>
        <td>${row.priceIndex === null ? '—' : Number(row.priceIndex).toFixed(1)}</td>
        <td>${marketNumber(row.deals)}</td><td>${Number(row.buyersPerHour).toFixed(1)}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="list-empty">Price indices unavailable.</td></tr>';
    marketEls.adenaRows.innerHTML = economy.available ? economy.buckets.map((row) => `<tr>
        <td>${escapeMarketHtml(new Date(row.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' }))}${row.partial ? ' · partial' : ''}</td>
        <td>${row.observed ? marketNumber(row.sources) : '—'}</td>
        <td>${row.observed ? marketNumber(row.sinks) : '—'}</td>
        <td>${row.observed ? `${row.net > 0 ? '+' : ''}${marketNumber(row.net)}` : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="list-empty">Hourly balance unavailable.</td></tr>';
}

function renderMarketPage() {
    if (!marketState.data) return;
    renderMarketSummary();
    renderMarketTownOptions();
    renderMarketTable();
    renderMarketTowns();
    renderMarketTrades();
    renderMarketEconomy();
}

async function refreshMarket() {
    if (marketState.loading) return;
    marketState.loading = true;
    try {
        const response = await fetch('/observer/api/market', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Market API ${response.status}`);
        marketState.data = await response.json();
        marketState.offers = MarketModel.activeOffers(marketState.data);
        renderMarketPage();
        window.WorldObserverShell?.connection(true);
    } catch (error) {
        marketEls.freshness.textContent = 'Trading activity could not load. We will try again shortly.';
        window.WorldObserverShell?.connection(false);
    } finally {
        marketState.loading = false;
    }
}

function marketFiltersChanged({ towns = false } = {}) {
    marketState.limit = 100;
    if (towns) renderMarketTownOptions();
    renderMarketTable();
    renderMarketTowns();
}

marketEls.search.addEventListener('input', () => { marketState.query = marketEls.search.value; marketFiltersChanged(); });
marketEls.sideTabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-market-side]');
    if (!button) return;
    marketState.side = button.dataset.marketSide;
    marketEls.sideTabs.querySelectorAll('button').forEach((entry) => entry.classList.toggle('is-active', entry === button));
    marketFiltersChanged({ towns: true });
});
marketEls.viewTabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-market-view]');
    if (!button) return;
    marketState.view = button.dataset.marketView;
    marketEls.viewTabs.querySelectorAll('button').forEach((entry) => entry.classList.toggle('is-active', entry === button));
    marketEls.sort.options[0].textContent = marketState.view === 'items' ? 'Most offers' : 'Largest lots';
    marketFiltersChanged();
});
marketEls.more.addEventListener('click', () => { marketState.limit += 100; renderMarketTable(); });
marketEls.town.addEventListener('change', () => { marketState.town = marketEls.town.value; marketFiltersChanged(); });
marketEls.source.addEventListener('change', () => { marketState.source = marketEls.source.value; marketFiltersChanged({ towns: true }); });
marketEls.category.addEventListener('change', () => { marketState.category = marketEls.category.value; marketFiltersChanged(); });
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
    marketFiltersChanged();
    document.querySelector('.market-depth')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
marketEls.liveToggle.addEventListener('click', () => {
    marketState.live = !marketState.live;
    marketEls.liveToggle.classList.toggle('is-live', marketState.live);
    marketEls.liveLabel.textContent = marketState.live ? 'Live' : 'Paused';
    marketEls.liveToggle.setAttribute('aria-label', marketEls.liveToggle.title);
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

marketEls.search.value = marketState.query;
refreshMarket();
marketState.timer = window.setInterval(() => {
    if (marketState.live && !document.hidden) refreshMarket();
}, 10000);
