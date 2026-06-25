module.exports = {
    name: "Oren Town",
    region: "22_19",
    
    // Developer: Add custom virtual obstacles below to prevent bots from walking through solid structures.
    // Use the coordinates from the map/game client to define town walls and buildings with doors.
    
    walls: [
        // Example:
        // { type: "horizontal", y: 53177, minX: 81000, maxX: 85000, gateX: 82960, gateWidth: 300 }
    ],
    
    buildings: [
        // Example:
        // { type: "box_door", minX: 82500, maxX: 83000, minY: 52500, maxY: 53000, doorWall: 'W', doorMin: 52700, doorMax: 52800 }
    ]
};
