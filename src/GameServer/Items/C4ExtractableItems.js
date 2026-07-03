const fs = require('fs');

const EXTRACTABLE_DATA_PATH = 'data/ExtractableItems/extractable_items.csv';

let extractableItems = null;

function parseProductGroup(value) {
    const parts = String(value || '').split(',').map((part) => Number(part));
    if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) {
        return null;
    }

    const chance = parts[parts.length - 1];
    const itemParts = parts.slice(0, -1);
    const items = [];
    for (let index = 0; index < itemParts.length; index += 2) {
        items.push({
            selfId: itemParts[index],
            amount: itemParts[index + 1]
        });
    }

    if (items.length === 1) {
        return {
            selfId: items[0].selfId,
            amount: items[0].amount,
            chance
        };
    }

    return { items, chance };
}

function parseLine(line) {
    const clean = String(line || '').trim();
    if (!clean || clean.startsWith('#')) {
        return null;
    }

    const parts = clean.split(';');
    const selfId = Number(parts.shift());
    if (!Number.isFinite(selfId)) {
        return null;
    }

    const products = parts.map(parseProductGroup).filter(Boolean);
    const fullChance = products.reduce((total, product) => total + (Number(product.chance) || 0), 0);
    if (fullChance > 100) {
        return null;
    }

    return { selfId, products };
}

function loadExtractableItems() {
    if (extractableItems) {
        return extractableItems;
    }

    extractableItems = {};
    if (!fs.existsSync(EXTRACTABLE_DATA_PATH)) {
        return extractableItems;
    }

    fs.readFileSync(EXTRACTABLE_DATA_PATH, 'utf8')
        .split(/\r?\n/)
        .map(parseLine)
        .filter(Boolean)
        .forEach((extractableItem) => {
            extractableItems[extractableItem.selfId] = {
                products: extractableItem.products
            };
        });

    return extractableItems;
}

function resolve(selfId) {
    return loadExtractableItems()[Number(selfId)] || null;
}

function normalizeProductGroup(productGroup) {
    if (Array.isArray(productGroup.items)) {
        return productGroup.items
            .filter((product) => Number(product.selfId) > 0 && Number(product.amount) > 0)
            .map((product) => ({
                selfId: product.selfId,
                amount: product.amount
            }));
    }

    if (Number(productGroup.selfId) <= 0 || Number(productGroup.amount) <= 0) {
        return [];
    }

    return [{ selfId: productGroup.selfId, amount: productGroup.amount }];
}

function rollProducts(extractableItem, rng = Math.random) {
    if (!extractableItem) {
        return [];
    }

    const roll = Math.floor(rng() * 100);
    let chanceFrom = 0;
    for (const productGroup of extractableItem.products) {
        const chance = Number(productGroup.chance) || 0;
        if (roll >= chanceFrom && roll <= chanceFrom + chance) {
            return normalizeProductGroup(productGroup);
        }
        chanceFrom += chance;
    }

    return [];
}

module.exports = {
    EXTRACTABLE_DATA_PATH,
    loadExtractableItems,
    resolve,
    rollProducts
};
