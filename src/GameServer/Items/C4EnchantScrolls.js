const ENCHANT_SCROLLS = {
    729: { grade: 'A', target: 'weapon', scrollType: 'normal' },
    730: { grade: 'A', target: 'armor', scrollType: 'normal' },
    731: { grade: 'A', target: 'weapon', scrollType: 'crystal' },
    732: { grade: 'A', target: 'armor', scrollType: 'crystal' },
    947: { grade: 'B', target: 'weapon', scrollType: 'normal' },
    948: { grade: 'B', target: 'armor', scrollType: 'normal' },
    949: { grade: 'B', target: 'weapon', scrollType: 'crystal' },
    950: { grade: 'B', target: 'armor', scrollType: 'crystal' },
    951: { grade: 'C', target: 'weapon', scrollType: 'normal' },
    952: { grade: 'C', target: 'armor', scrollType: 'normal' },
    953: { grade: 'C', target: 'weapon', scrollType: 'crystal' },
    954: { grade: 'C', target: 'armor', scrollType: 'crystal' },
    955: { grade: 'D', target: 'weapon', scrollType: 'normal' },
    956: { grade: 'D', target: 'armor', scrollType: 'normal' },
    957: { grade: 'D', target: 'weapon', scrollType: 'crystal' },
    958: { grade: 'D', target: 'armor', scrollType: 'crystal' },
    959: { grade: 'S', target: 'weapon', scrollType: 'normal' },
    960: { grade: 'S', target: 'armor', scrollType: 'normal' },
    961: { grade: 'S', target: 'weapon', scrollType: 'crystal' },
    962: { grade: 'S', target: 'armor', scrollType: 'crystal' },
    6569: { grade: 'A', target: 'weapon', scrollType: 'blessed' },
    6570: { grade: 'A', target: 'armor', scrollType: 'blessed' },
    6571: { grade: 'B', target: 'weapon', scrollType: 'blessed' },
    6572: { grade: 'B', target: 'armor', scrollType: 'blessed' },
    6573: { grade: 'C', target: 'weapon', scrollType: 'blessed' },
    6574: { grade: 'C', target: 'armor', scrollType: 'blessed' },
    6575: { grade: 'D', target: 'weapon', scrollType: 'blessed' },
    6576: { grade: 'D', target: 'armor', scrollType: 'blessed' },
    6577: { grade: 'S', target: 'weapon', scrollType: 'blessed' },
    6578: { grade: 'S', target: 'armor', scrollType: 'blessed' }
};

function resolve(selfId) {
    return ENCHANT_SCROLLS[Number(selfId)] || null;
}

module.exports = {
    ENCHANT_SCROLLS,
    resolve
};
