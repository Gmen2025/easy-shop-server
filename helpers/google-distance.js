// Server-side only: computes driving distance (km) between two addresses using the
// Google Distance Matrix API. The API key never reaches the client.
const GOOGLE_DISTANCE_MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";

function getGoogleMapsApiKey() {
  return process.env.GOOGLE_MAPS_API_KEY || "";
}

function isGoogleDistanceApiConfigured() {
  return Boolean(getGoogleMapsApiKey());
}

// Strict callers receive actionable errors instead of an unavailable-distance null.
async function getDrivingDistanceKm(originAddress, destinationAddress, { throwOnError = false } = {}) {
  const apiKey = getGoogleMapsApiKey();
  const origin = String(originAddress || "").trim();
  const destination = String(destinationAddress || "").trim();

  if (!apiKey || !origin || !destination) {
    if (throwOnError) {
      throw new Error(!apiKey
        ? "Checkout driving distance is not configured. Set GOOGLE_MAPS_API_KEY on the backend and enable Distance Matrix API."
        : "Pickup and delivery addresses are required to calculate driving distance.");
    }
    return null;
  }

  const url = new URL(GOOGLE_DISTANCE_MATRIX_URL);
  url.searchParams.set("origins", origin);
  url.searchParams.set("destinations", destination);
  url.searchParams.set("units", "metric");
  url.searchParams.set("mode", "driving");
  url.searchParams.set("key", apiKey);

  try {
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      throw new Error(`Google Distance Matrix request failed (HTTP ${response.status}).`);
    }

    const data = await response.json();
    const element = data?.rows?.[0]?.elements?.[0];

    if (data?.status !== "OK" || !element || element.status !== "OK") {
      const status = data?.status !== "OK" ? data?.status : element?.status;
      if (status === "ZERO_RESULTS") {
        throw new Error("Google Distance Matrix found no driving route between the pickup and delivery locations (ZERO_RESULTS). Check that both map pins are correct and accessible by road. Driving-route coverage may be unavailable in this area.");
      }
      if (status === "NOT_FOUND") {
        throw new Error("Google Distance Matrix could not locate the pickup or delivery location (NOT_FOUND). Check the store map pin and delivery address.");
      }
      throw new Error(`Google Distance Matrix could not calculate a driving distance (${status || "missing route"}). Check the backend API key, billing, API restrictions and addresses.`);
    }

    const meters = element.distance?.value;
    if (!Number.isFinite(meters) || meters < 0) {
      throw new Error("Google Distance Matrix returned an invalid driving distance.");
    }

    return Math.round((meters / 1000) * 100) / 100;
  } catch (error) {
    const message = String(error.message || "Google Distance Matrix lookup failed.")
      .split(apiKey).join("[redacted]")
      .replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]");
    console.error("Google Distance Matrix lookup failed:", message);
    if (throwOnError) throw new Error(message);
    return null;
  }
}

module.exports = {
  isGoogleDistanceApiConfigured,
  getDrivingDistanceKm,
};
