const MAX_TITLE_LENGTH = 28;

function itemLabel(item) {
    const name = String(item?.name || `Item ${item?.selfId || '?'}`)
        .replace(/\s+/g, ' ')
        .trim();
    const count = Math.max(0, Number(item?.count || 0));
    return count > 1 ? `${name} x${count}` : name;
}

function truncate(text, limit = MAX_TITLE_LENGTH) {
    if (text.length <= limit) return text;
    if (limit <= 3) return text.slice(0, limit);
    return `${text.slice(0, limit - 3).trimEnd()}...`;
}

// C4's private-store overlay has very little usable width. The badge already
// identifies a sell store, so spend the entire title on the actual inventory.
function marketStoreTitle(items, limit = MAX_TITLE_LENGTH) {
    const labels = (items || [])
        .filter((item) => Number(item?.count || 0) > 0)
        .map(itemLabel)
        .filter(Boolean);
    if (!labels.length) return 'Stock updating';

    let title = '';
    let used = 0;
    for (const label of labels) {
        const candidate = title ? `${title}, ${label}` : label;
        if (candidate.length > limit) break;
        title = candidate;
        used += 1;
    }

    if (!title) return truncate(labels[0], limit);
    const remaining = labels.length - used;
    if (!remaining) return title;

    const suffix = ` +${remaining}`;
    if (title.length + suffix.length <= limit) return `${title}${suffix}`;
    return truncate(title, limit);
}

module.exports = { MAX_TITLE_LENGTH, marketStoreTitle };
