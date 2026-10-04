const { getCoordinates } = require("./fulfillment-routing");

function decodePolyline(encoded) {
  const coordinates = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  const read = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      if (index >= encoded.length || shift > 30) throw new Error("Invalid route polyline.");
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) throw new Error("Invalid route polyline.");
      result |= (byte & 31) << shift;
      shift += 5;
    } while (byte >= 32);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    latitude += read();
    longitude += read();
    const point = { latitude: latitude / 1e5, longitude: longitude / 1e5 };
    if (!getCoordinates(point)) throw new Error("Invalid route coordinates.");
    coordinates.push(point);
  }
  return coordinates;
}

async function computeDrivingRoute(origin, destination) {
  const key = process.env.GOOGLE_ROUTES_API_KEY;
  if (!key) {
    const error = new Error("Driving routes are not configured. Set GOOGLE_ROUTES_API_KEY on the server.");
    error.status = 503;
    throw error;
  }
  const waypoint = ([longitude, latitude]) => ({ location: { latLng: { latitude, longitude } } });
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
    },
    body: JSON.stringify({
      origin: waypoint(origin), destination: waypoint(destination),
      travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE",
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    const reason = String(data.error?.message || `HTTP ${response.status}`)
      .split(key).join("[redacted]");
    throw new Error(`Google Routes request failed: ${reason}`);
  }
  const route = data.routes?.[0];
  if (!route) {
    const error = new Error("No driving route was found for this delivery.");
    error.status = 422;
    throw error;
  }
  const duration = /^(\d+(?:\.\d+)?)s$/.exec(route.duration || "");
  if (!Number.isFinite(route.distanceMeters) || !duration || !route.polyline?.encodedPolyline) {
    throw new Error("Google Routes returned incomplete route data.");
  }
  const coordinates = decodePolyline(route.polyline.encodedPolyline);
  if (coordinates.length < 2) throw new Error("Google Routes returned an empty route.");
  return { coordinates, distance: route.distanceMeters / 1000, duration: Number(duration[1]) / 60 };
}

module.exports = { decodePolyline, computeDrivingRoute };
