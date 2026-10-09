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
        + (row?.name || row?.reference ? ` · ${escape(row.name || row.reference)}` : '');
    const cell = (name, value) => `<div><span>${escape(name)}</span><strong>${value}</strong></div>`;
    function renderEconomy(economy) {
        if (!economy) return '<p class="muted-copy">No saved economic decision.</p>';
        const focus = economy.focus, action = economy.selectedAction, money = economy.money;
        const target = economy.acquisitionGoal;
        return `<section class="inspector-block"><h3>Wishes & next step</h3>
            <p>Current wish, chosen action, and money priorities.</p>
            <div class="detail-grid">${cell('Current wish', focus ? wish(focus) : 'No saved focus')}
            ${cell('Estimated price', `${number(focus?.estimatedPrice)} A`)}
            ${cell('Focus started at played hours', number(focus?.sincePlayedHours))}</div>
            <h3>Selected way forward</h3>${action ? `<p>${wish(action.root)} → <strong>${escape(label(action.activity))}</strong>${action.funding ? ' · earning money for the wish' : ''}</p>
                <div class="detail-grid">${action.item || action.inputKey ? cell('Input / product', action.item ? item(action.item) : escape(action.inputKey)) : ''}
                ${action.amount > 0 ? cell('Amount', number(action.amount)) : ''}${cell('Source', escape(source(action.source)))}
                ${action.npcId ? cell('NPC', `<a href="/observer/database/npcs/${Number(action.npcId)}" data-app-route>#${Number(action.npcId)}</a>`) : ''}
                ${action.town ? cell('Town', escape(action.town)) : ''}${action.spotId ? cell('Spot', escape(action.spotId)) : ''}
                ${action.recipeId ? cell('Recipe', `#${Number(action.recipeId)}`) : ''}${action.estimatedPrice > 0 ? cell('Estimated cost', `${number(action.estimatedPrice)} A`) : ''}
                ${action.effortHours != null ? cell('Estimated effort', `${number(action.effortHours)} h`) : ''}${action.funding && action.shortfall != null ? cell('Funding shortfall', `${number(action.shortfall)} A`) : ''}</div>`
                : '<p class="muted-copy">No selected step saved yet. It will appear after the next economic decision.</p>'}
            ${target ? `<h3>Saved acquisition goal</h3><p>${item(target.target)} · ${escape(label(target.status))}</p>
                ${target.next ? `<p>Next: ${escape(label(target.next.kind))}${target.next.item ? ` · ${item(target.next.item)}` : ''}${target.next.npcName ? ` · ${escape(target.next.npcName)}` : ''}${target.next.raidBoss ? ' · raid encounter' : ''}</p>` : ''}` : ''}
            ${economy.equipmentPlan ? `<p>Equipment plan: ${escape(label(economy.equipmentPlan.status))}${economy.equipmentPlan.reason ? ` · ${escape(label(economy.equipmentPlan.reason))}` : ''}</p>` : ''}
            ${money ? `<h3>Money plan</h3><div class="detail-grid">${cell('Wallet', `${number(money.wallet)} A`)}${cell('Survival reserve', `${number(money.survivalReserve)} A`)}
                ${cell('Estimated earnings', `${number(money.adenaPerHour)} A/h`)}${cell('First unfunded wish price', `${number(money.firstUnfundedPrice)} A`)}</div>
                <p>Allocations from the last decision · these are priorities, not money held in escrow.</p>
                ${money.funded.length ? `<ul>${money.funded.map(row => `<li>${row.item ? item(row.item) : 'Other wishes'} · ${number(row.cost)} A · cumulative ${number(row.cumulativeCost)} A</li>`).join('')}</ul>` : '<p>No saved allocations.</p>'}` : ''}
            ${economy.dormant.length ? `<h3>Deferred wishes</h3><ul>${economy.dormant.map(row => `<li>${wish(row)} · ${escape(label(row.reason))} · ${number(row.estimatedPrice)} A</li>`).join('')}</ul>` : ''}
        </section>`;
    }
    function renderCollection(section, data, { loading = false, error = null } = {}) {
        const names = { inventory: 'Inventory', warehouse: 'Personal warehouse', skills: 'Learned skills', pvp: 'PvP', board: 'Board listings' };
        let html = `<section class="inspector-block profile-data"><h3>${names[section]}</h3>`;
        if (error) html += `<p class="detail-error">Refresh failed: ${escape(error)}</p>`;
        if (!data) return html + `<p>${loading ? 'Loading…' : 'Open this tab to load data.'}</p>${error ? '<button type="button" data-profile-retry>Retry</button>' : ''}</section>`;
        html += `<p>${escape(label(data.source))} · observed ${escape(new Date(data.generatedAt).toLocaleTimeString())}${loading ? ' · refreshing' : ''}</p>`;
        if (section === 'pvp') {
            html += `<div class="detail-grid">${cell('PvP', number(data.totals.pvp))}${cell('PK', number(data.totals.pk))}${cell('Karma', number(data.totals.karma))}</div>`;
            if (data.lastEncounter) html += `<p>Last background encounter: ${escape(label(data.lastEncounter.outcome))} · ${escape(new Date(data.lastEncounter.at).toLocaleString())}</p>`;
            html += `<h3>Remembered enemies</h3>${data.enemies.length ? `<ul>${data.enemies.map(row => `<li>${escape(row.name || `#${row.id}`)} · ${number(row.kills)} deaths caused · ${number(row.attacks)} remembered attacks</li>`).join('')}</ul>` : '<p>No remembered enemies.</p>'}`;
            if (data.incidents.length) html += `<h3>Recent responsibility records</h3><ul>${data.incidents.map(row => `<li>${escape(label(row.responsibility))}${row.opponentId ? ` · #${Number(row.opponentId)}` : ''} · ${escape(new Date(row.at).toLocaleString())}</li>`).join('')}</ul>`;
        } else {
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
