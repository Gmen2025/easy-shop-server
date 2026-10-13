const { conflict } = require("./store-inventory");

const COUNTRY_NAMES = { US: "USA", ET: "Ethiopia" };
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;
const SESSION = /^[A-Za-z0-9-]{8,64}$/;

const placesKey = () => process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
const unavailable = () => conflict("Address search is unavailable. Admin must enable Places API (New) for the server Google key.");
const sessionParam = (session) => (typeof session === "string" && SESSION.test(session) ? session : undefined);

async function callPlaces(url, init, fetcher) {
  const key = placesKey();
  if (!key) throw unavailable();
  let response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, ...init.headers } });
  } catch (error) {
    console.error("Places request failed:", String(error.message).split(key).join("[redacted]"));
    throw conflict("Address search is temporarily unavailable. Type the address manually or retry.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Places request rejected:", String(body.error?.message || response.status).split(key).join("[redacted]"));
    if ([400, 404].includes(response.status) && init.method !== "POST") throw conflict("That place is no longer available. Search again.");
    throw unavailable();
  }
  return body;
}

async function autocompletePlaces(input, regionCode, session, { fetcher = fetch } = {}) {
  const text = typeof input === "string" ? input.trim() : "";
  if (text.length < 3 || text.length > 200) return [];
  const body = await callPlaces("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: { "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat" },
    body: JSON.stringify({ input: text, includedRegionCodes: [regionCode.toLowerCase()], languageCode: "en",
      ...(sessionParam(session) ? { sessionToken: session } : {}) }),
  }, fetcher);
  return (body.suggestions || []).map((entry) => entry.placePrediction).filter((place) => place?.placeId).slice(0, 6)
    .map((place) => ({
      placeId: place.placeId,
      text: place.text?.text || "",
      mainText: place.structuredFormat?.mainText?.text || place.text?.text || "",
      secondaryText: place.structuredFormat?.secondaryText?.text || "",
    }));
}

// Server-authoritative place lookup: coordinates always come from Google, never from the client.
async function placeDetails(placeId, regionCode, session, { fetcher = fetch } = {}) {
  if (typeof placeId !== "string" || !PLACE_ID.test(placeId)) throw conflict("Invalid place selection. Search again.");
  const url = new URL(`https://places.googleapis.com/v1/places/${placeId}`);
  url.searchParams.set("languageCode", "en");
  if (sessionParam(session)) url.searchParams.set("sessionToken", session);
  const place = await callPlaces(url, { method: "GET",
    headers: { "X-Goog-FieldMask": "id,displayName,formattedAddress,location,addressComponents" } }, fetcher);
  const part = (type, form = "longText") => place.addressComponents?.find((component) => component.types?.includes(type))?.[form] || "";
  const country = part("country", "shortText").toUpperCase();
  if (country !== regionCode.toUpperCase()) throw conflict("That place is outside the selected shopping region.");
  const latitude = Number(place.location?.latitude);
  const longitude = Number(place.location?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw conflict("Google returned no map location for that place. Choose another suggestion.");
  }
  const street = [part("street_number"), part("route")].filter(Boolean).join(" ");
  const name = place.displayName?.text || "";
  const address1 = (street && name && !street.includes(name) && !name.includes(street) ? `${name}, ${street}` : street || name ||
    String(place.formattedAddress || "").split(",")[0]).slice(0, 300);
  return {
    placeId: place.id || placeId,
    address1,
    city: (part("locality") || part("postal_town") || part("sublocality") || part("administrative_area_level_2") ||
      part("administrative_area_level_1")).slice(0, 300),
    zip: part("postal_code").slice(0, 300),
    country: COUNTRY_NAMES[country],
    formattedAddress: String(place.formattedAddress || "").slice(0, 300),
    location: { type: "Point", coordinates: [longitude, latitude] },
  };
}

module.exports = { autocompletePlaces, placeDetails };
