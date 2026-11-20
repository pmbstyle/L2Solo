'use strict';

function hasRequiredSkillItems(actor, skill) {
    const itemId = Number(skill.fetchItemConsumeId?.()) || 0;
    const count = Number(skill.fetchItemConsumeCount?.()) || 0;
    if (!itemId || count <= 0) return true;

    const item = actor?.backpack?.fetchItemFromSelfId?.(itemId);
    return (Number(item?.fetchAmount?.()) || 0) >= count;
}

module.exports = { hasRequiredSkillItems };
