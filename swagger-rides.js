// Integration: merge paths into definition.paths and schemas into definition.components.schemas.
// bearerAuth is supplied by swagger.js. This module documents routers/rides.js only.
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties, required) => ({
  type: "object", properties, ...(required ? { required } : {}),
});
const array = (items) => ({ type: "array", items });
const text = { type: "string" };
const number = { type: "number" };
const bool = { type: "boolean" };
const date = { type: "string", format: "date-time" };
const id = { type: "string", description: "MongoDB ObjectId.", example: "507f1f77bcf86cd799439011" };
const nullableId = { ...id, nullable: true };
const mode = { type: "string", enum: ["regular", "shared"] };
const vehicle = { type: "string", enum: ["motorcycle", "car", "van", "truck"] };
const option = { type: "string", enum: ["economy", "comfort", "van"] };
const shortText = { type: "string", maxLength: 300 };
const money = { type: "number", minimum: 0, multipleOf: 0.01 };
const nullableRef = (name) => ({ allOf: [ref(name)], nullable: true });

const schemas = {
  RideError: object({ message: text }, ["message"]),
  RideMessage: object({ message: text }, ["message"]),
  RideGeoPoint: object({
    type: { type: "string", enum: ["Point"] },
    coordinates: {
      type: "array", minItems: 2, maxItems: 2, items: number,
      description: "GeoJSON [longitude, latitude], not [latitude, longitude].",
    },
  }, ["type", "coordinates"]),
  RideGpsInput: {
    ...object({
      latitude: { type: "number", minimum: -90, maximum: 90 },
      longitude: { type: "number", minimum: -180, maximum: 180 },
    }, ["latitude", "longitude"]),
    description: "Numeric GPS coordinates. Current-location lookup rejects the pair (0, 0).",
  },
  RideAddressInput: {
    ...object({
      label: { ...shortText, minLength: 1, example: "Home" },
      address1: { ...shortText, example: "123 Main Street" },
      address2: { ...shortText, example: "", description: "Required string; may be empty." },
      city: shortText,
      zip: { ...shortText, description: "Required nonempty for USA; optional/empty for Ethiopia." },
      country: { ...shortText, description: "Must resolve to the selected region: USA/us/United States/United States of America or Ethiopia/ethio/et." },
      phone: { ...shortText, minLength: 1 },
      placeId: { type: "string", pattern: "^[A-Za-z0-9_-]{10,300}$", description: "Optional Google place ID. The server verifies its location and country; other address fields are still required." },
      currentLocation: { allOf: [ref("RideGpsInput")], description: "Pickup only. Server reverse-geocodes GPS, overriding address1/city/zip/country. label, address2 and phone remain required." },
    }, ["label", "address2", "phone"]),
    anyOf: [
      { required: ["address1", "city", "country"] },
      { required: ["currentLocation"] },
    ],
    description: "All strings are trimmed and limited to 300 characters. For manual/place-ID addresses, label/address1/city/country/phone must be nonempty; address2 must be supplied even if empty. Client-supplied location is not trusted.",
  },
  RideAddress: object({
    label: text, address1: text, address2: text, city: text, zip: text, country: text, phone: text,
    placeId: text, location: ref("RideGeoPoint"),
  }),
  RideStopInput: object({
    type: { type: "string", enum: ["pickup", "dropoff"] },
    passengers: { type: "integer", minimum: 1, maximum: 16 },
    address: ref("RideAddressInput"),
  }, ["type", "passengers", "address"]),
  RideStop: object({
    key: { type: "string", description: "Zero-based booking stop index, stored as a string." },
    type: { type: "string", enum: ["pickup", "dropoff"] },
    passengers: { type: "integer", minimum: 1, maximum: 16 },
    address: ref("RideAddress"),
  }),
  RideQuoteInput: {
    ...object({
      mode,
      vehicleOption: { ...option, description: "Required by /quote when per-vehicle pricing is configured. Omit for legacy flat pricing. /quote-options compares enabled options and ignores this field." },
      stops: { ...array(ref("RideStopInput")), minItems: 2, maxItems: 12 },
    }, ["mode", "stops"]),
    description: "Regular bookings have 2-12 stops; shared bookings exactly 2. Begin with pickup, end with dropoff, balance all passenger counts, never drop off before pickup, and keep peak occupancy at most 16. Shared rides combine separate bookings, not extra stops in one booking.",
    example: {
      mode: "regular", vehicleOption: "economy",
      stops: [
        { type: "pickup", passengers: 1, address: { label: "Home", address1: "123 Main Street", address2: "", city: "Atlanta", zip: "30303", country: "USA", phone: "+15555550100" } },
        { type: "dropoff", passengers: 1, address: { label: "Office", address1: "456 Peachtree Street", address2: "", city: "Atlanta", zip: "30308", country: "USA", phone: "+15555550100" } },
      ],
    },
  },
  RideFareRates: {
    ...object({
      baseFare: { ...money, maximum: 100000 },
      distanceRate: { ...money, maximum: 100000, description: "Per mile for USD; per kilometer for ETB." },
      minuteRate: { ...money, maximum: 100000 },
    }, ["baseFare", "distanceRate", "minuteRate"]),
    description: "Each rate is 0-100000 with at most two decimals; at least one must be nonzero. Numeric strings are also accepted and normalized by the server.",
  },
  RideVehicleRate: {
    ...object({ enabled: bool, baseFare: money, distanceRate: money, minuteRate: money }, ["enabled"]),
    description: "When enabled=true all three fare rates are required, each 0-100000 with at most two decimals, and at least one nonzero. Disabled options are normalized to {enabled:false}.",
  },
  RideVehicleRates: object({
    economy: ref("RideVehicleRate"), comfort: ref("RideVehicleRate"), van: ref("RideVehicleRate"),
  }, ["economy", "comfort", "van"]),
  RideConfig: {
    ...object({
      enabled: bool,
      sharedDiscountPercent: { type: "number", minimum: 0, maximum: 90 },
      maxPickupMinutes: { type: "number", exclusiveMinimum: true, minimum: 0, maximum: 120 },
      maxDetourMinutes: { type: "number", minimum: 0, maximum: 120 },
      driverRadiusKm: { type: "number", exclusiveMinimum: true, minimum: 0, maximum: 100 },
      vehicleRates: ref("RideVehicleRates"),
      baseFare: money, distanceRate: money, minuteRate: money,
    }, ["enabled"]),
    description: "GET may return only {enabled:false} when unset. Full settings contain all four policy fields and either per-vehicle rates or legacy baseFare/distanceRate/minuteRate.",
  },
  RideConfigInput: {
    allOf: [
      ref("RideConfig"),
      {
        required: ["enabled", "sharedDiscountPercent", "maxPickupMinutes", "maxDetourMinutes", "driverRadiusKm"],
        anyOf: [{ required: ["vehicleRates"] }, { required: ["baseFare", "distanceRate", "minuteRate"] }],
      },
    ],
    description: "Full replacement, not a partial update, even when disabling rides. When vehicleRates is present it takes precedence over legacy rates and must configure all three options; an enabled service needs at least one enabled option. Without vehicleRates, legacy rates must satisfy RideFareRates. Numeric policy/rate strings are accepted and normalized; send JSON numbers.",
  },
  RideMetrics: object({ distanceKm: number, minutes: number }),
  RideTariff: {
    allOf: [ref("RideConfig"), ref("RideFareRates")],
    description: "Pricing and policy snapshot taken at quote creation. Per-vehicle quotes contain the selected option's rates, not the vehicleRates map.",
  },
  RideBankAccount: object({ bankName: text, accountNumber: text, accountHolderName: text, bankCode: text }),
  RideTermination: object({
    reason: text, at: date, driver: id, location: ref("RideGeoPoint"), locationUpdatedAt: date,
    previousStatus: { type: "string", enum: ["assigned", "onboard"] },
    reviewStatus: { type: "string", enum: ["pending", "resolved"] },
    reviewedBy: id, reviewedAt: date, reviewNote: text,
  }),
  RidePublic: {
    ...object({
      _id: id, id, __v: { type: "integer" }, user: id, mode, vehicleOption: option,
      status: { type: "string", enum: ["quote", "waiting", "offered", "assigned", "onboard", "completed", "cancelled", "terminated"] },
      stops: array(ref("RideStop")), seats: { type: "integer", minimum: 1, maximum: 16 },
      currency: { type: "string", enum: ["usd", "etb"], description: "USA database uses usd; other region uses etb. Amounts are major currency units, not cents." },
      tariff: ref("RideTariff"), baseline: ref("RideMetrics"), estimate: number, finalFare: number,
      driver: nullableId, trip: nullableId, dispatchMessage: text,
      requestedAt: date, expiresAt: date, pickedUpAt: date, completedAt: date,
      pickupBy: date, promisedDropoffAt: date, offeredAt: date, offerDeadline: { ...date, nullable: true },
      termination: ref("RideTermination"),
      paymentMethod: { type: "string", enum: ["card", "bank", "cash"] },
      paymentStatus: { type: "string", enum: ["pending", "completed", "review_required", "waived"] },
      bankAccount: ref("RideBankAccount"), bankSender: text, bankReference: text, paymentPaidAt: date,
      createdAt: date, updatedAt: date,
    }),
    description: "Public ride document. State-dependent fields may be absent/null. paymentIntentId, attemptedDrivers, offerDriver, offerTrip and routePath are removed. Quote estimates are not collected payments; finalFare becomes available on completion or termination review.",
  },
  RideRoutePath: object({
    coordinates: { ...array(ref("RideGpsInput")), description: "Driving polyline points as {latitude, longitude} objects (not GeoJSON coordinate pairs)." },
    distanceKm: number, minutes: number, computedAt: date,
  }, ["coordinates", "distanceKm", "minutes", "computedAt"]),
  RideServiceModes: {
    ...object({ delivery: bool, regular: bool, shared: bool }, ["delivery", "regular", "shared"]),
    description: "All three boolean fields are required when updating. At least one must be true; going offline uses existing availability controls elsewhere.",
  },
  RideDriverConfigInput: object({
    vehicleType: { ...vehicle, description: "Defaults to verified current type. Explicit selection is required if a pending vehicle change exists." },
    passengerSeats: { type: "integer", minimum: 1, maximum: 16, description: "Required for car/van; usable seats exclude the driver. Cleared for motorcycle/truck." },
    carClass: { type: "string", enum: ["", "economy", "comfort"], description: "Economy/comfort only for cars; defaults to current class for cars and empty otherwise. Non-car requests may only use empty string." },
  }),
  RideAdminDriver: object({
    _id: id, name: text, vehicleType: text, vehicle: object({ type: text }),
    pendingVehicleType: { type: "string", enum: ["", "motorcycle", "car", "van", "truck"] },
    carClass: { type: "string", enum: ["", "economy", "comfort"] },
    passengerSeats: { type: "integer" }, serviceModes: ref("RideServiceModes"),
    sharedIntakeOpen: bool, activeRideTrip: nullableId,
  }),
  RideDriverSelf: object({
    _id: id, name: text, vehicleType: text, pendingVehicleType: text, carClass: text,
    location: nullableRef("RideGeoPoint"), passengerSeats: { type: "integer" },
    serviceModes: ref("RideServiceModes"), sharedIntakeOpen: bool, approvalStatus: text,
    isAvailable: bool, isSuspended: bool, profilePhotoUrl: text,
    rideProfilePhotoUpdatedAt: { ...date, nullable: true }, rideProfilePhotoRequired: bool,
  }),
  RideTripStop: {
    allOf: [
      ref("RideStop"),
      object({ ride: id, completedAt: date }),
    ],
    description: "Trip stop key is the booking-local key; POST /me/next-stop takes `${ride}:${key}`.",
  },
  RideTrip: object({
    _id: id, __v: { type: "integer" }, driver: id, mode,
    status: { type: "string", enum: ["active", "completed"] }, acceptingShared: bool,
    seatCapacity: { type: "integer" }, onboardSeats: { type: "integer" },
    stops: array(ref("RideTripStop")), version: { type: "integer" },
    startedAt: date, completedAt: date, createdAt: date, updatedAt: date,
  }),
  RideDriverRider: object({
    _id: id, stops: array(ref("RideStop")), seats: { type: "integer" },
    status: { type: "string", enum: ["assigned", "onboard"] },
    user: id, mode, vehicleOption: option, estimate: number, customerName: text,
  }),
  RideDriverPayment: object({
    _id: id, stops: array(ref("RideStop")), currency: { type: "string", enum: ["usd", "etb"] },
    vehicleOption: option, finalFare: number, estimate: number,
    status: { type: "string", enum: ["completed", "terminated"] }, termination: ref("RideTermination"),
    paymentStatus: { type: "string", enum: ["pending", "completed", "review_required", "waived"] },
    paymentMethod: { type: "string", enum: ["card", "bank", "cash"] }, bankReference: text, completedAt: date,
  }),
  RideDriverDashboard: object({
    driver: ref("RideDriverSelf"), trip: nullableRef("RideTrip"), offer: nullableRef("RidePublic"),
    riders: array(ref("RideDriverRider")),
    payments: { ...array(ref("RideDriverPayment")), maxItems: 20 },
  }, ["driver", "trip", "offer", "riders", "payments"]),
  RidePickupEta: {
    ...object({
      status: { type: "string", enum: ["available", "unavailable"] },
      reason: { type: "string", description: "Present when unavailable." },
      minutes: number, arrivalAt: date, computedAt: date, expiresAt: date, driverLocationUpdatedAt: date,
      stopsBeforePickup: { type: "integer", minimum: 0 },
    }, ["status"]),
    description: "Only returned for assigned rides; otherwise pickupEta=null. Available estimates require GPS newer than 60 seconds and may be cached up to 30 seconds (never past GPS freshness). Unavailable results have a reason, not arrival timing. No other riders' stop details are disclosed.",
  },
  RideAssignedDriver: object({
    name: text, phone: text, vehicleType: text, plateNumber: text, profilePhotoUrl: text,
    location: ref("RideGeoPoint"), locationUpdatedAt: { ...date, nullable: true },
  }),
  RideDetail: {
    allOf: [
      ref("RidePublic"),
      object({
        pickupEta: nullableRef("RidePickupEta"),
        assignedDriver: {
          ...nullableRef("RideAssignedDriver"),
          description: "Present for assigned/onboard/completed rides when driver exists, otherwise null. Live location/locationUpdatedAt are included only for assigned/onboard.",
        },
      }, ["pickupEta", "assignedDriver"]),
    ],
  },
  RidePlaceSuggestion: object({ placeId: text, text, mainText: text, secondaryText: text }),
  RidePlaceAddress: object({
    placeId: text, address1: text, city: text, zip: text,
    country: { type: "string", enum: ["USA", "Ethiopia"] },
    formattedAddress: text, location: ref("RideGeoPoint"),
    currentLocation: ref("RideGpsInput"),
  }),
  RidePaymentMethodInput: {
    ...object({
      method: { type: "string", enum: ["card", "bank", "cash"] },
      bankAccountId: { ...id, description: "Required for bank: select an active account whose currency matches this ride." },
    }, ["method"]),
    description: "Card is USA/USD only; cash is unavailable in USA; bank must have a configured active account. A selected method cannot be switched through this API.",
  },
  RidePaymentIntentResult: object({
    ride: ref("RidePublic"),
    clientSecret: {
      type: "string", nullable: true,
      description: "Stripe client secret for a pending attempt. Omitted when payment is already completed or a recovered intent has succeeded. Returned only by this endpoint; never a paymentIntentId field on the public ride.",
    },
  }, ["ride"]),
  RidePaymentConfirmInput: {
    ...object({
      sender: { type: "string", minLength: 1, maxLength: 300 },
      reference: { type: "string", minLength: 1, maxLength: 300 },
    }),
    description: "Bank payments require both nonblank strings; they are trimmed (raw length must be at most 300). Card confirmation ignores these fields and verifies the server-stored Stripe attempt; no client-supplied intent ID or success flag is accepted as proof.",
  },
};

const json = (schema) => ({ "application/json": { schema } });
const response = (description, schema) => ({ description, content: json(schema) });
const error = (description) => response(description, ref("RideError"));
const paths = {};
function add(path, method, operationId, summary, description, schema, options = {}) {
  const { status = 200, body, parameters, errors = {}, bodyRequired = true, success = "Success." } = options;
  const operation = {
    tags: ["Rides"], operationId, summary, description,
    security: [{ bearerAuth: [] }],
    ...(parameters ? { parameters } : {}),
    ...(body ? { requestBody: { required: bodyRequired, content: json(body) } } : {}),
    responses: {
      [status]: response(success, schema),
      401: error("JWT authentication is missing/invalid, or no authenticated user is available."),
      409: error("Invalid input, invalid identifier, stale assignment, unsupported payment, or lifecycle/configuration conflict. Response message explains the action required."),
      500: error("Unexpected service failure. Refresh the ride before retrying a payment or driver action."),
      ...errors,
    },
  };
  const fullPath = `/api/v1/rides${path}`;
  paths[fullPath] = { ...paths[fullPath], [method]: operation };
}
const idParam = (description = "Ride MongoDB ObjectId.") => ({
  name: "id", in: "path", required: true, description, schema: id,
});
const adminErrors = { 403: error("Admin access required.") };
const driverErrors = { 403: error("Only a company-owned driver linked to the authenticated user can manage ride assignments.") };
const ownedErrors = { 404: error("Ride not found or not accessible to this rider.") };
const routeErrors = {
  422: error("No driving route was found."),
  502: error("Driving route provider rejected the request."),
  503: error("Driving routes are not configured on the server."),
};
const driverScope = "Company driver only (driver.user must match the JWT user and isCompanyOwned=true). ";
const ownerScope = "Rider-owned ride; Admin may read any ride through the ownership lookup. ";
const payable = "Payment is allowed only for completed rides or terminated rides with a resolved Admin review and a non-waived fare. ";
const placesDescription = "JWT required. Region is US for the USA database, ET otherwise. All three places endpoints share an in-memory limit of 120 requests per user/database per minute (429 after the limit). ";
const placeErrors = { 429: error("Too many address searches. Wait a minute and retry.") };
const sessionParam = {
  name: "session", in: "query", required: false,
  schema: { type: "string" },
  description: "Optional Google Places session token. Only 8-64 ASCII letters/digits/hyphens are forwarded; invalid tokens are silently ignored.",
};

add("/config", "get", "ridesGetConfig", "Get regional ride configuration",
  "Any authenticated user. Returns the stored regional ride policy or {enabled:false} when unconfigured.",
  ref("RideConfig"));
add("/config", "put", "ridesPutConfig", "Replace regional ride configuration",
  "Admin only. Validates and replaces the complete rideConfig; persists the Admin as updatedBy. No partial update semantics. Fare distance is billed per mile for USD and per km for ETB.",
  ref("RideConfig"), { body: ref("RideConfigInput"), errors: adminErrors });
add("/quote-options", "post", "ridesQuoteOptions", "Create quotes for enabled passenger vehicle options",
  "Authenticated rider. Requires enabled ride service and per-vehicle pricing. Creates one persisted quote per enabled economy/comfort/van option; supplied vehicleOption is ignored. Server verifies/geocodes addresses and obtains driving metrics before quoting. All quotes expire after 10 minutes. No driver reservation or payment is created.",
  object({ quotes: array(ref("RidePublic")) }, ["quotes"]),
  { status: 201, body: ref("RideQuoteInput"), success: "Quotes created for enabled options." });
add("/admin/drivers", "get", "ridesAdminListDrivers", "List company driver ride configurations",
  "Admin only. Returns all company-owned drivers, using the documented field projection; no pagination.",
  array(ref("RideAdminDriver")), { errors: adminErrors });
add("/admin/drivers/{id}", "put", "ridesAdminConfigureDriver", "Verify a driver vehicle and passenger configuration",
  "Admin only; id identifies a company driver, not a ride. Cannot modify while an active ride, pending offer, exclusive delivery or assigned/picked-up order exists. Pending vehicle changes require explicit vehicleType verification. Cars/vans require 1-16 passenger seats; only cars support economy/comfort classes. Motorcycle/truck reset service modes to delivery-only and clear seats. Clears pendingVehicleType.",
  ref("RideMessage"), { parameters: [idParam("Company driver MongoDB ObjectId.")], body: ref("RideDriverConfigInput"), errors: adminErrors });
add("/me/vehicle", "put", "ridesDriverSelectVehicle", "Request a vehicle type change",
  `${driverScope}Cannot change while rides/deliveries/offers are outstanding. Sets pendingVehicleType (or clears it if selecting the already verified type); does not immediately change verified vehicleType. Admin verification is required before new passenger offers.`,
  ref("RideMessage"), { body: object({ vehicleType: vehicle }, ["vehicleType"]), errors: driverErrors });
add("/me/route", "get", "ridesDriverRoute", "Get the remaining passenger driving route",
  `${driverScope}Requires an active passenger trip with unfinished stops and a valid driver GPS location. Computes the route from the driver's reported location through pending trip stops in order.`,
  ref("RideRoutePath"), { errors: { ...driverErrors, ...routeErrors } });
add("/me/start-trip", "post", "ridesDriverStartTrip", "Record the active passenger trip start",
  `${driverScope}Requires an active trip belonging to this driver and tripId exactly matching the current trip. Sets startedAt only if absent and returns the existing timestamp on repeat calls. This action does not itself mark any rider onboard or complete a pickup.`,
  object({ startedAt: date }, ["startedAt"]),
  { body: object({ tripId: id }, ["tripId"]), errors: driverErrors });
add("/me/driver", "get", "ridesDriverDashboard", "Get company driver ride dashboard",
  `${driverScope}Returns selected driver fields, full active trip (or null), unexpired current offer (or null), assigned/onboard riders with customerName, and the last 20 completed/terminated payment summaries sorted by update time. Reading expires a stale pending offer and attempts redispatch. The riders/payment arrays are projections, not full public ride objects.`,
  ref("RideDriverDashboard"), { errors: driverErrors });
add("/me/profile-photo", "put", "ridesDriverPhoto", "Save a ride driver profile photo URL",
  `${driverScope}JSON URL only; this endpoint does not upload a file. URL must use HTTPS, host res.cloudinary.com and path /<cloud>/image/upload/<resource>. Saves a fresh rideProfilePhotoUpdatedAt. A current ride photo is required when enabling/accepting passenger service and expires after 90 days.`,
  object({ profilePhotoUrl: text, rideProfilePhotoUpdatedAt: date, rideProfilePhotoRequired: { type: "boolean", enum: [false] } },
    ["profilePhotoUrl", "rideProfilePhotoUpdatedAt", "rideProfilePhotoRequired"]),
  { body: object({ profilePhotoUrl: { type: "string", format: "uri", example: "https://res.cloudinary.com/example/image/upload/driver.jpg" } }, ["profilePhotoUrl"]), errors: driverErrors });
add("/me/modes", "put", "ridesDriverModes", "Set delivery, regular and shared service modes",
  `${driverScope}Supply all three booleans, with at least one true. Newly enabling passenger modes requires no unverified vehicle change and a photo refreshed within 90 days. Any passenger mode requires configured seats on a verified car/van. Disabling shared closes intake and reroutes assigned but not picked-up shared riders. Offers incompatible with new modes are released and redispatched. Does not make an offline driver available.`,
  object({ serviceModes: ref("RideServiceModes") }, ["serviceModes"]),
  { body: ref("RideServiceModes"), errors: driverErrors });
add("/me/shared-intake", "post", "ridesDriverSharedIntake", "Open or close shared rider intake",
  `${driverScope}Opening requires shared mode, a current ride photo, and no active regular trip. Closing releases shared offers and removes/redispatches assigned shared riders not yet picked up; onboard riders remain. Updates acceptingShared on an active shared trip.`,
  object({ open: bool }, ["open"]), { body: object({ open: bool }, ["open"]), errors: driverErrors });
add("/me/location", "post", "ridesDriverLocation", "Update ride driver GPS",
  `${driverScope}Stores a valid numeric longitude/latitude GeoJSON point and sets rideLocationUpdatedAt server-side. Dispatch, stop completion and termination enforce their own GPS freshness constraints.`,
  ref("RideMessage"), { body: ref("RideGpsInput"), errors: driverErrors });
add("/me/offers/{id}/{decision}", "post", "ridesDriverOfferDecision", "Accept or reject a ride offer",
  `${driverScope}id is the offered ride. Acceptance requires this driver's unexpired three-minute offer and revalidates availability, current profile photo, verified vehicle option, GPS freshness, capacity and route/pickup/drop-off constraints transactionally. Rejection releases the offer and attempts redispatch. Returns a message, not a ride.`,
  ref("RideMessage"), {
    parameters: [idParam(), { name: "decision", in: "path", required: true, schema: { type: "string", enum: ["accept", "reject"] } }],
    errors: driverErrors,
  });
add("/me/next-stop", "post", "ridesDriverNextStop", "Confirm only the next pending pickup or drop-off",
  `${driverScope}stopKey must exactly equal the next trip stop's ride ObjectId plus ":" plus its booking-local key. Requires GPS reported within 120 seconds and within 300 meters of the stop; rejects stale route versions. Pickup marks onboard; the last stop for a booking completes it and sets finalFare. Regular fare uses baseline distance and elapsed onboard minutes; shared fare uses baseline direct-route metrics refreshed at pickup. Finishes the trip when no pending stops remain.`,
  ref("RidePublic"), {
    body: object({ stopKey: { type: "string", example: "507f1f77bcf86cd799439011:0" } }, ["stopKey"]),
    errors: driverErrors,
  });
add("/me/rides/{id}/terminate", "post", "ridesDriverTerminate", "Terminate an assigned or onboard booking",
  `${driverScope}Only the assigned driver on the active trip may terminate this ride. Requires GPS no older than 120 seconds and a nonblank reason trimmed to 1-500 characters. Removes unfinished booking stops without recording a destination drop-off, adjusts onboard seats, marks terminated and paymentStatus=review_required. No fare is collected; payment is held for Admin review. Repeating a termination by the assigned driver returns the terminated ride.`,
  ref("RidePublic"), {
    parameters: [idParam()], body: object({ reason: { type: "string", description: "Must contain 1-500 characters after trimming." } }, ["reason"]),
    errors: driverErrors,
  });
add("/admin/terminations/{id}/review", "post", "ridesAdminReviewTermination", "Resolve a terminated ride fare review",
  "Admin only. Requires status=terminated and paymentStatus=review_required. Sets finalFare to the submitted numeric fare and stores reviewer, time and note. fare=0 waives payment; a positive fare makes payment pending. Review does not itself charge a card or mark money received.",
  ref("RidePublic"), {
    parameters: [idParam()],
    body: object({ note: { type: "string", description: "Must contain 1-500 characters after trimming." }, fare: money }, ["note", "fare"]),
    errors: adminErrors,
  });
add("/admin/payments", "get", "ridesAdminPayments", "List recent completed and terminated rides",
  "Admin only. Returns up to 100 public rides in completed/terminated state, newest updated first, including pending termination reviews and payment states. This is not a paid-only report and has no pagination/filter inputs.",
  { ...array(ref("RidePublic")), maxItems: 100 }, { errors: adminErrors });
add("/places/current-location", "post", "ridesCurrentLocation", "Reverse-geocode a pickup GPS location",
  `${placesDescription}Requires valid numeric coordinates other than (0,0); verifies the reverse-geocoded country matches the selected region. Returns normalized address fields, the submitted currentLocation, and a verified GeoJSON location; no placeId is produced.`,
  ref("RidePlaceAddress"), { body: ref("RideGpsInput"), errors: placeErrors });
add("/places/autocomplete", "get", "ridesAutocomplete", "Find regional address suggestions",
  `${placesDescription}Search text is trimmed. Missing, non-string, shorter than 3 or longer than 200 characters returns [] without a provider request. Returns at most six suggestions. Invalid session tokens are ignored.`,
  { ...array(ref("RidePlaceSuggestion")), maxItems: 6 }, {
    parameters: [
      { name: "input", in: "query", required: false, schema: { type: "string" }, description: "Address search text; useful length after trimming is 3-200 characters." },
      sessionParam,
    ], errors: placeErrors,
  });
add("/places/details/{placeId}", "get", "ridesPlaceDetails", "Resolve and verify a selected place",
  `${placesDescription}Validates the Google place ID and country. Coordinates come from the provider, not the client. Returns normalized address fields and placeId, without a currentLocation field.`,
  ref("RidePlaceAddress"), {
    parameters: [
      { name: "placeId", in: "path", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_-]{10,300}$" } },
      sessionParam,
    ], errors: placeErrors,
  });
add("/quote", "post", "ridesCreateQuote", "Create a single persisted ride quote",
  "Authenticated rider. Service must be enabled. With per-vehicle pricing, vehicleOption is required and must be enabled; legacy flat-rate configuration allows omission. Addresses must match the selected region and are verified/geocoded server-side. Uses verified driving distance/duration and shared discount for shared mode. Quote expires after 10 minutes; no dispatch or payment occurs here.",
  ref("RidePublic"), { status: 201, body: ref("RideQuoteInput"), success: "Quote created." });
add("", "get", "ridesListMine", "List my latest ride bookings",
  "Any authenticated rider, including Admin, gets only their own rides. Excludes status=quote, returns at most 50, sorted by createdAt descending. No pagination or query filters.",
  { ...array(ref("RidePublic")), maxItems: 50 });
add("/{id}", "get", "ridesGet", "Get ride details and assigned-driver pickup status",
  `${ownerScope}Expires a stale offer and attempts redispatch on read. Adds pickupEta (assigned state only) and assignedDriver for assigned/onboard/completed rides; live location is provided only for assigned/onboard. Other states return assignedDriver=null.`,
  ref("RideDetail"), { parameters: [idParam()], errors: ownedErrors });
add("/{id}/route", "get", "ridesGetRoute", "Get the booking's driving path",
  `${ownerScope}Returns the booking's own stop sequence, not the combined shared trip route. Uses the cached routePath if present or computes/persists one from verified stop locations. Public ride responses omit routePath; use this endpoint to retrieve it.`,
  ref("RideRoutePath"), { parameters: [idParam()], errors: { ...ownedErrors, ...routeErrors } });
add("/{id}/request", "post", "ridesRequest", "Submit a quote and attempt driver dispatch",
  "Rider must own the quote (the service also enforces user ownership, even for Admin). Requires an unexpired quote, currently enabled service and enabled selected vehicle option. Transitions quote to waiting, establishes pickup window and attempts dispatch. Repeating a non-quote/non-cancelled request does not create another booking; cancelled quotes require a new quote. Dispatch failure can leave a queued waiting ride; no assignment or payment is guaranteed.",
  ref("RidePublic"), { parameters: [idParam()], errors: ownedErrors });
add("/{id}/cancel", "post", "ridesCancel", "Cancel my booking before pickup",
  "Rider must own the booking (also enforced for Admin). Allows quote/waiting/offered/assigned states; already-cancelled rides are returned unchanged. Onboard/completed/terminated rides cannot be cancelled. Releases offers/removes trip stops as necessary. No fare is due for a pre-pickup cancellation.",
  ref("RidePublic"), { parameters: [idParam()], errors: ownedErrors });
add("/{id}/payment-method", "post", "ridesSelectPaymentMethod", "Select and lock a ride payment method",
  `Rider must own the ride (also enforced for Admin). ${payable}Requires a nonzero finalFare. Card is only USD/USA; cash is not available in USA. Bank requires a selected active account matching the ride currency and snapshots its public bank details. Re-selecting the same method resumes it; selecting a different one conflicts. Does not collect payment or confirm receipt.`,
  ref("RidePublic"), { parameters: [idParam()], body: ref("RidePaymentMethodInput"), errors: ownedErrors });
add("/{id}/payment", "post", "ridesPaymentIntent", "Create or recover the ride's Stripe payment attempt",
  `${ownerScope}${payable}Choose card via payment-method first. Uses the server's finalFare/currency and a ride-specific idempotency key; recovers existing attempts before creating one. Returns a clientSecret when further client action is needed, not proof of payment. If a recovered attempt has succeeded, verifies amount/currency/metadata and records completed payment; then clientSecret is omitted. Mismatched/cancelled attempts conflict: resume/recover status instead of paying again. No request body is read.`,
  ref("RidePaymentIntentResult"), { parameters: [idParam()], errors: ownedErrors });
add("/{id}/payment-confirm", "post", "ridesConfirmPayment", "Verify card payment or submit bank transfer details",
  `${ownerScope}${payable}Already-completed payments return unchanged. For card, the server retrieves its stored Stripe attempt (creating/recovering it if absent), requires succeeded status and exact intent/amount/received amount/currency/ride/user/database metadata matches before marking paid. Client assertions do not confirm a charge. For bank, requires sender/reference and records them while payment remains pending until Admin receipt confirmation. Cash is rejected here; use received-payment after receipt.`,
  ref("RidePublic"), {
    parameters: [idParam()], body: ref("RidePaymentConfirmInput"), bodyRequired: false, errors: ownedErrors,
  });
add("/{id}/received-payment", "post", "ridesRecordReceipt", "Record actual cash or bank payment received",
  `${payable}Bank: Admin only, and rider must have submitted bankReference. Cash: Admin or the assigned company driver only. Card is always rejected and must be verified through Stripe instead. Checks the current method/reference/state before atomically marking pending payment completed and recording paymentPaidAt; already-completed results may be returned unchanged. This endpoint records receipt, it does not initiate any transfer or charge. Unlike rider endpoints, no rider-ownership lookup is performed.`,
  ref("RidePublic"), {
    parameters: [idParam()],
    errors: { 403: error("Bank receipt requires Admin; cash receipt requires Admin or the assigned company driver.") },
  });

module.exports = { paths, schemas };
