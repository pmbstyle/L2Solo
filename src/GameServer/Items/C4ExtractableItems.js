const EXTRACTABLE_ITEMS = {
    5134: { products: [{ selfId: 1835, amount: 300, chance: 100 }] },
    5135: { products: [{ selfId: 1463, amount: 300, chance: 100 }] },
    5136: { products: [{ selfId: 1464, amount: 300, chance: 100 }] },
    5137: { products: [{ selfId: 1465, amount: 300, chance: 100 }] },
    5138: { products: [{ selfId: 1466, amount: 300, chance: 100 }] },
    5139: { products: [{ selfId: 1467, amount: 300, chance: 100 }] },
    5140: { products: [{ selfId: 2509, amount: 300, chance: 100 }] },
    5141: { products: [{ selfId: 2510, amount: 300, chance: 100 }] },
    5142: { products: [{ selfId: 2511, amount: 300, chance: 100 }] },
    5143: { products: [{ selfId: 2512, amount: 300, chance: 100 }] },
    5144: { products: [{ selfId: 2513, amount: 300, chance: 100 }] },
    5145: { products: [{ selfId: 2514, amount: 300, chance: 100 }] },
    5146: { products: [{ selfId: 3947, amount: 300, chance: 100 }] },
    5147: { products: [{ selfId: 3948, amount: 300, chance: 100 }] },
    5148: { products: [{ selfId: 3949, amount: 300, chance: 100 }] },
    5149: { products: [{ selfId: 3950, amount: 300, chance: 100 }] },
    5150: { products: [{ selfId: 3951, amount: 300, chance: 100 }] },
    5151: { products: [{ selfId: 3952, amount: 300, chance: 100 }] }
};

function resolve(selfId) {
    return EXTRACTABLE_ITEMS[Number(selfId)] || null;
}

function rollProducts(extractableItem, rng = Math.random) {
    if (!extractableItem) {
        return [];
    }

    const roll = Math.floor(rng() * 100);
    let chanceFrom = 0;
    for (const productGroup of extractableItem.products) {
        const chance = Number(productGroup.chance) || 0;
        if (roll >= chanceFrom && roll < chanceFrom + chance) {
            return [productGroup].map((product) => ({
                selfId: product.selfId,
                amount: product.amount
            }));
        }
        chanceFrom += chance;
    }

    return [];
}

module.exports = {
    EXTRACTABLE_ITEMS,
    resolve,
    rollProducts
};
