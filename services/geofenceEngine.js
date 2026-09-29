// services/geofenceEngine.js
//
// Turns a user's (lat, lon) plus a set of Red/Yellow/Green radii (from
// services/zoneEngine.js) into a single membership label: which ring, if
// any, the user is currently standing inside.
//
// Deliberately has no DB access and no knowledge of alerts — it is pure
// math so it's trivial to unit-test. routes/geofence.js is the thin layer
// that wires this to `locations`, `user_zone_state`, and the alert engine.

const ZONE_ORDER = ["outside", "green", "yellow", "red"];

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Rings are concentric and nested (red is innermost). A point counts as
// "in" the tightest ring it falls within; anything past the green radius
// is 'outside'.
function classifyZone(distanceKm, radii) {
  if (distanceKm <= radii.red_radius_km) return "red";
  if (distanceKm <= radii.yellow_radius_km) return "yellow";
  if (distanceKm <= radii.green_radius_km) return "green";
  return "outside";
}

function zoneSeverity(zone) {
  const index = ZONE_ORDER.indexOf(zone);
  return index === -1 ? 0 : index;
}

function isUpgrade(previousZone, currentZone) {
  return zoneSeverity(currentZone) > zoneSeverity(previousZone);
}

module.exports = { haversineKm, classifyZone, zoneSeverity, isUpgrade, ZONE_ORDER };
