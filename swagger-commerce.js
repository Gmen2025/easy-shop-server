const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const text = { type: "string" };
const boolean = { type: "boolean" };
const number = { type: "number" };
const money = { type: "number", minimum: 0, multipleOf: 0.01 };
const whole = { type: "integer", minimum: 0 };
const objectId = { type: "string", pattern: "^[a-fA-F0-9]{24}$" };
const date = { type: "string", format: "date-time" };
const nullableDate = { ...date, nullable: true };
const vehicle = { type: "string", enum: ["motorcycle", "car", "van", "truck"] };
const mode = { type: "string", enum: ["EXPRESS", "STANDARD", "SCHEDULED"] };
const storedMode = { type: "string", enum: [...mode.enum, "SAME_DAY", "NEXT_DAY"] };
const array = (items, options = {}) => ({ type: "array", items, ...options });
const object = (properties, required = []) => ({
  type: "object", properties, ...(required.length ? { required } : {}),
});
const string300 = { type: "string", maxLength: 300 };
const nonempty300 = { ...string300, minLength: 1 };
const profileProperties = {
  name: { type: "string", minLength: 1, maxLength: 500 },
  address: { type: "string", minLength: 1, maxLength: 500 },
  logo: { type: "string", maxLength: 500, description: "Empty string or an HTTPS URL." },
  description: { type: "string", maxLength: 2000 },
  latitude: { type: "number", minimum: -90, maximum: 90 },
  longitude: { type: "number", minimum: -180, maximum: 180 },
};
const addressProperties = {
  label: nonempty300, address1: nonempty300, address2: string300, city: nonempty300,
  zip: { ...string300, description: "Nonempty and required except for Ethiopia (ET, ethio, Ethiopia), where omission defaults to an empty string." },
  country: nonempty300, phone: nonempty300,
};
const addressRequired = ["label", "address1", "address2", "city", "country", "phone"];
const sizeProperties = Object.fromEntries(["weightKg", "lengthCm", "widthCm", "heightCm"].map((key) => [
  key, { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 1000000 },
]));
const vehicleProperties = {
  enabled: boolean, baseFee: money, distanceRate: money,
  ...Object.fromEntries(["maxWeightKg", "maxVolumeLiters", "lengthCm", "widthCm", "heightCm"].map((key) => [
    key, { type: "number", minimum: 0, description: "Must be positive when this vehicle is enabled." },
  ])),
};
const tariffProperties = {
  enabled: boolean, hub: ref("CommerceAddressInput"),
  ...Object.fromEntries(["baseUsd", "perKgUsd", "minimumUsd", "volumetricDivisor", "maxWeightKg", "maxDimensionCm"].map((key) => [
    key, { type: "number", minimum: 0, maximum: 1000000,
      ...(key.endsWith("Usd") ? { multipleOf: 0.01 } : { exclusiveMinimum: true }) },
  ])),
};
const lineProperties = {
  product: objectId, quantity: { type: "integer", minimum: 1 }, price: money,
};
const cartProperties = {
  ...lineProperties, key: { type: "string", minLength: 1, maxLength: 200 },
  storefrontId: { ...objectId, nullable: true },
};
const totals = { itemsSubtotal: money, deliveryFee: money, totalPrice: money };
const fulfillmentStatus = {
  type: "string", enum: ["payment_pending", "pending", "accepted", "unassigned", "completed", "cancelled"],
};
const shipmentStatus = {
  type: "string", enum: ["awaiting_hub", "at_hub", "shipped", "arrived_ethiopia", "delivered"],
};
const schemas = {
  CommerceMessage: object({ message: text }, ["message"]),
  CommerceInventoryError: object({ success: { type: "boolean", enum: [false] }, message: text }, ["success", "message"]),
  CommerceSuccess: object({ success: { type: "boolean", enum: [true] } }, ["success"]),
  CommercePublicStore: object({
    _id: objectId, name: text, address: text, logo: text, description: text,
    location: ref("GeoPoint"), parentStore: { ...objectId, nullable: true },
  }, ["_id", "name", "address", "logo", "description", "parentStore"]),
  CommerceStoreProfile: {
    ...object(profileProperties),
    description: "Partial owner profile update. All provided strings are trimmed. If either coordinate is supplied, both are required; empty coordinates are invalid.",
  },
  CommerceBranchInput: {
    ...object(profileProperties, Object.keys(profileProperties)),
    description: "All six fields are required by the creation handler, including logo and description (which may be empty strings).",
  },
  CommercePackageSize: {
    ...object(sizeProperties),
    description: "Optional packaged measurements. Omitted, null or blank measurements are removed when replacing packageSize; supplied nonblank values must be positive, at most 1,000,000. Numeric strings are also accepted.",
  },
  CommerceProduct: object({
    _id: objectId, id: text, name: text, description: text, richDescription: text, image: text,
    images: array(text), brand: text, price: number,
    category: { oneOf: [objectId, ref("Category")] },
    store: { ...objectId, nullable: true }, countInStock: whole, minStock: whole,
    sku: text, soldCount: whole, rating: number, numReviews: whole, isFeatured: boolean,
    approvalStatus: { type: "string", enum: ["pending", "approved", "denied"] },
    packageSize: ref("CommercePackageSize"), exportToEthiopia: boolean, dateCreated: date,
    inventoryManaged: boolean, storefrontId: objectId, storefrontName: text,
  }),
  CommerceInventory: object({
    _id: objectId, store: objectId,
    product: { oneOf: [objectId, ref("CommerceProduct")], nullable: true },
    price: money, countInStock: whole, reserved: whole, minStock: whole, createdAt: date, updatedAt: date,
  }),
  CommerceInventoryInput: object({
    price: money, countInStock: whole, minStock: whole,
  }, ["price", "countInStock", "minStock"]),
  CommerceLine: {
    ...object(lineProperties, ["product", "quantity", "price"]),
    description: "Quoted price is mandatory. The normalizer also accepts product._id or top-level _id/id aliases and numeric strings for quantity/price. Duplicate products are combined only when quoted prices agree.",
  },
  CommerceCartLine: object(cartProperties, ["key", "product", "quantity", "price"]),
  CommerceAddressInput: {
    ...object(addressProperties, addressRequired),
    description: "All values are trimmed; address2 must be supplied even when empty. ZIP is additionally required and nonempty outside Ethiopia. Address updates replace these fields, not patch them.",
  },
  CommerceAddress: object({
    ...addressProperties, _id: objectId, user: objectId, id: text, location: ref("GeoPoint"),
    createdAt: date, updatedAt: date,
  }),
  CommerceVehiclePolicy: object(vehicleProperties, Object.keys(vehicleProperties)),
  CommerceVehicleConfigInput: {
    ...object({
      enabled: boolean,
      vehicles: object(Object.fromEntries(vehicle.enum.map((type) => [type, ref("CommerceVehiclePolicy")])), vehicle.enum),
    }, ["enabled", "vehicles"]),
    description: "Configure all four vehicles, including disabled ones. Enabled capacities must be positive. Fees use at most two decimals. If globally enabled, at least one vehicle must be enabled. distanceRate is per mile in USA and per km otherwise.",
  },
  CommerceVehicleConfig: object({
    enabled: boolean, vehicles: object(Object.fromEntries(vehicle.enum.map((type) => [type, ref("CommerceVehiclePolicy")]))),
  }, ["enabled", "vehicles"]),
  CommerceInternationalConfigInput: {
    ...object(tariffProperties, Object.keys(tariffProperties)),
    description: "USA-region setting. Hub must be a complete USA address and is geocoded by the server. baseUsd + perKgUsd + minimumUsd must be positive. Billable kg is max(actual kg, volumetric kg), rounded up to 0.001 kg; fee is max(minimumUsd, baseUsd + perKgUsd * billableKg).",
  },
  CommerceInternationalConfig: object({
    ...tariffProperties, revision: whole,
    hub: ref("CommerceAddress"),
  }, ["enabled"]),
  CommerceBankAccount: object({
    _id: objectId, bankName: text, accountNumber: text, accountHolderName: text,
    bankCode: text, additionalInfo: text, isActive: boolean,
    currency: { type: "string", enum: ["USD", "ETB", "usd", "etb"] },
  }),
  CommerceQuoteInput: {
    ...object({
      cart: array(ref("CommerceCartLine"), { minItems: 1, maxItems: 50 }),
      addresses: array({
        ...object({ ...addressProperties, id: { type: "string", minLength: 1, maxLength: 100 } }, [...addressRequired, "id"]),
        description: "Unique client-generated id; all addresses must match the shopping region, except USA ETB international quotes require Ethiopian recipients. USA ZIP is required.",
      }, { minItems: 1, maxItems: 10 }),
      allocations: array(object({
        key: text, addressId: text, quantity: { type: "integer", minimum: 1 },
      }, ["key", "addressId", "quantity"]), { minItems: 1, maxItems: 100 }),
      deliveryMode: { ...mode, default: "STANDARD" },
      scheduledFor: { ...nullableDate, description: "Required future date/time for SCHEDULED; must be absent or null for other modes." },
      paymentCurrency: { type: "string", enum: ["usd", "etb"], description: "Defaults to region currency. Ethiopia USD requires a fresh enabled rate; USA ETB invokes product-only USA-to-Ethiopia shipping." },
    }, ["cart", "addresses", "allocations"]),
    description: "Cart keys and address ids must be unique. Allocations must reference known keys/addresses and assign every unit exactly once. Product ids may repeat under different cart keys. Prices are verified against catalog unless storefrontId constrains fulfillment to approved/open branches at the quoted inventory price.",
  },
  CommercePrepareInput: {
    ...object({
      method: { type: "string", enum: ["cash", "bank", "card"] },
      selections: array(object({ key: text, vehicle }, ["key", "vehicle"])),
      bankAccountId: objectId, deliveryMode: mode, scheduledFor: nullableDate,
      developmentCashOnDelivery: boolean,
    }, ["method"]),
    description: "Product quotes require exactly one unique key/vehicle selection per quoted delivery; service quotes do not. Bank payment requires an active account in the quote currency. deliveryMode/scheduledFor, if supplied, must match the quote exactly. USA cash requires developmentCashOnDelivery=true (a client build flag, not an authorization boundary). Converted Ethiopia USD quotes forbid cash; Ethiopia card requires a USD quote. International quotes require ETB bank transfer.",
  },
  CommerceCargo: object({
    weightKg: { ...number, nullable: true }, volumeLiters: { ...number, nullable: true },
    packages: array(array(number, { minItems: 3, maxItems: 3 })),
    measurementsAvailable: boolean, knownWeightKg: number, knownVolumeLiters: number,
  }),
  CommercePricingGroup: object({
    key: text, radiusMeters: number, storeId: objectId, storeName: text, distanceKm: number,
    storeCount: whole, vehicle, deliveryFee: money,
  }),
  CommerceDelivery: object({
    key: text, store: ref("CommercePublicStore"), address: ref("CommerceAddress"),
    storefrontId: { ...objectId, nullable: true },
    lines: array(object({ ...lineProperties, name: text, packageSize: { ...ref("CommercePackageSize"), nullable: true } })),
    cargo: ref("CommerceCargo"), quotedCargo: ref("CommerceCargo"), distanceKm: number,
    speedSurcharge: money,
    vehicleOptions: array(object({ type: vehicle, fee: money, vehicleFee: money, speedSurcharge: money })),
    vehicle: { type: "string", enum: ["", ...vehicle.enum] }, requiresVehicleSelection: boolean,
    pricingGroup: ref("CommercePricingGroup"), ...totals, paymentAmount: money, internationalShippingFee: money,
  }),
  CommerceDeliveryPolicy: object({
    minBusinessDays: whole, maxBusinessDays: whole, businessDayStartHour: whole,
    businessDayEndHour: whole, businessTimeZone: text, scheduledWindowHours: number,
  }),
  CommerceDeliverySnapshot: object({
    version: whole, quotedAt: date, deliveryMode: storedMode, scheduledFor: nullableDate,
    windowStart: date, windowEnd: date, policy: { ...ref("CommerceDeliveryPolicy"), nullable: true }, speedSurcharge: money,
  }),
  CommerceRateSnapshot: object({
    birrPerUsd: number, appliedAt: date, expiresAt: date, revision: whole, source: text,
    providerAsOf: nullableDate, direction: { type: "string", enum: ["usd-to-etb"] },
  }),
  CommerceShipment: object({
    id: text, recipient: ref("CommerceAddress"), weightKg: number, volumetricKg: number,
    billableKg: number, shippingUsd: money, status: shipmentStatus, carrier: text, trackingNumber: text,
    history: array(object({ status: shipmentStatus, at: date, note: text, user: objectId })),
  }),
  CommerceInternational: object({
    hub: ref("CommerceAddress"), policyRevision: whole, tariff: ref("CommerceInternationalConfig"),
    shipments: array(ref("CommerceShipment")), shippingFee: money, customsNotice: text,
  }),
  CommerceOrder: {
    ...object({
      _id: objectId, id: text, user: objectId, store: { ...objectId, nullable: true },
      checkoutGroup: { ...objectId, nullable: true }, storefrontId: { ...objectId, nullable: true },
      orderItems: array({ oneOf: [objectId, object({
        _id: objectId, quantity: whole,
        product: { oneOf: [objectId, ref("CommerceProduct")], nullable: true },
      })] }),
      shippingAddress1: text, shippingAddress2: text, city: text, zip: text, country: text, phone: text,
      status: { type: "string", description: "Includes numeric legacy codes, e.g. 4 for cancellation, as well as named statuses." },
      deliveryStatus: { type: "string", enum: ["Pending", "Driver Assigned", "Picked Up", "Delivered"] },
      inventoryManaged: boolean, fulfillmentStatus, fulfillmentDeadline: nullableDate,
      fallbackStore: { oneOf: [objectId, object({ _id: objectId, name: text, address: text, logo: text })], nullable: true },
      reservedItems: array(ref("CommerceLine")), assignedStoreSnapshot: object({
        storeId: objectId, name: text, address: text, logo: text,
      }),
      ...totals, deliveryMode: storedMode, scheduledFor: nullableDate,
      deliveryWindowStart: nullableDate, deliveryWindowEnd: nullableDate, deliveryDistanceKm: number,
      requiredVehicle: vehicle, cargo: ref("CommerceCargo"), deliveryPricingGroup: ref("CommercePricingGroup"),
      paymentMethod: text, methodName: text, paymentStatus: { type: "string", enum: ["pending", "completed", "failed"] },
      paymentCurrency: text, paymentAmount: number, paymentPaidAt: nullableDate,
      exchangeRate: ref("CommerceRateSnapshot"), internationalShippingFee: number,
      internationalShipping: object({
        shipmentId: text, status: shipmentStatus, hub: ref("CommerceAddress"), recipient: ref("CommerceAddress"),
        customsNotice: text, carrier: text, trackingNumber: text,
        history: array(object({ status: shipmentStatus, at: date, note: text, user: objectId })),
      }),
      refundStatus: { type: "string", enum: ["pending", "failed", "refunded", "not_required"] },
      refundId: { ...text, nullable: true }, refundAttempt: whole, dateOrdered: date,
    }),
    description: "Order document. orderItems are populated with product name/image (and price on assignment listings); otherwise they are ids. Additional persisted Order fields may be present.",
  },
  CommerceCheckout: {
    ...object({
      _id: objectId, id: text, user: objectId,
      status: { type: "string", enum: ["quote", "awaiting_payment", "bank_review", "placed", "cancelled"] },
      kind: { type: "string", enum: ["products", "service"] }, serviceRequest: objectId,
      deliveries: array(ref("CommerceDelivery")), cart: array(ref("CommerceCartLine")),
      orders: array(objectId), ...totals, deliveryMode: storedMode,
      deliverySnapshot: ref("CommerceDeliverySnapshot"), scheduledFor: nullableDate,
      deliveryWindowStart: nullableDate, deliveryWindowEnd: nullableDate,
      currency: { type: "string", enum: ["usd", "etb"] }, exchangeRate: ref("CommerceRateSnapshot"),
      paymentAmount: money, international: ref("CommerceInternational"), expiresAt: date,
      paymentMethod: { type: "string", enum: ["cash", "bank", "card"] },
      paymentStatus: { type: "string", enum: ["pending", "completed", "cancelled"] },
      stripePublishableKey: text, paymentRevision: whole,
      bankReference: text, bankSender: text, bankAccount: ref("CommerceBankAccount"),
      createdAt: date, updatedAt: date,
    }, ["_id", "user", "status", "kind", "deliveries", "cart", "orders", "itemsSubtotal", "deliveryFee", "totalPrice", "currency", "expiresAt", "paymentStatus"]),
    description: "Serialized checkout; paymentIntentId is removed. Quotes expire after 10 minutes; prepared holds last 15 minutes. For Ethiopia USD, totals remain ETB and paymentAmount is USD. International USA ETB totals remain USD, with paymentAmount in ETB. Service checkouts have empty cart/deliveries.",
  },
  CommerceCheckoutDetail: {
    allOf: [ref("CommerceCheckout"), object({ childOrders: array(ref("CommerceOrder")) }, ["childOrders"])],
  },
  CommerceExchangePublic: object({
    active: boolean, enabled: boolean, birrPerUsd: number, appliedAt: date, expiresAt: nullableDate,
    revision: whole, source: text, message: text, cardAvailable: boolean,
  }, ["active", "enabled", "message", "cardAvailable"]),
  CommerceExchangeState: {
    ...object({
      active: boolean, enabled: boolean, autoRefresh: boolean, provider: text,
      birrPerUsd: number, appliedAt: date, expiresAt: nullableDate, revision: whole, source: text,
      providerAsOf: nullableDate, lastError: { ...text, nullable: true }, lastAttemptAt: date, message: text,
      history: array(object({
        birrPerUsd: number, appliedAt: date, source: text, providerAsOf: nullableDate,
        changed: boolean, user: { ...objectId, nullable: true },
      })),
      providers: array(text), cardAvailable: boolean,
    }, ["active", "expiresAt", "message"]),
    description: "Full configuration state for admin GET and mutation results. providers and cardAvailable are added only by GET; unsaved settings can omit configuration fields. History retains the last 30 applied rates.",
  },
};

const json = (schema) => ({ "application/json": { schema } });
const response = (description, schema) => ({ description, content: json(schema) });
const parameter = (name, schema = objectId, description = "MongoDB ObjectId") => ({
  name, in: "path", required: true, description, schema,
});
const query = (name, schema, description) => ({ name, in: "query", description, schema });
const paths = {};
function add(method, suffix, summary, schema, options = {}) {
  const inventory = options.inventory === true;
  const prefix = options.exchange ? "/api/v1/exchange-rate" : "/api/v1/stores";
  const code = options.created ? "201" : "200";
  const errorSchema = ref(inventory ? "CommerceInventoryError" : "CommerceMessage");
  const parameters = [...suffix.matchAll(/\{([^}]+)\}/g)].map((match) =>
    parameter(match[1], options.paramSchemas?.[match[1]] || objectId,
      options.paramDescriptions?.[match[1]] || "MongoDB ObjectId"));
  const operation = {
    tags: [options.exchange ? "Exchange rates" : inventory ? "Store inventory" : "Delivery checkout"],
    summary,
    description: `${options.scope || "Bearer authentication required; acts on the signed-in customer's resources."} ${options.description || ""}`.trim(),
    security: options.public ? [] : [{ bearerAuth: [] }],
    responses: {
      [code]: response(options.success || "Successful response.", schema),
      ...(!options.public ? { 401: response("Missing or invalid bearer token / sign-in required.", errorSchema) } : {}),
      ...(options.forbidden ? { 403: response(options.forbidden, errorSchema) } : {}),
      ...(options.notFound ? { 404: response(options.notFound, errorSchema) } : {}),
      409: response(options.conflict || "Validation or business-state conflict; message explains the required correction.", errorSchema),
      500: response(inventory ? "Unable to process store inventory. Please retry." :
        options.exchange ? "Exchange settings are unavailable. Please retry." :
          "Delivery checkout failed. Resume this checkout or contact support; do not pay again.", errorSchema),
    },
  };
  if (parameters.length || options.query) operation.parameters = [...parameters, ...(options.query || [])];
  if (options.body) operation.requestBody = {
    required: options.bodyRequired !== false,
    content: json(options.body),
  };
  const path = `${prefix}${suffix}`;
  if (!paths[path]) paths[path] = {};
  paths[path][method] = operation;
}
const owner = {
  inventory: true,
  scope: "Bearer authentication required. Store owner only: the store owner id must equal the authenticated user id; admin status does not bypass ownership.",
  forbidden: "You cannot manage this store.",
};
const admin = {
  scope: "Bearer authentication and admin role (isAdmin) required.",
  forbidden: "Admin access required.",
};
const checkoutOwner = {
  scope: "Bearer authentication required. Checkout owner or admin; other users see 404.",
  notFound: "Checkout not found.",
};
const businessDelivery = "New quotes support EXPRESS (default policy 1–2 business days), STANDARD (default, 2–5 business days), or SCHEDULED (future scheduledFor, default 2-hour window). Business days skip Saturday/Sunday, not holidays; windows open at the configured start hour on the earliest business day and close at the end hour on the latest day. Defaults are 09:00–18:00 in Africa/Addis_Ababa or America/New_York; admin configuration can override them. SAME_DAY/NEXT_DAY are historical only. Delivery fees use vehicle base + driving distance × rate (miles for USA, km otherwise) + the configured mode surcharge; they do not use legacy delivery fee formulas.";
const feeSharing = "Fulfillment first prefers one eligible store covering all allocations and total quantities across recipients; otherwise stock may split into at most 20 store/address deliveries. Main-catalog selection deprioritizes the migration default store, then sorts by distance and id. Storefront lines use the selected store family at its quoted price. Nearby pickups share fees only for the same recipient, pairwise within 500 meters and the same selected vehicle: the nearest pickup's option fee is split evenly in cents (stable key order gets remainder cents), not summed. Different vehicles price separately.";

add("get", "/directory", "List public approved open stores", array(ref("CommercePublicStore")), {
  inventory: true, public: true, scope: "Public; no bearer token required.",
  description: "Sorted by name. approvalStatus must be approved and isOpen must not be false. Only publicStore fields are returned.",
});
add("get", "/directory/{id}/products", "Browse a storefront and its branches", object({
  store: ref("CommercePublicStore"), branches: array(ref("CommercePublicStore")), products: array(ref("CommerceProduct")),
}, ["store", "branches", "products"]), {
  inventory: true, public: true, scope: "Public; no bearer token required.",
  description: "Requires migrated store inventory. Includes approved/open main store and sibling branches. One row per approved product: selected location's inventory price wins when present. countInStock sums nonnegative unreserved quantities across branches only at that same price. Products include populated category, inventoryManaged=true and selected storefront id/name.",
  notFound: "Storefront not found.", conflict: "Invalid store ID or store shopping is not enabled.",
});
add("post", "/checkout-availability", "Check single-store cart availability", {
  oneOf: [
    object({ inventoryManaged: { type: "boolean", enum: [false] } }, ["inventoryManaged"]),
    object({ inventoryManaged: { type: "boolean", enum: [true] }, store: ref("CommercePublicStore") }, ["inventoryManaged", "store"]),
  ],
}, {
  inventory: true, body: object({
    orderItems: array(ref("CommerceLine"), { minItems: 1 }), storefrontId: objectId,
    customerLocation: {
      oneOf: [ref("GeoPoint"), object({
        longitude: { type: "number", minimum: -180, maximum: 180 },
        latitude: { type: "number", minimum: -90, maximum: 90 },
      }, ["longitude", "latitude"])],
    },
  }, ["orderItems", "customerLocation"]),
  description: "When inventory is disabled returns inventoryManaged=false before validating the cart. Otherwise requires a verified delivery location and one approved/open store that can fulfill the entire cart at quoted prices; does not split the cart. Catalog prices are checked unless storefrontId is supplied, which restricts candidates to approved/open locations in that store family. Main-catalog candidates put the migration default store last, then sort by distance and id. No reservation is created.",
  conflict: "Invalid cart/location/storefront, changed catalog price, unavailable quoted price/quantity, or no single store can fulfill the entire cart.",
});
add("get", "/me/locations", "List owned store locations", object({
  stores: array(ref("CommercePublicStore")), inventoryEnabled: boolean,
}, ["stores", "inventoryEnabled"]), {
  inventory: true, scope: "Bearer authentication required; returns only locations whose owner is the signed-in user (including for admins).",
});
add("put", "/me/locations/{id}", "Update an owned store profile", ref("CommercePublicStore"), {
  ...owner, body: ref("CommerceStoreProfile"),
});
add("post", "/me/locations/{id}/branches", "Create an owned main store's branch", ref("CommercePublicStore"), {
  ...owner, created: true, body: ref("CommerceBranchInput"),
  description: "Parent must be a main store, not a branch. New branch inherits owner, isCompanyOwned and approvalStatus; location is stored as [longitude, latitude].",
});
add("get", "/me/locations/{id}/inventory", "List an owned location's inventory", array(ref("CommerceInventory")), {
  ...owner, description: "Product and its category are populated. Does not require inventory migration to have been enabled.",
});
add("put", "/me/locations/{id}/inventory/{productId}", "Upsert owned per-store inventory", ref("CommerceInventory"), {
  ...owner, body: ref("CommerceInventoryInput"),
  description: "Requires migrated inventory and an existing approved product (legacy products without approvalStatus are accepted). countInStock cannot fall below reserved quantity. All three numeric fields must be supplied; numeric strings are also accepted. Product is an id in the returned document.",
});
add("delete", "/me/locations/{id}/inventory/{productId}", "Delete an unreserved owned inventory listing", ref("CommerceSuccess"), {
  ...owner, conflict: "Invalid identifier, missing listing, or listing has reserved orders; finish/cancel those orders first.",
});
add("get", "/me/assignments", "List pending store-owner assignments", array(ref("CommerceOrder")), {
  inventory: true, scope: "Bearer authentication required; only assignments for stores owned by the authenticated user.",
  description: "Reconciles fallback assignments first. Returns active inventory-managed pending/accepted assignments and pending fallback-store orders without a driver or assigned store; excludes admin-review and terminal orders. Sorted oldest first. fallbackStore and orderItems.product are populated.",
});
add("post", "/me/assignments/{id}/{decision}", "Respond to an owned store assignment", object({
  success: { type: "boolean", enum: [true] }, fulfillmentStatus,
}, ["success"]), {
  ...owner, paramSchemas: { decision: { type: "string", enum: ["accept", "reject", "reroute"] } },
  paramDescriptions: { decision: "Assignment decision; reroute rejects an inventory assignment or reconciles fallback routing." },
  notFound: "Assignment not found.",
  description: "id is an order/assignment id. Ownership is checked against fallbackStore or store. Inventory acceptance must be within the response deadline; reroute is treated as reject. Fallback fulfillmentStatus may be omitted if the helper result has no such field.",
});
add("post", "/admin/inventory/migrate", "Migrate catalog stock to per-store inventory", object({
  success: { type: "boolean", enum: [true] }, products: whole,
}, ["success", "products"]), {
  ...admin, inventory: true, body: object({ defaultStoreId: objectId }, ["defaultStoreId"]),
  description: "One-time transactional migration; blocks while active orders exist and after inventory is enabled. Default store must be approved. Existing products need valid nonnegative stock and cent-precision prices. Products linked to approved stores keep them; others go to defaultStoreId. Existing inventory rows are preserved; new rows start reserved=0, minStock=product.minStock || 5. Enables inventory after migration.",
});

add("get", "/delivery-config", "Read vehicle delivery configuration", ref("CommerceVehicleConfig"), {
  scope: "Bearer authentication required; any signed-in user.",
  description: "Returns saved configuration or {enabled:false, vehicles:{}}. This is vehicle capacity/pricing configuration, not the separate business-day delivery policy.",
});
add("put", "/delivery-config", "Replace vehicle delivery configuration", ref("CommerceVehicleConfig"), {
  ...admin, body: ref("CommerceVehicleConfigInput"),
});
add("get", "/international-shipping-config", "Read USA-to-Ethiopia shipping settings", ref("CommerceInternationalConfig"), {
  scope: "Bearer authentication required; any signed-in user, USA region only.",
  description: "Returns saved configuration or {enabled:false}. A non-USA region returns 409.",
});
add("put", "/international-shipping-config", "Replace USA-to-Ethiopia shipping settings", ref("CommerceInternationalConfig"), {
  ...admin, body: ref("CommerceInternationalConfigInput"),
  description: "USA region only. Geocodes the hub and increments the configuration revision transactionally; existing quotes must be recalculated if the revision changes before reservation.",
});
add("put", "/international-products/{id}", "Set a USA product's Ethiopia export eligibility", ref("CommerceProduct"), {
  ...admin, body: object({ exportToEthiopia: boolean }, ["exportToEthiopia"]),
  description: "USA region only; requires explicit boolean. Missing product is a 409, not a 404.",
});
add("put", "/delivery-products/{id}", "Replace optional packaged product measurements", ref("CommerceProduct"), {
  ...admin, body: ref("CommercePackageSize"),
  description: "An empty object intentionally clears all packaged measurements. Missing dimensions/weight do not block domestic quoting, but force explicit vehicle selection. International quotes require all four positive measurements. Missing product returns 409.",
});
add("get", "/delivery-addresses", "List the customer's saved delivery addresses", array(ref("CommerceAddress")), {
  description: "Sorted by updatedAt descending; no admin cross-user override.",
});
add("get", "/delivery-current-address", "Read current address defaults", object({
  label: text, address1: text, address2: text, city: text, zip: text, country: text, phone: text,
}, ["label", "address1", "address2", "city", "zip", "country", "phone"]), {
  description: "label is Current address. Each field comes from the latest noncancelled order not in payment_pending fulfillment, falling back to the user profile, then empty string. Does not return a saved address id or verified location.",
});
add("get", "/delivery-bank-accounts", "List active accounts in a selected currency", array(ref("CommerceBankAccount")), {
  query: [query("currency", { type: "string", enum: ["USD", "ETB"] }, "Case-insensitive; defaults to USD for USA, ETB otherwise.")],
  description: "Only active accounts matching the requested currency. Legacy accounts without currency use region currency.",
});
add("post", "/delivery-addresses", "Save a delivery address", ref("CommerceAddress"), {
  created: true, body: ref("CommerceAddressInput"),
});
add("put", "/delivery-addresses/{id}", "Replace a saved delivery address", ref("CommerceAddress"), {
  body: ref("CommerceAddressInput"), conflict: "Invalid identifier, invalid address fields, or no saved address owned by the authenticated user.",
});
add("delete", "/delivery-addresses/{id}", "Delete a saved delivery address", ref("CommerceMessage"), {
  notFound: "Saved address not found (including another user's address).",
  success: "Saved address deleted.",
});
add("post", "/checkouts/quote", "Quote multi-store / multi-recipient product checkout", ref("CommerceCheckout"), {
  created: true, body: ref("CommerceQuoteInput"),
  description: `${businessDelivery} ${feeSharing} Requires active per-store inventory, enabled vehicle config, approved products, verified geocoded recipient addresses and routable pickups. USA ETB invokes international shipping: Ethiopian recipients, USA hub delivery, export-eligible products with complete packaged measurements, enabled shipping settings and a fresh export exchange rate. Tariff uses max(actual, volumetric) kg and is allocated across each recipient's pickups proportionally by item subtotal (cent remainders distributed deterministically). Duties/customs/clearance are excluded and the recipient's responsibility. Ethiopia USD divides ETB totals by birrPerUsd; USA international ETB multiplies USD totals. Rates must be enabled and less than 24 hours old; prepare checks their revision/freshness again. Quote does not reserve stock.`,
});
add("post", "/service-checkouts/{serviceId}", "Quote an Ethiopia service for USD payment", ref("CommerceCheckout"), {
  created: true,
  description: "Service customer only, even for admins. Requires enabled fresh Ethiopia USD rate, Ethiopia/ETB service request with positive admin quotedPrice and status quoted, in_progress or completed. Reuses an existing checkout if already linked; otherwise creates a 10-minute service quote with no deliveries/cart. USA region and international service export are not supported.",
});
add("get", "/checkouts", "List recent nonquote checkouts", array(ref("CommerceCheckout")), {
  scope: "Bearer authentication required; customer's checkouts by default. Only admins can request all users with all=true.",
  query: [query("all", { type: "string", enum: ["true", "false"] }, "Only the exact string true with admin role removes the user filter.")],
  description: "Excludes status quote; newest first, at most 50. Nonadmins cannot access other users by supplying all=true.",
});
add("get", "/checkouts/{id}", "Read checkout and child orders", ref("CommerceCheckoutDetail"), {
  ...checkoutOwner, description: "Includes childOrders with orderItems and product name/image populated; paymentIntentId is removed from the checkout.",
});
add("post", "/checkouts/{id}/prepare", "Reserve quote stock and choose payment method", ref("CommerceCheckout"), {
  scope: "Bearer authentication required. Customer must own the checkout; although the initial lookup permits admin access, prepare also queries by the authenticated user id and does not allow an admin to prepare another customer's checkout.",
  notFound: "Checkout not found at initial owner/admin lookup.",
  body: ref("CommercePrepareInput"),
  description: "Rechecks stock, prices, pickup location, vehicle config/capacity, business-day timing/surcharge snapshot and exchange/international revisions. A business window that has already opened requires a new quote. Reserves stock and creates payment_pending child orders with a 15-minute hold. Cash immediately activates/places checkout; bank/card await confirmation. PaymentIntent creation is deliberately separate: persist this reservation id before calling /payment. Repeating prepare with the same method on an existing noncancelled reservation returns it without creating another reservation.",
});
add("post", "/checkouts/{id}/payment", "Create or resume one combined card payment", object({
  group: ref("CommerceCheckout"), clientSecret: text,
}, ["group"]), {
  ...checkoutOwner,
  description: "Prepared card checkouts only. Uses the existing PaymentIntent or an idempotent create; clientSecret is omitted if already placed or payment already succeeded. Expired reservations are reconciled first, returning a placed checkout if payment succeeded or 409 otherwise. Never start a second checkout/payment to recover a failed response.",
});
add("post", "/checkouts/{id}/confirm", "Reconcile card payment or submit bank receipt", ref("CommerceCheckout"), {
  ...checkoutOwner,
  body: object({ reference: nonempty300, sender: nonempty300 }),
  bodyRequired: false,
  description: "Bank requires reference and sender (nonempty, at most 300 characters before trimming). Card needs no body: the server verifies amount, currency, metadata and succeeded status before activation. Domestic bank receipt places the checkout but leaves payment pending until admin verification. International ETB bank receipt moves to bank_review with stock held, awaiting admin verification; it does not dispatch. Repeated confirmation of an already placed checkout is idempotent.",
});
add("post", "/checkouts/{id}/cancel", "Cancel an unpaid checkout reservation", ref("CommerceCheckout"), {
  ...checkoutOwner,
  description: "Only awaiting_payment reservations can be cancelled; already cancelled is idempotent. Reconciles card state before releasing stock: a succeeded payment may place rather than cancel the checkout. Placed checkouts require individual delivery cancellation. International bank_review is not customer-cancellable; use admin bank-reject only if no funds arrived.",
});
add("post", "/checkouts/{id}/deliveries/{orderId}/cancel", "Cancel one delivery before driver assignment", object({
  order: ref("CommerceOrder"), refundPending: boolean,
}, ["order", "refundPending"]), {
  ...checkoutOwner,
  description: "Placed checkout only. Requires deliveryStatus=Pending and fulfillment pending, accepted or unassigned; already cancelled is idempotent. International shipment must still be awaiting_hub. Releases reservations; paid noncash delivery becomes refundStatus=pending, otherwise not_required. Cancellation commits independently of refund processing; this route does not issue a refund.",
});
add("post", "/checkouts/{id}/deliveries/{orderId}/refund", "Reconcile or retry a cancelled card-delivery refund", ref("CommerceOrder"), {
  ...admin, notFound: "Checkout not found.",
  body: object({ retryFailed: boolean }), bodyRequired: false,
  description: "Cancel the delivery first. Card refunds use its original payment allocation, including converted currency. Pending/failed refunds are reconciled; explicit retryFailed=true permits retrying a failed/cancelled provider refund. Existing nonpending/nonfailed states are returned unchanged. Bank refunds must be performed separately and recorded with manual-refund. Provider pending/failed receipts return 409 and persist refund state; do not blindly create duplicate refunds.",
});
add("post", "/checkouts/{id}/bank-confirm", "Verify combined bank funds", {
  oneOf: [ref("CommerceCheckout"), ref("CommerceMessage")],
}, {
  ...admin, notFound: "Checkout not found.",
  description: "Domestic: requires a placed bank checkout, marks group/service/child orders completed; cancelled deliveries then require refunds. Returns {message:'Combined bank payment recorded. Cancelled deliveries now require refunds.'}. International: requires bank_review and a submitted reference, marks payment completed and activates the checkout, returning the serialized group.",
});
add("post", "/checkouts/{id}/bank-reject", "Reject international bank review with no funds received", ref("CommerceCheckout"), {
  ...admin, notFound: "Checkout not found.",
  body: object({ noFundsReceived: { type: "boolean", enum: [true] } }, ["noFundsReceived"]),
  description: "Only international bank_review; requires explicit noFundsReceived=true. Releases stock and cancels checkout. If funds arrived, verify payment and use a documented bank refund instead.",
});
add("post", "/checkouts/{id}/shipments/{shipmentId}", "Advance verified international shipment tracking", ref("CommerceCheckout"), {
  ...admin, notFound: "Checkout not found.",
  paramSchemas: { shipmentId: { type: "string", minLength: 1, maxLength: 100 } },
  paramDescriptions: { shipmentId: "Client address/shipment id from the quote, not an ObjectId." },
  body: object({
    status: { type: "string", enum: ["at_hub", "shipped", "arrived_ethiopia", "delivered"] },
    carrier: string300, trackingNumber: string300, note: string300,
  }, ["status"]),
  description: "Requires placed, payment-completed international checkout. Advance exactly one stage: awaiting_hub → at_hub → shipped → arrived_ethiopia → delivered. All noncancelled pickups for this recipient must first have deliveryStatus=Delivered at the USA hub, and at least one active pickup is required. shipped requires nonempty carrier/trackingNumber; delivered requires a nonempty note proving final delivery/recipient confirmation. History and related orders are updated transactionally.",
});
add("post", "/checkouts/{id}/deliveries/{orderId}/manual-refund", "Record an already returned bank refund", ref("CommerceOrder"), {
  ...admin, notFound: "Checkout not found.",
  body: object({ reference: { type: "string", minLength: 1, description: "Nonblank refund reference; trimmed and truncated to 300 characters." } }, ["reference"]),
  description: "Bank checkout only; order must belong to checkout, be cancelled and have refundStatus=pending. Records refundStatus=refunded and refundId=reference. Does not move money.",
});

const exchangeDescription = "Region selects independent settings: Ethiopia USD purchasing versus USA ETB product-export checkout. A rate is active only when enabled, positive and applied within the last 24 hours (not in the future). Applying a rate does not implicitly enable the service. Snapshotted rate revisions are checked again before payment reservation.";
add("get", "", "Read region exchange-rate state", {
  anyOf: [ref("CommerceExchangePublic"), ref("CommerceExchangeState")],
}, {
  exchange: true, scope: "Bearer authentication required; any signed-in user. Admins receive the full configuration/history and configured provider names; other users receive only public state fields.",
  description: `${exchangeDescription} cardAvailable is true only for Ethiopia USD when the server has both live Stripe keys; it is always false for USA export settings and is separate from the active rate flag.`,
});
add("put", "", "Update exchange service enablement and auto-refresh", ref("CommerceExchangeState"), {
  ...admin, exchange: true,
  body: object({ enabled: boolean, autoRefresh: boolean, provider: text }, ["enabled", "autoRefresh"]),
  description: `${exchangeDescription} autoRefresh=true requires a configured provider name. Saves flags/provider and increments revision transactionally, preserving the rate/history; does not fetch or apply a new rate.`,
});
add("post", "/apply", "Apply a manual birr-per-dollar rate", ref("CommerceExchangeState"), {
  ...admin, exchange: true,
  body: object({ birrPerUsd: { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 1000000 } }, ["birrPerUsd"]),
  description: `${exchangeDescription} Numeric strings are also accepted. Sets appliedAt, source=manual, clears lastError, increments revision and appends history (last 30 entries).`,
});
add("post", "/refresh", "Fetch and apply the configured provider rate", ref("CommerceExchangeState"), {
  ...admin, exchange: true,
  description: `${exchangeDescription} Explicit forced refresh can run even when disabled/autoRefresh=false, but requires a configured provider. Provider timestamp must be present, not future and less than 24 hours old. Only provider names, never credentials or provider definitions, are exposed.`,
  conflict: "Invalid/unconfigured provider or rate/timestamp; provider errors; or settings changed during refresh (reload, no stale provider result overwrote newer settings).",
});

module.exports = { paths, schemas };
