(function (root, factory) {
    const view = factory();
    if (typeof module === 'object' && module.exports) module.exports = view;
    else root.ProfileData = view;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[char]);
    const number = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString();
    const label = value => String(value || 'Unknown').replaceAll('_', ' ');
    const source = value => ({ liquidate: 'Sell surplus items', money: 'Hunt for income', drop: 'Monster drops', spoil: 'Spoil monsters',
        market: 'Player market', npc: 'NPC shop', craft: 'Craft item', warehouse: 'Withdraw from warehouse' })[value] || label(value);
    const item = row => row ? `<a class="inspector-link" href="/observer/database/items/${Number(row.selfId)}" data-app-route>${escape(row.name)}</a>` : 'Unknown';
    const wish = row => row?.item ? item(row.item) : escape(({ stock: 'Restock', henna: 'Install henna', enchant: 'Enchant equipment',
        sa: 'Install special ability', book: 'Learn skill', level: 'Reach level', care: 'Help character', scores: 'Settle score' })[row?.kind] || label(row?.kind))
        + (row?.name || row?.reference ? `${row?.kind === 'stock' ? ' ' : ' · '}${escape(row.name || row.reference)}` : '');
    const wholeNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
    const adena = value => value == null || !Number.isFinite(Number(value)) ? '—' : `${wholeNumber.format(Number(value))} <span class="economy-unit">A</span>`;
    const reason = value => ({ superseded: 'Replaced by a newer wish', source_unavailable: 'No source available',
        wish_focus: 'Waiting for the priority wish', no_missing_craftable_upgrade: 'No craftable upgrades available',
        insufficient_funds: 'Needs more adena' })[value] || null;
    const activityName = action => ({ hunting: action.funding ? 'Hunting for income' : 'Hunting for items',
        shopping: 'Buying items', selling: 'Selling surplus items', crafting: 'Crafting an item',
        improving: 'Improving equipment', learning: 'Learning a skill', restocking: 'Restocking supplies',
        trading: 'Trading', travelling: 'Travelling', resting: 'Recovering' })[action.activity] || 'Preparing the next step';
    const wishIcon = row => `<span class="economy-wish-icon" aria-hidden="true">${row?.item?.iconUrl?.startsWith('/observer/item-icons/')
        ? `<img src="${escape(row.item.iconUrl)}" alt="" loading="lazy">` : '✦'}</span>`;
    const fact = (name, value) => `<div><dt>${escape(name)}</dt><dd>${value}</dd></div>`;
    const status = value => ({ complete: 'Checked', active: 'In progress', deferred: 'On hold' })[value] || 'Saved';
    function renderEconomy(economy, { spot = null } = {}) {
        if (!economy) return '<p class="muted-copy">No economic plan available yet.</p>';
        const focus = economy.focus, action = economy.selectedAction, money = economy.money;
        const target = economy.acquisitionGoal, equipment = economy.equipmentPlan;
        const spotName = spot && String(spot.id) === String(action?.spotId) && spot.name !== spot.id ? spot.name : null;
        const methodAddsDetail = action && ({ hunting: 'money', selling: 'liquidate', crafting: 'craft' })[action.activity] !== action.source;
        const actionFacts = action ? [
            methodAddsDetail ? fact('Method', escape(source(action.source))) : '',
            action.item ? fact('Item needed', item(action.item)) : '',
            action.amount > 0 ? fact('Quantity', wholeNumber.format(action.amount)) : '',
            action.npcId ? fact('NPC', `<a href="/observer/database/npcs/${Number(action.npcId)}" data-app-route>${escape(target?.next?.npcId === action.npcId && target.next.npcName || `NPC #${Number(action.npcId)}`)}</a>`) : '',
            action.town ? fact('Town', escape(action.town)) : '',
            spotName ? fact('Hunting area', escape(spotName)) : '',
            action.recipeId ? fact('Recipe', `#${Number(action.recipeId)}`) : '',
            action.estimatedPrice > 0 ? fact('Estimated cost', adena(action.estimatedPrice)) : '',
            action.effortHours != null ? fact('Estimated time', `${Number(action.effortHours).toFixed(1)} h`) : '',
            action.funding && action.shortfall != null ? fact('Still needed', adena(action.shortfall)) : ''
        ].join('') : '';
        return `<section class="economy-profile" aria-label="Economic plans">
            <header class="economy-heading"><h3>Wishes & plans</h3><p>What matters next, and how the bot plans to get it.</p></header>
            <div class="economy-plan-grid">
                <article class="economy-card economy-card--wish">
                    <span class="economy-eyebrow">Priority wish</span>
                    <div class="economy-wish-heading">${wishIcon(focus)}<h4>${focus ? wish(focus) : 'No priority chosen yet'}</h4></div>
                    ${focus?.estimatedPrice != null ? `<div class="economy-price"><span>Estimated cost</span><strong>${adena(focus.estimatedPrice)}</strong></div>` : ''}
                </article>
                <article class="economy-card">
                    <span class="economy-eyebrow">Selected action</span>
                    <h4 class="economy-action-title">${action ? escape(activityName(action)) : 'Waiting for the next decision'}</h4>
                    ${action?.root ? `<p class="economy-action-target">Working toward ${wish(action.root)}</p>` : ''}
                    ${actionFacts ? `<dl class="economy-facts">${actionFacts}</dl>` : !action ? '<p class="economy-note">A chosen action will appear when the bot reviews its plan.</p>' : ''}
                    ${action?.spotId && !spotName ? `<details class="economy-location"><summary>Hunting location</summary><p>World cell <code>${escape(action.spotId)}</code></p></details>` : ''}
                </article>
            </div>
            ${target ? `<article class="economy-card economy-goal"><div><span class="economy-eyebrow">Equipment goal</span><h4>${item(target.target)}</h4>
                ${target.next ? `<p class="economy-note">${escape(target.next.raidBoss ? 'Raid drop' : source(target.next.kind))}${target.next.npcName ? ` · ${escape(target.next.npcName)}` : ''}</p>` : ''}</div>
                <span class="economy-status">${escape(status(target.status))}</span></article>` : ''}
            ${equipment ? `<div class="economy-equipment"><span>Equipment review</span><strong>${escape(status(equipment.status))}</strong>${reason(equipment.reason) ? `<span>${escape(reason(equipment.reason))}</span>` : ''}</div>` : ''}
            ${money ? `<article class="economy-card economy-money">
                <header class="economy-section-heading"><h4>Adena & spending</h4><span>Latest budget</span></header>
                <dl class="economy-money-metrics">${fact('Wallet', adena(money.wallet))}${fact('Survival reserve', adena(money.survivalReserve))}
                    ${fact('Estimated income / hour', adena(money.adenaPerHour))}${money.firstUnfundedPrice > 0 ? fact('Next unfunded wish', adena(money.firstUnfundedPrice)) : ''}</dl>
                ${money.funded.length ? `<div class="economy-budget"><div class="economy-budget-heading"><h5>Planned purchases</h5><span>Amounts are priorities only</span></div>
                    ${money.funded.map(row => `<div class="economy-budget-row"><span>${row.item ? item(row.item) : 'Other planned purchases'}</span><strong>${adena(row.cost)}</strong></div>`).join('')}</div>` : '<p class="economy-note">No purchases budgeted yet.</p>'}
            </article>` : ''}
            ${economy.dormant.length ? `<article class="economy-card economy-deferred"><header class="economy-section-heading"><h4>Deferred wishes</h4><span>${economy.dormant.length} waiting</span></header>
                ${economy.dormant.map(row => `<div class="economy-deferred-row"><div><strong>${wish(row)}</strong><span>${escape(reason(row.reason) || 'Deferred')}</span></div><span>${adena(row.estimatedPrice)}</span></div>`).join('')}</article>` : ''}
        </section>`;
    }
    const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const relativeFormat = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
    const validTime = value => Number.isFinite(Number(value)) && Number(value) > 0 && !Number.isNaN(new Date(Number(value)).getTime());
    function timestamp(value) {
        if (!validTime(value)) return '—';
        const date = new Date(Number(value));
        return `<time datetime="${date.toISOString()}" title="${escape(date.toLocaleString())}">${escape(dateFormat.format(date))}</time>`;
    }
    function age(value, reference) {
        if (!validTime(value) || !validTime(reference)) return '';
        const seconds = (Number(value) - Number(reference)) / 1000;
        const [unit, scale] = Math.abs(seconds) >= 86400 ? ['day', 86400] : Math.abs(seconds) >= 3600 ? ['hour', 3600] : ['minute', 60];
        return escape(relativeFormat.format(Math.trunc(seconds / scale), unit));
    }
    function renderPvp(data, { loading, ownerName }) {
        const totals = data.totals || {}, encounter = data.lastEncounter;
        // Background outcomes describe both sides; they do not identify who retreated or died.
        const result = ({ retreated: ['Retreat', 'A side withdrew from the encounter.'],
            killed: ['Kill recorded', 'The encounter ended with a casualty.'], defeated: ['Side defeated', 'One side had no fighters left.'],
            disengaged: ['Disengaged', 'Combat ended without a casualty.'], fighting: ['Fighting', 'The saved encounter was still in progress.'],
            pvp_expired: ['Ended', 'The encounter reached its time limit.'], pvp_interrupted: ['Interrupted', 'The encounter was interrupted.'] })[encounter?.outcome]
            || [label(encounter?.outcome), 'Saved background combat result.'];
        const enemies = data.enemies || [], incidents = data.incidents || [];
        const owner = escape(ownerName || 'this character');
        return `<div class="pvp-profile">
            <header class="pvp-heading"><div><h3>PvP & rivals</h3><p>Combat totals and the opponents this character remembers.</p></div>
                <span class="pvp-updated" title="${data.source === 'live_actor' ? 'Live character state' : 'Saved character state'}">${loading ? 'Refreshing…' : 'Updated'} ${timestamp(data.generatedAt)}</span></header>
            <dl class="pvp-totals">${fact('PvP kills', number(totals.pvp))}${fact('PK kills', number(totals.pk))}${fact('Karma', number(totals.karma))}</dl>
            <div class="pvp-detail-grid">
                <article class="pvp-card pvp-encounter"><h4>Last background encounter</h4>
                    ${encounter ? `<strong class="pvp-outcome">${escape(result[0])}</strong><p>${escape(result[1])}</p>
                        <div class="pvp-encounter-date">${timestamp(encounter.at)}<span>${age(encounter.at, data.generatedAt)}</span></div>`
                    : '<p class="pvp-empty">No background encounter recorded yet.</p>'}
                </article>
                <article class="pvp-card pvp-enemies"><header><h4>Remembered enemies</h4><p>Opponents who attacked or killed ${owner}.</p></header>
                    ${enemies.length ? `<ul class="pvp-enemy-list">${enemies.map(row => `<li><div class="pvp-enemy-identity"><strong>${escape(row.name || `Character #${row.id}`)}</strong>
                        ${validTime(row.lastSeenAt) ? `<span>Last incident ${timestamp(row.lastSeenAt)}</span>` : ''}</div>
                        <dl class="pvp-enemy-metrics">${fact('Deaths caused', number(row.kills))}${fact('Attack records', number(row.attacks))}</dl></li>`).join('')}</ul>
                        <p class="pvp-memory-note">Up to 3 enemies remembered · attack records capped at 3 per enemy.</p>` : '<p class="pvp-empty">No remembered enemies.</p>'}
                </article>
            </div>
            ${incidents.length ? `<article class="pvp-card"><h4>Recent combat roles</h4><ul class="pvp-incident-list">${incidents.map(row => `<li><div><strong>${escape(({ aggression: 'Aggressor', provoked: 'Provoked aggressor', defense: 'Defender' })[row.responsibility] || label(row.responsibility))}</strong>
                ${row.opponentId ? `<span>Against character #${Number(row.opponentId)}</span>` : ''}</div>${timestamp(row.at)}</li>`).join('')}</ul></article>` : ''}
        </div>`;
    }
    function renderCollection(section, data, { loading = false, error = null, ownerName = '' } = {}) {
        const names = { inventory: 'Inventory', warehouse: 'Personal warehouse', skills: 'Learned skills', pvp: 'PvP', board: 'Board listings' };
        let html = `<section class="inspector-block profile-data">${section === 'pvp' && data ? '' : `<h3>${names[section]}</h3>`}`;
        if (error) html += `<p class="detail-error">Refresh failed: ${escape(error)}</p>`;
        if (!data) return html + `<p>${loading ? 'Loading…' : 'Open this tab to load data.'}</p>${error ? '<button type="button" data-profile-retry>Retry</button>' : ''}</section>`;
        if (section === 'pvp') {
            html += renderPvp(data, { loading, ownerName });
        } else {
            html += `<p>${escape(label(data.source))} · observed ${escape(new Date(data.generatedAt).toLocaleTimeString())}${loading ? ' · refreshing' : ''}</p>`;
            const columns = section === 'skills' ? ['Skill', 'Level', 'Type'] : section === 'board' ? ['Item', 'Offer', 'Town', 'Units', 'Price', 'Execution'] : ['Item', 'Amount', 'Enchant', 'Equipped'];
            html += `<p>${number(data.total)} ${section === 'skills' ? 'learned skills' : 'entries'}</p><div class="profile-table-scroll"><table class="profile-data-table"><thead><tr>${columns.map(name => `<th>${name}</th>`).join('')}</tr></thead><tbody>`;
            html += data.rows.map(row => `<tr>${(section === 'skills' ? [escape(row.name || `#${row.selfId}`), number(row.level), row.passive ? 'Passive' : 'Active']
                : section === 'board' ? [item(row), `${escape(row.side)} · ${escape(label(row.kind))}`, escape(row.town), number(row.amount), `${number(row.price)} A`,
                    row.conditional ? 'Conditional · check at meeting' : row.custodyPolicy === 0 ? 'Reserved' : 'Check when trading']
                : [item(row), number(row.amount), row.enchant ? `+${number(row.enchant)}` : '—', row.equipped ? 'Yes' : '—']).map(value => `<td>${value}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length}">No entries.</td></tr>`;
            html += '</tbody></table></div>';
            if (data.offset || data.hasMore) html += `<div class="profile-data-paging"><button type="button" data-profile-page="${Math.max(0, data.offset - data.limit)}" ${data.offset ? '' : 'disabled'}>Previous</button><span>${number(data.offset + 1)}–${number(data.offset + data.rows.length)} / ${number(data.total)}</span><button type="button" data-profile-page="${data.offset + data.limit}" ${data.hasMore ? '' : 'disabled'}>Next</button></div>`;
            if (section === 'board' && data.meetings?.length) html += `<h3>Trade meetings</h3><ul>${data.meetings.map(row => `<li>#${Number(row.id)} · ${escape(row.state)} · ${escape(row.town)}${row.reason ? ` · ${escape(label(row.reason))}` : ''}</li>`).join('')}</ul>`;
        }
        return html + (error ? '<button type="button" data-profile-retry>Retry</button>' : '') + '</section>';
    }
    return { renderEconomy, renderCollection };
}));
