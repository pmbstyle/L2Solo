'use strict';

function canonicalize(inventory = {}) {
    return Object.entries(inventory || {}).reduce((summary, [key, item]) => {
        if (!item || !Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0) return summary;
        summary[key] = item;
        return summary;
    }, {});
}

module.exports = {
    canonicalize
};
