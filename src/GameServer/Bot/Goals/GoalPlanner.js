function plan(candidates = {}, now = Date.now()) {
    const list = Array.isArray(candidates) ? candidates : [];
    const available = list.filter((candidate) => (
        candidate &&
        Array.isArray(candidate.blockers) && candidate.blockers.length === 0 &&
        (!candidate.nextReviewAt || Number(candidate.nextReviewAt) > now)
    ));
    const selected = (available.length ? available : list)
        .slice()
        .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))[0] || null;
    if (!selected) return null;

    return {
        type: selected.type,
        status: selected.blockers?.length ? 'blocked' : 'active',
        priority: selected.priority,
        target: selected.target || {},
        plan: selected.plan || {},
        progress: selected.progress || {},
        blockers: selected.blockers || [],
        reviewedAt: now,
        nextReviewAt: selected.nextReviewAt || now + 60000
    };
}

module.exports = { plan };
