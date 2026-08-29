const TOWN_NPC_SELLERS = {
    Giran: [7081, 7082, 7084, 7085, 7087, 7088, 7090, 7091, 7093, 7094, 7829],
    Oren: [7178, 7179, 7180, 7181],
    Gludio: [7313, 7314, 7315],
    Gludin: [7060, 7061, 7062, 7063, 7207, 7208, 7209, 7321],
    'Talking Island': [7001, 7002, 7003, 7004],
    Aden: [7837, 7838, 7839, 7840, 7841, 7842, 7831, 7869],
    'Hunter\'s Village': [7230, 7231, 7235, 7301, 7684],
    'Dwarven Village': [7516, 7517, 7518, 7519],
    'Elven Village': [7135, 7136, 7137, 7138],
    'Dark Elven Village': [7147, 7148, 7149, 7150],
    'Floran Village': [7078, 7436, 7437],
    Cema: [7834],
    Goddard: [8256],
    Rune: [8300],
    'Orc Village': [7558, 7559, 7560, 7561],
    Dion: [7253, 7254, 7294],
    Heine: [7731, 7827, 7828, 7830]
};

Object.values(TOWN_NPC_SELLERS).forEach(Object.freeze);

module.exports = Object.freeze(TOWN_NPC_SELLERS);
