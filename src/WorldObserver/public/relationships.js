(function expose(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldObserverRelationships = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const labels = { friendly: 'Friendly', familiar: 'Familiar', wary: 'Wary', hostile: 'Hostile', unknown: 'Unfamiliar' };
    const reasons = { hunted_together: 'Hunted with me', helped_in_combat: 'Helped me in combat', healed: 'Healed me',
        resurrected: 'Resurrected me', resources_received: 'Shared resources with me', mob_contested: 'Contested my mob',
        attacked: 'Attacked me', killed: 'Killed me', aided_opponent: 'Helped my opponent' };
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const number = value => Math.abs(Number(value) || 0) < 0.05 ? '0' : Number(value).toFixed(1).replace(/\.0$/, '');
    const signed = value => (value >= 0.05 ? '+' : '') + number(value);
    function category(row) {
        return ['hostile', 'wary'].includes(row.disposition) || row.personal.fear >= 0.5 ? 'tension'
            : row.disposition === 'friendly' ? 'friendly' : 'familiar';
    }
    function strength(row) {
        const p = row.personal;
        return Math.max(Math.abs(p.affinity), Math.abs(p.trust), p.hostility, p.fear);
    }
    function render(view, { ownerName = 'This bot', filter = 'all', expanded = false, relative = () => '' } = {}) {
        if (!view?.ready) return '<p class="relationship-note">Relationship memory is not available yet.</p>';
        const rows = [...view.relations].sort((a, b) =>
            (category(b) === 'tension') - (category(a) === 'tension') || strength(b) - strength(a) || a.targetId - b.targetId);
        const selected = rows.filter(r => filter === 'all' || category(r) === filter);
        const filters = [['all', 'All'], ['friendly', 'Friendly'], ['tension', 'Tension']].map(([key, label]) => {
            const count = rows.filter(r => key === 'all' || category(r) === key).length;
            return `<button type="button" data-relationship-filter="${key}" aria-pressed="${filter === key}">${label} <span>${count}</span></button>`;
        }).join('');
        const cards = (expanded ? selected : selected.slice(0, 6)).map(row => {
            const name = escape(row.name), kind = ['bot', 'player'].includes(row.actorKind) ? row.actorKind : null;
            const identity = kind ? `<a class="inspector-link" href="/observer/actors/${kind}/${Number(row.targetId)}" data-relationship-id="${Number(row.targetId)}" data-relationship-kind="${kind}">${name}</a>` : `<span>${name}</span>`;
            const personal = row.personal, clan = row.clan;
            const influence = !clan?.id ? 'No clan affiliation' : !clan.ready ? 'Clan memory unavailable'
                : `Clan influence: trust ${signed((clan.effective?.trust || 0) - personal.trust)} · hostility ${signed((clan.effective?.hostility || 0) - personal.hostility)}`;
            return `<article class="relationship-row ${category(row)}">
                <div class="relationship-heading">${identity}<span class="relationship-stance ${escape(row.disposition)}">${escape(labels[row.disposition] || 'Familiar')}</span></div>
                <div class="relationship-scores">Warmth ${number(personal.affinity)} · Trust ${number(personal.trust)} · Hostility ${number(personal.hostility)}${personal.fear >= 0.05 ? ` · Fear ${number(personal.fear)}` : ''}</div>
                <div class="relationship-clan">${row.sameClan ? 'Same clan · ' : ''}${influence}</div>
                <ul class="relationship-reasons">${row.reasons.map(r => `<li><span>${escape(reasons[r.type] || 'Remembered interaction')}</span><time title="${escape(new Date(r.at).toISOString())}">${escape(relative(r.at))}</time></li>`).join('')}</ul>
            </article>`;
        }).join('');
        return `<p class="relationship-note">${escape(ownerName)} → others. Feelings may not be mutual.</p>
            <div class="relationship-filters" aria-label="Filter relationships">${filters}</div>
            ${rows.length ? `<div class="relationship-list">${cards || '<p class="relationship-note">No remembered relationships in this group.</p>'}</div>` : '<p class="relationship-note">No personal encounters remembered yet.</p>'}
            ${selected.length > 6 ? `<button type="button" class="relationship-more" data-relationship-expand>${expanded ? 'Show fewer' : `Show all ${selected.length}`}</button>` : ''}`;
    }
    return { render, category };
}));
