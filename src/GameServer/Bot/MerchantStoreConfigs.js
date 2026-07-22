const BUY_CAP = 999999;

const s = (selfId, priceRate, count) => ({ selfId, priceRate, count });
const b = (selfId, priceRate, count = BUY_CAP) => ({ selfId, priceRate, count });

module.exports = {
    // Talking Island
    "Mira": {
        title: "Local mats",
        town: "Talking Island",
        storeType: 1,
        locX: -84168, locY: 244729, locZ: -3730,
        items: [
            s(1864, 0.68, 5000), s(1865, 0.72, 4000), s(1866, 0.70, 3500),
            s(1867, 0.74, 4500), s(1868, 0.66, 5000), s(1869, 0.72, 3500),
            s(1060, 0.78, 250), s(736, 0.75, 150), s(1835, 0.70, 30000)
        ]
    },
    "Korin": {
        title: "Starter gear",
        town: "Talking Island",
        storeType: 1,
        locX: -84230, locY: 244835, locZ: -3730,
        items: [
            s(14, 0.66, 6), s(9, 0.65, 4), s(22, 0.72, 12),
            s(29, 0.72, 12), s(37, 0.70, 10), s(49, 0.70, 10),
            s(2006, 0.62, 60), s(2007, 0.62, 60), s(1796, 0.60, 25)
        ]
    },
    "Nika": {
        title: "Buy starter mats",
        town: "Talking Island",
        storeType: 3,
        locX: -84120, locY: 244760, locZ: -3730,
        items: [
            b(1864, 0.62), b(1865, 0.60), b(1866, 0.58), b(1867, 0.62),
            b(1868, 0.60), b(1869, 0.60), b(1870, 0.58), b(1871, 0.58),
            b(1872, 0.62), b(17, 0.55)
        ]
    },
    "Tarin": {
        title: "Buy island drops",
        town: "Talking Island",
        storeType: 3,
        locX: -84062, locY: 244688, locZ: -3730,
        items: [
            b(1121, 0.62), b(1119, 0.62), b(1122, 0.62), b(1129, 0.62),
            b(112, 0.66), b(116, 0.66), b(118, 0.66), b(19, 0.64),
            b(42, 0.64), b(2006, 0.68), b(2007, 0.68), b(1788, 0.64)
        ]
    },

    // Gludio
    "Lysa": {
        title: "D mats and gear",
        town: "Gludio",
        storeType: 1,
        locX: -14590, locY: 123650, locZ: -3117,
        items: [
            s(1867, 0.70, 5000), s(1869, 0.72, 5000), s(1870, 0.70, 4000),
            s(1871, 0.68, 4000), s(1872, 0.70, 5000), s(1873, 0.74, 2500),
            s(1880, 0.78, 1200), s(15, 0.64, 5), s(216, 0.66, 7)
        ]
    },
    "Darin": {
        title: "Gludio stock",
        town: "Gludio",
        storeType: 1,
        locX: -14370, locY: 123650, locZ: -3117,
        items: [
            s(22, 0.68, 20), s(24, 0.68, 10), s(31, 0.68, 10),
            s(38, 0.72, 12), s(50, 0.72, 12), s(43, 0.70, 10),
            s(1921, 0.62, 150), s(1922, 0.62, 120), s(1923, 0.62, 120)
        ]
    },
    "Ewan": {
        title: "Buy D mats",
        town: "Gludio",
        storeType: 3,
        locX: -14590, locY: 123360, locZ: -3117,
        items: [
            b(1867, 0.64), b(1868, 0.62), b(1869, 0.62), b(1870, 0.62),
            b(1871, 0.62), b(1872, 0.64), b(1873, 0.66), b(1880, 0.66),
            b(1878, 0.64), b(1341, 0.55)
        ]
    },
    "Maren": {
        title: "Buy plains drops",
        town: "Gludio",
        storeType: 3,
        locX: -14370, locY: 123360, locZ: -3117,
        items: [
            b(1921, 0.70), b(1922, 0.70), b(1923, 0.70), b(1924, 0.70),
            b(1925, 0.70), b(2011, 0.68), b(2012, 0.68), b(2013, 0.68),
            b(1792, 0.66), b(1793, 0.66), b(1794, 0.66), b(1798, 0.66)
        ]
    },

    // Dion
    "Rina": {
        title: "C craft stock",
        town: "Dion",
        storeType: 1,
        locX: 15814, locY: 143129, locZ: -2707,
        items: [
            s(1873, 0.72, 3500), s(1879, 0.70, 2500), s(1880, 0.70, 2500),
            s(1881, 0.70, 2200), s(1882, 0.68, 3000), s(1883, 0.72, 800),
            s(1884, 0.66, 3000), s(272, 0.62, 4), s(219, 0.63, 5)
        ]
    },
    "Soren": {
        title: "Dion gear parts",
        town: "Dion",
        storeType: 1,
        locX: 15910, locY: 143025, locZ: -2707,
        items: [
            s(58, 0.65, 6), s(59, 0.65, 6), s(61, 0.68, 10),
            s(63, 0.68, 10), s(103, 0.68, 6), s(1882, 0.68, 3000),
            s(2143, 0.64, 100), s(2144, 0.64, 100), s(2139, 0.64, 80)
        ]
    },
    "Vera": {
        title: "Buy C mats",
        town: "Dion",
        storeType: 3,
        locX: 15860, locY: 143100, locZ: -2707,
        items: [
            b(1873, 0.66), b(1879, 0.66), b(1880, 0.66), b(1881, 0.64),
            b(1882, 0.64), b(1883, 0.62), b(1884, 0.64), b(1885, 0.62),
            b(1887, 0.60), b(1888, 0.60)
        ]
    },
    "Borin": {
        title: "Buy Dion drops",
        town: "Dion",
        storeType: 3,
        locX: 15725, locY: 143055, locZ: -2707,
        items: [
            b(2015, 0.68), b(2009, 0.68), b(2150, 0.66), b(2252, 0.66),
            b(2253, 0.66), b(2254, 0.66), b(956, 0.62), b(955, 0.62),
            b(37, 0.62), b(49, 0.62), b(44, 0.62), b(102, 0.62)
        ]
    },

    // Giran
    "Elin": {
        title: "C/B materials",
        town: "Giran",
        storeType: 1,
        locX: 83550, locY: 148093, locZ: -3406,
        items: [
            s(1881, 0.68, 2500), s(1882, 0.68, 3500), s(1883, 0.70, 1200),
            s(1885, 0.66, 1500), s(1887, 0.64, 800), s(1888, 0.64, 800),
            s(1889, 0.66, 1400), s(78, 0.61, 2), s(91, 0.62, 3)
        ]
    },
    "Naren": {
        title: "Giran gear",
        town: "Giran",
        storeType: 1,
        locX: 83445, locY: 148170, locZ: -3406,
        items: [
            s(60, 0.62, 4), s(62, 0.66, 8), s(64, 0.66, 8),
            s(119, 0.66, 6), s(117, 0.66, 8), s(845, 0.68, 8),
            s(877, 0.68, 10), s(908, 0.68, 6), s(1539, 0.76, 500)
        ]
    },
    "Pavel": {
        title: "Buy Giran mats",
        town: "Giran",
        storeType: 3,
        locX: 83510, locY: 148120, locZ: -3406,
        items: [
            b(1881, 0.64), b(1882, 0.64), b(1883, 0.62), b(1885, 0.62),
            b(1887, 0.60), b(1888, 0.60), b(1889, 0.62), b(1890, 0.58),
            b(1893, 0.56), b(1894, 0.60)
        ]
    },
    "Tessa": {
        title: "Buy Giran drops",
        town: "Giran",
        storeType: 3,
        locX: 83385, locY: 148035, locZ: -3406,
        items: [
            b(2140, 0.66), b(2142, 0.66), b(2143, 0.66), b(2144, 0.66),
            b(2173, 0.66), b(2174, 0.66), b(2175, 0.66), b(956, 0.62),
            b(955, 0.62), b(219, 0.58), b(272, 0.58), b(309, 0.58)
        ]
    },

    // Oren
    "Iris": {
        title: "B/A materials",
        town: "Oren",
        storeType: 1,
        locX: 83110, locY: 53327, locZ: -1497,
        items: [
            s(1885, 0.66, 2500), s(1886, 0.62, 600), s(1887, 0.62, 1200),
            s(1888, 0.62, 1200), s(1889, 0.64, 2200), s(1890, 0.60, 700),
            s(1893, 0.60, 450), s(1894, 0.62, 1400), s(80, 0.60, 2)
        ]
    },
    "Helga": {
        title: "Oren gear",
        town: "Oren",
        storeType: 1,
        locX: 83020, locY: 53245, locZ: -1497,
        items: [
            s(79, 0.60, 3), s(97, 0.60, 3), s(98, 0.60, 2),
            s(442, 0.61, 3), s(473, 0.61, 3), s(603, 0.62, 5),
            s(2463, 0.62, 5), s(856, 0.64, 6), s(887, 0.64, 8)
        ]
    },
    "Oskar": {
        title: "Buy Oren mats",
        town: "Oren",
        storeType: 3,
        locX: 83150, locY: 53300, locZ: -1497,
        items: [
            b(1885, 0.62), b(1886, 0.58), b(1887, 0.60), b(1888, 0.60),
            b(1889, 0.62), b(1890, 0.58), b(1893, 0.56), b(1894, 0.60),
            b(1874, 0.58), b(1875, 0.58)
        ]
    },
    "Selin": {
        title: "Buy Oren drops",
        town: "Oren",
        storeType: 3,
        locX: 83245, locY: 53270, locZ: -1497,
        items: [
            b(1830, 0.60), b(1343, 0.55), b(1539, 0.62), b(91, 0.56),
            b(212, 0.56), b(284, 0.56), b(79, 0.56), b(97, 0.56),
            b(856, 0.58), b(887, 0.58), b(918, 0.58)
        ]
    }
};
