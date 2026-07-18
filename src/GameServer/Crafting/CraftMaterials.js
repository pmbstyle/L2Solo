function materialPlan(backpack, materials) {
    const remaining = new Map();
    materials.forEach(({ selfId, amount }) => {
        remaining.set(Number(selfId), (remaining.get(Number(selfId)) || 0) + Number(amount));
    });

    const plan = [];
    for (const [selfId, required] of remaining) {
        let left = required;
        const items = backpack.fetchItems()
            .filter((item) => Number(item.fetchSelfId()) === selfId && !item.fetchEquipped?.());
        for (const item of items) {
            const used = Math.min(left, Number(item.fetchAmount()) || 0);
            if (used > 0) plan.push({ item, amount: used });
            left -= used;
            if (left === 0) break;
        }
        if (left > 0) return null;
    }
    return plan;
}

module.exports = { materialPlan };
