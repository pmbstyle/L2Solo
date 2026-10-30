(function expose(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldObserverClanWars = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const labels = { mutual: 'At war', outgoing: 'Declared war', incoming: 'Incoming declaration' };
    const phases = { assembling: 'Gathering the party', traveling: 'Traveling to the target', searching: 'Searching the area',
        engaging: 'Engaging the enemy', fighting: 'Fighting', holding: 'Holding the spot', returning: 'Returning home' };
    const reasons = { accept_war: 'Answering a war declaration', repeated_clan_aggression: 'Repeated aggression against the clan',
        conflict_cooled: 'The conflict has cooled', war_losses: 'Repeated military losses', war_casualties: 'Heavy clan casualties', manual: 'Clan command', clan_dissolved: 'Clan dissolved' };
    const outcomes = { assembled: 'War party formed', spot_cleared: 'Enemy spot cleared', losses: 'Retreat after losses',
        time_limit: 'Expedition time elapsed', war_ended: 'War ended; returning home', roster_changed: 'Party changed; returning home' };
    const assemblyReasons = { waiting_slot: 'Waiting for a shared party slot', party_capacity_wait: 'Waiting for a shared party slot',
        waiting_budget: 'Waiting for server capacity', forming: 'Forming the party', member_busy: 'Member busy; retrying',
        roster_changed: 'Rechecking the roster', formation_retry: 'Retrying formation', roster_not_ready: 'Waiting for a healer and two fighters',
        no_fresh_intel: 'Waiting for a fresh enemy sighting', operation_capacity: 'All military operation slots are occupied',
        operation_cooldown: 'Resting before another expedition', ready: 'Roster ready; waiting in the military queue' };
    function relations(snapshot, clanId) {
        const rows = snapshot?.declarations || [], own = Number(clanId), targets = new Set();
        for (const row of rows) if (row.active === 1) {
            if (row.fromClanId === own) targets.add(row.toClanId);
            if (row.toClanId === own) targets.add(row.fromClanId);
        }
        return [...targets].map(id => {
            const outgoing = rows.find(r => r.fromClanId === own && r.toClanId === id && r.active === 1);
            const incoming = rows.find(r => r.toClanId === own && r.fromClanId === id && r.active === 1);
            return { id, status: outgoing && incoming ? 'mutual' : outgoing ? 'outgoing' : 'incoming',
                since: Math.max(outgoing?.declaredAt || 0, incoming?.declaredAt || 0) };
        }).sort((a, b) => (b.status === 'mutual') - (a.status === 'mutual') || a.id - b.id);
    }
    function summary(snapshot, clanId) {
        if (!snapshot) return null;
        const rows = relations(snapshot, clanId), mutual = rows.filter(r => r.status === 'mutual').length;
        return { mutual, pending: rows.length - mutual, total: rows.length,
            label: mutual ? `At war · ${mutual}` : rows.length ? `Declarations · ${rows.length}` : 'At peace',
            tone: mutual ? 'mutual' : rows.length ? 'pending' : 'peace' };
    }
    function render(snapshot, clanId, { clans = [], error = null, relative = () => '', time = () => '', now = Date.now() } = {}) {
        if (!snapshot) return `<p class="clan-war-note" role="status">${error ? 'War data is unavailable. The next update will retry.' : 'Loading diplomacy and expeditions…'}</p>`;
        const own = Number(clanId), names = new Map([...clans, ...(snapshot.clans || [])].map(c => [Number(c.id), c.name]));
        const name = id => names.get(Number(id)) || `Clan ${Number(id)}`;
        const link = id => `<a href="/observer/clans/${Number(id)}" data-war-clan-id="${Number(id)}">${escape(name(id))}</a>`;
        const rows = relations(snapshot, own), brief = summary(snapshot, own);
        const operations = (snapshot.campaigns?.operations || []).filter(op => op.clanId === own || op.enemyClanId === own);
        const plan = snapshot.campaigns?.plans?.find(p => p.clanId === own), decision = plan?.lastDecision;
        const queued = snapshot.campaigns?.assembly?.queue?.find(r => r.clanId === own);
        const readiness = snapshot.campaigns?.assembly?.readiness?.find(r => r.clanId === own);
        const age = at => `<time title="${escape(time(at))}">${escape(relative(at))}</time>`;
        const until = at => { const seconds = Math.max(1, Math.ceil((at - now) / 1000));
            return seconds < 60 ? `in ${seconds}s` : `in ${Math.ceil(seconds / 60)}m`; };
        const recent = (snapshot.events || []).filter(e => e.fromClanId === own || e.toClanId === own).slice(0, 6);
        return `<div class="clan-war-heading"><div><span class="section-kicker">Diplomacy &amp; expeditions</span><h4>Clan wars</h4></div><span class="clan-war-badge ${brief.tone}">${brief.label}</span></div>
            ${error ? '<p class="clan-war-note is-stale" role="status">Update failed. Showing the last received war state.</p>' : ''}
            ${snapshot.enabled === false || snapshot.campaigns?.active !== true ? '<p class="clan-war-note">Autonomous military planning is paused. Formal declarations remain in effect.</p>' : ''}
            <div class="clan-war-relations">${rows.length ? rows.map(r => `<article class="clan-war-relation ${r.status}"><div>${link(r.id)}<span class="clan-war-badge ${r.status}">${labels[r.status]}</span></div><p>${r.status === 'mutual' ? 'Both clans have declared war.' : r.status === 'outgoing' ? 'The other clan has not declared back.' : 'This clan has not declared back.'}</p>${r.since ? age(r.since) : ''}</article>`).join('') : '<p class="clan-war-note">No active war declarations.</p>'}</div>
            ${decision ? `<p class="clan-war-decision"><strong>${decision.accepted ? decision.action === 'withdraw' ? 'Withdrew war' : decision.reason === 'accept_war' ? 'Accepted war' : 'Declared war' : 'Decision deferred'}</strong> · ${link(decision.targetClanId)}<span>${escape(reasons[decision.reason] || 'Clan diplomatic review')} · ${escape(relative(decision.at))}</span></p>` : ''}
            ${Object.entries(plan?.ceasefires || {}).filter(([, pause]) => pause.until > now).map(([id, pause]) => `<p class="clan-war-note">Cooling off against ${link(id)} · ${escape(time(pause.until))}<br>New declarations can still be answered.</p>`).join('')}
            ${(plan?.warPressure || []).map(p => `<p class="clan-war-note">Last hour against ${link(p.enemyClanId)}: ${Number(p.losses)} deaths across ${Number(p.victims)} members · ${Number(p.kills)} enemy kills</p>`).join('')}
            ${plan?.lossResponse?.until > now ? `<p class="clan-war-note"><strong>${plan.lossResponse.action === 'counterattack' ? 'Preparing a counterattack' : 'Seeking to end the war'}</strong> · ${link(plan.lossResponse.enemyClanId)}${plan.lossResponse.action === 'counterattack' ? '<br>Expedition cooldown reduced; a fresh sighting and a ready roster are still required.' : ''}</p>` : ''}
            <div class="clan-war-operation-heading"><strong>Expeditions</strong><span>${operations.length} active</span></div>
            ${queued ? `<p class="clan-war-note"><strong>Roster ready · ${Number(queued.members)} members</strong> → ${link(queued.enemyClanId)}<br>${escape(assemblyReasons[queued.reason] || 'Waiting for formation')} · Priority held since ${escape(time(queued.queuedAt))}</p>`
                : readiness && readiness.reason !== 'operation_active' ? `<p class="clan-war-note">${escape(assemblyReasons[readiness.reason] || 'Military readiness is being checked')}</p>` : ''}
            <div class="clan-war-operations">${operations.length ? operations.map(op => `<article class="clan-war-operation${op.clanId !== own ? ' is-incoming' : ''}"><div class="clan-war-operation-title"><strong>${link(op.clanId)} → ${link(op.enemyClanId)}</strong><span>${escape(phases[op.phase || op.status] || 'On expedition')}</span></div><p>${op.clanId !== own ? 'Incoming raid' : op.kind === 'defend_spot' ? 'Defend a farm spot' : 'Raid an enemy farm'} · ${Number.isInteger(op.livingMembers) ? `${op.livingMembers}/${(op.memberIds || []).length} members alive` : `${(op.memberIds || []).length} members`}</p><div class="clan-war-destination"><span>${escape(op.phase === 'returning' ? op.homeName || 'Home farm spot' : op.targetName || 'Witnessed enemy location')}</span><small>${op.arrivalAt > now ? `Arrival ${until(op.arrivalAt)}` : op.expiresAt > now ? `Order ends ${until(op.expiresAt)}` : 'Returning order pending'}</small></div><a class="clan-war-map-link" href="/observer/world?clanId=${Number(op.clanId)}" data-clan-map-id="${Number(op.clanId)}" data-clan-map-name="${escape(name(op.clanId))}">Show expedition clan on map</a></article>`).join('') : '<p class="clan-war-note">No military parties deployed.</p>'}</div>
            ${plan?.lastOperation ? `<p class="clan-war-note">Latest expedition: ${escape(outcomes[plan.lastOperation.outcome] || 'Expedition updated')} · ${escape(relative(plan.lastOperation.at))}</p>` : ''}
            ${recent.length ? `<details class="clan-war-history"><summary>War history <span>${recent.length} recent events</span></summary>${recent.map(e => `<div class="clan-war-event"><div>${link(e.fromClanId)} ${e.action === 'declare' ? 'declared war on' : 'withdrew war against'} ${link(e.toClanId)}<small>${escape(reasons[e.reason] || 'Clan diplomatic command')}</small></div>${age(e.createdAt)}</div>`).join('')}</details>` : ''}`;
    }
    return { relations, summary, render };
}));
