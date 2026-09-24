// Server-side only: computes driving distance (km) between two addresses using the
// Google Distance Matrix API. The API key never reaches the client.
const GOOGLE_DISTANCE_MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";

function getGoogleMapsApiKey() {
  return process.env.GOOGLE_MAPS_API_KEY || "";
}

function isGoogleDistanceApiConfigured() {
  return Boolean(getGoogleMapsApiKey());
}

// Returns the driving distance in km, or null if the API is not configured or the
// lookup fails (caller should fall back to a manual/client-supplied distance).
async function getDrivingDistanceKm(originAddress, destinationAddress) {
  const apiKey = getGoogleMapsApiKey();
  const origin = String(originAddress || "").trim();
  const destination = String(destinationAddress || "").trim();

  if (!apiKey || !origin || !destination) {
    return null;
  }

  const url = new URL(GOOGLE_DISTANCE_MATRIX_URL);
  url.searchParams.set("origins", origin);
  url.searchParams.set("destinations", destination);
  url.searchParams.set("units", "metric");
  url.searchParams.set("key", apiKey);

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const element = data?.rows?.[0]?.elements?.[0];

    if (data?.status !== "OK" || !element || element.status !== "OK") {
      return null;
    }

    const meters = element.distance?.value;
    if (!Number.isFinite(meters)) {
      return null;
    }

    return Math.round((meters / 1000) * 100) / 100;
  } catch (error) {
    console.error("Google Distance Matrix lookup failed:", error.message);
    return null;
  }
}

module.exports = {
  isGoogleDistanceApiConfigured,
  getDrivingDistanceKm,
};
