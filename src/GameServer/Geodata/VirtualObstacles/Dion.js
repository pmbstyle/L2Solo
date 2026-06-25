module.exports = {
    name: "Dion Town",
    region: "20_22",
    
    // Developer: Add custom virtual obstacles below to prevent bots from walking through solid structures.
    // Use the coordinates from the map/game client to define town walls and buildings with doors.
    
    walls: [
        // Example:
        // { type: "horizontal", y: 142979, minX: 13000, maxX: 17000, gateX: 15664, gateWidth: 300 }
    ],
    
    buildings: [
        // Example:
        // { type: "box_door", minX: 15000, maxX: 15500, minY: 142000, maxY: 142500, doorWall: 'N', doorMin: 15200, doorMax: 15300 }
    ]
};
