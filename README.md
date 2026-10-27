# E-Shop Backend API

A comprehensive REST API for an e-commerce platform built with Node.js, Express, and MongoDB. Features include JWT authentication, payment gateway integrations (Stripe & Telebirr), order management, and email notifications.

## Per-store delivery routes and store dispatch

New product quotes on website and mobile use `storeRoutes` in USA and Ethiopia.
Each fulfilling store has its own road route: store -> first drop-off -> subsequent
drop-offs. Charge its configured vehicle base fee, distance rate (USA miles /
Ethiopia kilometers), and one speed surcharge per store. Nearby stores do not
share a fee. Select one vehicle for all destinations from that store; other stores
may use different vehicles. Exact-cent destination shares conserve each route's
fee and billable distance for receipts, commissions and refunds.
The geographic nearest-next ordering is priced using actual Google road legs;
it is not a guaranteed shortest-road-route optimizer. Driver travel to pickup,
other customers' detours and operational batching never reprice a reserved fee.
US exports use these rules only for the US store-to-hub legs; international
shipping remains separately priced.

Checkout allocates nearest eligible matching-price stock first, within the
selected storefront family when applicable. After payment/checkout activation,
stores accept or reject timed requests. Rejections/timeouts try other eligible
stores before the configured default-store fallback. The fallback stays in a
durable no-expiry list even while the default store is offline, including for
unrelated storefronts. If no open store has stock, checkout can quote and reserve
matching stock at the approved configured default even while closed. Activation
keeps that stock reserved in the offline queue to prevent overselling. Claiming
transactionally revalidates the reservation; rejection, rerouting and cancellation
release it.
The default store must open to claim; it may instead reroute or reject for Admin
review. Claiming and rerouting never require Admin approval. A claimed request
can be prepared and dispatched directly, or rerouted before it is released to a
driver batch. Rerouting offers other eligible stores a timed chance to accept.
Only explicit fallback rejection enters Admin review; it does not cancel payment
or refund it. Store changes do not change the saved customer delivery fee.

Admins use **Store Requests** on either client, backed by
`GET stores/admin/assignments` and
`POST stores/admin/assignments/:id/{accept|reroute|ready}`. Claiming uses the
assigned/default store (or an explicit `storeId`). Admin can bypass ownership,
online status and storefront scope; approved status, stock and matching prices
still apply. Admin rerouting reopens prior
eligible attempts except the released store, with an offline default queue if
none can accept. Admin can release ready packages using
`POST stores/admin/dispatch-batches` with `{ "orderIds": ["..."] }`.
Rejected requests remain visible for review, including after cancellation.
Deletion uses the existing Admin order-delete endpoint: grouped deliveries must
first be cancelled through their checkout and any required refund reconciled.
Claim/reroute cannot reopen cancelled, payment-pending or driver-dispatched orders.

New orders carry `storeRouteVersion: 1`. Acceptance alone never offers them to
drivers. Owners use `POST stores/me/assignments/:id/ready`, then
`POST stores/me/dispatch-batches` with `{ "orderIds": ["..."] }`.
Select 1-20 accepted ready packages from one open approved owned store with the
same vehicle. Packages from different customer checkouts may share a batch.
A single-package dispatch needs no reason. Unknown measurements permit only a
single manually selected package; measured batches must fit vehicle capacity.
`StoreDispatch` records and transactional order locks prevent duplicate release.
No driver being online is necessary to queue a batch.

Drivers claim the entire store batch atomically through the existing
available-deliveries API. Pickup, navigation and delivery gates require all live
packages in that batch to be collected before any drop-off. Other stores in a
customer's checkout prepare/dispatch independently. Payments and refund records
remain in the original `CheckoutGroup`; the dispatch batch is not a new payment.
Driver approval, availability, capacity and partner pickup radius are rechecked
on claim. A driver's combined operational route may include several batches.

Deploy backend first, then website and mobile together. Inventory and vehicle
pricing must already be enabled, with an approved default store and valid map
pins. Existing quotes/orders retain their saved legacy pricing and dispatch,
including cart-wide pickup gates on historical `cartRouteVersion: 1` orders.
No backfill or repricing of paid orders is required.

Older accepted orders do not show preparation controls until explicitly upgraded.
**Enable store preparation** on either client calls
`POST stores/{me|admin}/assignments/:id/enable-preparation` with optional `{ "vehicle": "car" }`.
Only the assigned store owner or Admin can opt in. Legacy cart-wide orders upgrade
all active packages together, only after every store has accepted and before any
driver assignment/pickup. Saved fees, checkout IDs, billing routes, payment records
and stock reservations stay unchanged. Existing company offers are withdrawn.
The upgrade does not mark packages ready: each store then uses **Mark package ready**
and **Dispatch selected**. Missing cargo measurements are recorded as unknown and
require single-package dispatch; orders lacking a saved vehicle require explicit
selection of a suitable enabled vehicle. No automatic migration runs.

Focused tests: `node --test tests\cart-route.test.js tests\cart-dispatch.test.js tests\store-dispatch.test.js tests\store-inventory.test.js tests\multi-delivery.test.js tests\driver-route.test.js`.

### Shared unclaimed delivery assignments

Website and mobile driver dashboards use authenticated
`GET /api/v1/drivers/me/available-deliveries` and
`PUT /api/v1/drivers/me/available-deliveries/:id/claim`. Unassigned, dispatch-ready
carts saved under legacy rules are not restricted to the driver selected for an
automatic company offer. Eligible available company and partner drivers can
claim them; the first successful transactional claim wins. A claim accepts the
whole cart immediately and does not require a live socket or a second acceptance.
Both reads and claims enforce approval, suspension, availability, delivery mode,
vehicle, remaining capacity and ride exclusions. Partner drivers must be within
the existing 5 km first-pickup radius; company drivers retain their no-radius
fallback. New store-dispatch batches instead designate one company driver at a
time: nearby available partner first, nearest available company driver next
(without a radius limit), then nearest eligible offline company driver. Offline
offers persist in `companyOfferDriver` and appear only in the designated company
driver's list. A nearby eligible partner may still manually claim an unclaimed
batch. Approval, service, vehicle, ride and cargo checks govern fallback selection;
going online and meeting current capacity are required for self-claim.
Partner responses expose pickup stops and approximate drop zones only,
preserving exact recipient address/phone privacy before pickup.

Unclaimed requests remain in the database when nobody is available. Company
drivers see this durable backlog on reopening, focus and periodic refresh even
while offline or full, with `canClaim: false`; going online does not assign an
order automatically through the list. Company drivers have `canRespond: true`
on their unclaimed ready requests, even without an available alternative.
New store batches require a designated offer to respond. `PUT orders/:id/company-reject` and `/company-reroute` both record
that driver's refusal for the whole cart, clear the company offer and leave the
request queued for other eligible company or partner drivers. These actions
remove it only from the responding driver's list. Reject also flags it for
non-blocking Admin review through `orders/admin/company-rejections`; Reroute
does not. The saved response's `action` distinguishes the two while both use
`status: "rejected"` to exclude the responding driver. Historical rejected
responses without an action remain visible to Admin. Neither action sets
the dispatch-blocking `adminReviewRequired` field, cancels the order, changes
its price or refunds payment. Partner drivers cannot use these company response
actions. Blocking-Admin-review, cancelled,
future-scheduled and not-store-accepted requests cannot be released this way.
An assigned company driver may also release the whole batch before any pickup.
Once any live package is picked up, neither drivers, stores nor Admin may reassign
the batch; a physical handover workflow is not implemented.
Previous refusals exclude only the responding driver from subsequent claims
and offers. Existing automatic dispatch and company offer APIs remain supported.

Dispatching store owners and Admin use
`POST stores/{me|admin}/assignments/:id/drivers/reroute` to release/reoffer the whole
batch without splitting it. Driver rejections remain visible in **Admin > Store
Requests**, including after cancellation, and do not block other drivers.
`POST stores/admin/assignments/:id/drivers/assign` with `{ "driverId": "..." }`
directly assigns the complete batch (or legacy single delivery), bypassing online
status, ownership, proximity and previous refusal. The selected driver must still
be approved, non-suspended, compatible and have capacity, with no active ride or
exclusive load. Admin assignment never turns an offline driver online.
Admin can also claim matching stock and release ready batches from closed approved
stores. None of these overrides bypass payment/refund, stock, preparation,
scheduled-window or pickup/completion safeguards. Use the existing checkout
cancellation/refund flow before deleting active paid orders.

## Regional payment availability

Deploy this backend before the matching website/mobile payment controls.
`GET /api/v1/settings/payment-methods` is public and uncached; authenticated
Admin `PUT` accepts only partial boolean switches, for example
`{"methods":{"cash":false,"card":true}}`. Both requests use
`x-database-name` to select USA or Ethio. Each region persists its own
`SiteSetting` with key `payment-methods`; omitted methods default ON.
Updates to one method do not overwrite the others.

Cash, bank, card and Telebirr switches apply identically in development and
production. USA cash no longer requires `developmentCashOnDelivery`.
New grouped reservations, ride payment-method selection, new card intents,
legacy order submissions and legacy Stripe/Telebirr starts enforce the
regional setting. Disabled methods return 503; if all switches are OFF the
message is "Payment is temporarily unavailable. Please try again later."
Settings database failures also return 503, never an enabled fallback.

Existing grouped reservations and saved ride methods can be recovered;
existing card intents, confirmation/status endpoints, gateway callbacks and
refunds remain accessible. Legacy order creation remains a new submission:
coordinate disabling around already-paid legacy orders, which need their
method re-enabled before submission. Switches do not replace actual provider
configuration or currency support: grouped checkout/rides do not support
Telebirr, international shipping remains ETB bank-only, and converted/service
payments exclude cash.

## Optional store logos (shared mobile and website)

Stores use the existing `Store.logo` field; no database migration is needed.
Company-store creation/editing, generic store creation/editing, owner registration,
owner profile updates and branch creation accept an optional `logo` HTTPS URL
(maximum 500 characters). Omit it on edits to retain the saved image; send `""`
to remove it and let clients display initials derived from the registered name.
Invalid URLs, non-string values and non-HTTPS URLs return HTTP 400 before saving.
Directory/storefront and owner-profile responses include the saved logo.

Mobile and website forms can select JPEG, PNG or WebP files up to 5 MB,
uploaded through the existing Cloudinary signing integration into `eshop/stores`.
The resulting secure URL is persisted only when the store form is saved.
Cloudinary must already be configured on the backend; upload failures are shown
to the user and never replaced with a fake saved image. Replacing/removing a
logo changes the store reference, not the shared Cloudinary asset itself.
Deploy this backend before the matching clients so company-store logo edits persist.

## 🚀 Features

- **User Authentication & Authorization**
  - JWT-based authentication
  - Email verification system
  - Password reset functionality
  - Admin role management

- **Product Management**
  - CRUD operations for products
  - Image upload support (single and gallery)
  - Category management
  - Featured products
  - Inventory tracking

- **Order Management**
  - Order creation with email notifications
  - Order status tracking
  - User order history
  - Total sales analytics

- **Payment Integrations**
  - Stripe payment gateway
  - Telebirr mobile money (Ethiopian payment system)
  - Mock mode support for testing

- **API Documentation**
  - Interactive Swagger UI
  - Comprehensive OpenAPI 3.0 specification

### Swagger coverage and validation

Open `/api-docs` for Swagger UI or `/api-docs/swagger.json` for the generated
OpenAPI document. The spec includes the recent provider OAuth and optional 2FA
flows, passenger/driver rides, store inventory, grouped delivery checkout,
international shipping, exchange rates, dashboards and notification aliases.
Authentication requests document token-free 2FA challenges separately from
completed access-token responses, plus database selection, PKCE, email delivery
failures, backup codes and fresh-factor management. Apple callbacks use a form
body, not JSON. Browser redirects require provider credentials and registered
callbacks; Swagger UI cannot substitute for the native app's PKCE/browser flow.

Definitions are maintained in router annotations, `swagger-extra.js` and the
focused `swagger-auth.js`, `swagger-commerce.js`, and `swagger-rides.js` modules,
merged by `swagger.js`. Request/response schemas and permissions describe the
actual handlers; no API behavior is changed by these documentation modules.
The scanner resolves annotations relative to the backend, not the shell's
working directory. Restart/redeploy the backend to publish documentation changes.

Run `node --test tests/swagger.test.js` to validate the OpenAPI document and
references, require response/path-parameter documentation, compare declared
literal endpoints across all mounted routers (including nested routers and
aliases), and guard authentication public/protected distinctions. Keep the
mount list in that test in sync when introducing a new router.

### Scheduled delivery and store order dashboards

#### USA products shipped to Ethiopia, payable in birr

An independent, **off-by-default** product-only flow lives in the USA database.
Customers select the USA catalog and **Pay birr & ship to Ethiopia**. Local USA
USD checkout and Ethiopia's USD checkout are unchanged; rides and quoted
services do not gain birr payments in the USA database. Native product prices,
pickup delivery fees and US accounting stay USD. The authoritative charge is:

`ETB payment = round((USD products + USD store-to-hub fees + USD international shipping) * birrPerUsd, 2)`

`GET/PUT /api/v1/exchange-rate/`, `/apply` and `/refresh` use the independent
`usa-etb-export-checkout` policy when the selected database is USA. Admin controls
its own enablement, manual Apply, provider and automatic-refresh toggle.
As for the Ethiopia policy, a rate is usable strictly **under 24 hours** after a
successful apply. Applying or fetching the same numeric rate records a new
timestamp/revision/history entry; changing settings does not renew it. Failures
never extend expiry. Provider response fields remain **birr per 1 USD** for both
directions; reuse the server provider registry described below or choose a
different provider for each policy. Automation runs in the existing scheduler
for USA as well as Ethiopia. New quotes/prepares require a current rate; prepared
payments retain their rate snapshot even after disablement or expiry.

Configure **Admin > US Shipping** in the USA region:

- The complete **US consolidation-hub address**, verified with Google Geocoding.
  Product pickups are assigned from US inventory near that hub. US drivers
  travel only from stores to the hub, never on an impossible driving route to
  Ethiopia. Ethiopian recipient addresses are also server-verified, and are
  saved separately from domestic hub destinations.
- USD shipping base, per-billable-kg rate and minimum, volumetric divisor
  (cm3/kg), maximum billable kg per recipient and maximum parcel dimension.
  For each recipient, actual weight and packaged volume include every purchased
  unit, across all pickup stores. Billable weight is the larger of total actual
  kg or total volumetric kg, rounded **up to 0.001 kg**. Shipping is
  `max(minimumUsd, baseUsd + billableKg * perKgUsd)`, rounded to USD cents.
  One international fee is charged per recipient, not per pickup. This tariff
  is Admin pricing, not a live carrier quote; Admin must account for handling
  and final delivery to the Ethiopian address.
- Explicit **export approval** per product (`exportToEthiopia`); default false.
  Admin must verify shipment/import legality and carrier coverage and measure
  package weight/dimensions. Unapproved, missing-size, overweight or oversize
  items block checkout. US inventory migration and enabled vehicle pricing
  are prerequisites. Changing rate, tariff, hub, export approval or package
  data invalidates an affected unprepared quote. Prepared orders use snapshots.

Bank accounts must be explicitly tagged **ETB in the USA database**. Only bank
transfer is allowed for this flow: no card, cash, Telebirr or other service
payments. Native USA bank lists still offer only USD accounts.

`POST stores/checkouts/quote` with `paymentCurrency:"etb"` creates an international
product quote, supporting existing per-item quantity/address allocations and
vehicle upgrades for US pickups. The group `international` snapshot includes
hub, tariff revision, per-recipient shipping/weight/status and the customs notice.
Child USD shipping cents and converted ETB cents are apportioned exactly so child
payment/refund totals sum to the parent. `totalPrice` remains USD; `paymentAmount`
is ETB, with `exchangeRate.direction:"usd-to-etb"`. Never relabel USD cost fields
or store sales as birr. International shipping is not store product revenue.

Preparation atomically reserves US stock. Before the 15-minute hold ends, the
customer submits sender/reference via the usual checkout `/confirm` endpoint.
This enters **`bank_review`**, not `placed`: stock stays reserved, including
after the hold/rate expires, but store acceptance/driver dispatch remain blocked.
Admin verifies the exact saved ETB total in the actual bank account with
`POST stores/checkouts/:id/bank-confirm`; only then are stores notified and
acceptance deadlines start. Review receipts promptly: submitted receipts are
**not automatically rejected/released**, to avoid releasing already-paid stock.
Owner cancellation is blocked during review. Admin may use
`POST stores/checkouts/:id/bank-reject` with `{noFundsReceived:true}` only after
verifying that no funds arrived; it retains the receipt and releases inventory.
If funds arrived, confirm payment and use the documented manual bank refund
workflow instead. Never ask a customer to pay again after a submitted receipt.

Admin manages each recipient shipment using
`POST stores/checkouts/:id/shipments/:shipmentId`, with `status`, `note`, and,
when exporting, `carrier` and `trackingNumber`. Stages are strictly sequential:
`awaiting_hub -> at_hub -> shipped -> arrived_ethiopia -> delivered`.
Payment must be verified and all noncancelled pickup orders for that recipient
must have reached the hub. Export requires carrier/tracking details; final
delivery requires a proof/recipient-confirmation note. Updates record an audit
history and propagate to child receipts and customer order tracking. Native
`deliveryStatus:"Delivered"` means **US hub delivery only** on these orders,
not final Ethiopia delivery. Admin performs actual carrier booking/export and
last-mile coordination outside the app; no carrier labels or automatic tracking
feed are generated.

The checkout explicitly discloses that shipping includes final address delivery
but **customs/import duties, charges and clearance are excluded** and are the
recipient's responsibility. Paid child cancellation/refund is available only
before driver assignment/hub handling under the existing cancellation rules.
Refunds use each child's locked ETB amount, including its allocated shipping;
remaining shipments are not repriced after partial cancellation. Later changes,
returns or failed international delivery require support/manual refund review.

Deploy both repositories with gates off; configure US inventory, hub, tariff,
eligible products, ETB bank account and current rate. Test actual MongoDB
transaction conflicts, bank verification/rejection, rerouting to the hub,
international carrier operations and final address coverage on staging before
enabling. Adding this code does not activate checkout, fetch live rates,
run inventory migrations or book shipments.

#### Ethiopia purchases payable in USD

This optional feature is **off by default**, independently of rides. Customers
select the Ethiopia catalog and explicitly choose ETB or USD in their cart.
Goods and quoted non-ride services are fulfilled **in Ethiopia** for the
recipient; this is not international shipping. Rides never use exchange rates.
Catalog prices, delivery charges, store sales and driver/company accounting
remain ETB. Conversion is `USD = ETB / birrPerUsd`, rounded to cents. Checkout
groups retain native totals plus `paymentAmount` and an `exchangeRate` snapshot;
child USD cents sum exactly to the group charge and are used for partial refunds.
Do not reinterpret `totalPrice` as USD in reports.

In Ethiopia, authenticated `GET /api/v1/exchange-rate/` returns current availability,
rate, applied/expiry times, revision and explanation. Admin-only endpoints:

- `PUT /exchange-rate/`: `{enabled, autoRefresh, provider}`. Toggles/provider
  changes invalidate outstanding quotes but never renew the applied timestamp.
- `POST /exchange-rate/apply`: `{birrPerUsd}`. Every successful Apply records
  a new timestamp/revision and audit entry, including an unchanged rate.
- `POST /exchange-rate/refresh`: fetch/apply the saved provider now, even when
  scheduled automation is off. Automatic successes also record unchanged rates.

A rate is valid strictly **less than 24 hours after its applied timestamp**.
New USD quotes/reservations fail at the exact 24-hour boundary (server clock).
Failures never extend expiry. The 30-second scheduler refreshes enabled,
automatic policies when expired, independently of inventory/ride enablement,
and throttles failed attempts to one per minute. A failed or slow refresh may
temporarily leave USD checkout inactive; ETB checkout remains available.
Manual updates/config changes win over an older in-flight fetch. The latest
30 successful applies include rate/source/time/provider timestamp/change flag;
latest failure/attempt information is visible to Admin. Keep server clocks
synchronized. Settings and reservations require MongoDB replica-set transactions.

Automatic providers are a **server-only registry**, not customer/Admin-entered
URLs. Set `EXCHANGE_RATE_PROVIDERS_JSON`, for example:

```json
{"daily":{"url":"https://your-approved-provider.example/latest","ratePath":"rates.ETB","asOfPath":"asOf","apiKeyEnv":"FX_PROVIDER_KEY","apiKeyHeader":"X-API-Key"}}
```

The selected response field must be **ETB for 1 USD**, not its reciprocal; use
an appropriate USD-base provider/endpoint. `asOfPath` must resolve to an ISO
timestamp or epoch milliseconds; set `timestampUnit:"seconds"` for epoch
seconds. The source timestamp must be present, not future-dated, and under
24 hours old. Same numeric values with a current source timestamp count as
successful refreshes; replaying stale provider data does not. Endpoints must
be trusted, approved HTTPS addresses, with no URL credentials or redirects.
Keys are read only from the named server environment variable. Only provider
identifiers—not endpoints/credentials—are returned to mobile. A missing or
invalid provider configuration fails explicitly; manual Apply is always available.

USD products require the per-store inventory migration, enabled vehicle delivery
configuration and product package sizes. Add `paymentCurrency:"usd"` to
`POST stores/checkouts/quote`; quote/prepare revalidate enabled/fresh policy and
revision, including unchanged-rate applies. Once prepared, rate expiry or
switching USD off does **not** prevent recovery/refunds at the saved amount.
USD cash is rejected. Bank accounts must be explicitly tagged `currency:"USD"`;
old untagged Ethiopia accounts remain ETB. Native rides/legacy bank lists do not
offer USD accounts in Ethiopia.

Ethiopia USD cards require an explicitly configured USD-capable merchant:
`STRIPE_SECRET_KEY_ETHIOPIA_USD` and matching
`STRIPE_PUBLISHABLE_KEY_ETHIOPIA_USD` (both live, as in the existing production
card policy). No generic or USA merchant fallback is permitted. The public key
is saved with the prepared checkout; native confirmation initializes that key
and then restores the app's usual key. Retain the same merchant credentials
while its payments/refunds are outstanding. Validate native card confirmation,
minimum Stripe amounts and merchant/currency availability in staging before
activation. No merchant onboarding or live payment verification is automatic.

For an Admin ETB-quoted Ethiopia service, owner-only
`POST stores/service-checkouts/:serviceId` creates a USD quote or returns the
already-started checkout. Existing checkout prepare/payment/confirm/cancel and
Admin bank-confirm endpoints serve both products and services. Service amounts
come only from the stored Admin quote, never a client total. Prepared service
quotes cannot be repriced, moved to another currency/country, unaccepted or
deleted; unpaid cancellation/expiry unlocks them. Submitted/paid service
payments are retained and require **support review and a manual refund process**
before cancellation; automatic service refunds are not provided. Admin verifies
the USD receipt in combined payments. Product partial refund workflows remain
automatic for cards / Admin-recorded for bank transfers.

Deploy both repositories with the gates off. Configure rates, USD accounts /
merchant and provider registry; verify real transaction concurrency, scheduler
failure/recovery, bank receipt handling and native payments on staging; then
enable through **Admin > FX Rate** in the Ethiopia region. No inventory migration, rate fetch, live
activation or deployment is performed by adding this code.

#### Shared catalog and store-specific inventory

Store inventory is held in `StoreInventory` (unique store/product pairs), with
price, physical `countInStock`, reserved units and `minStock`. Stores choose
existing approved catalog products; category writes require Admin. A listing
can be removed only with no reserved units, without deleting the shared product.
Profile logos are optional HTTPS image URLs. Branches share the main store's
owner and reference it through `parentStore`.

Deployment requires MongoDB replica-set transactions (for example Atlas).
Deploy both backend and mobile updates before enabling the feature. In each
database, complete or cancel legacy active orders, then an Admin calls
`POST /api/v1/stores/admin/inventory/migrate` with `defaultStoreId`, or uses the
mobile AdminStores migration control. The migration atomically moves catalog
stock to its linked approved store, or to the selected default if no valid link
exists, creates the unique inventory index, and enables `store-inventory-config`.
It refuses repeat migrations and invalid quantities/prices. Legacy checkout
continues until migration; do not seed copies of global stock into every store.
After migration, new catalog products have zero availability until a store
adds inventory. Editing a catalog's old `countInStock` is not a store adjustment.
Legacy store-owner product endpoints return HTTP 409 after migration so older
clients cannot silently mutate global inventory. Deploy updated owner clients
before enabling a region. Inventory-managed updates through the legacy store
order-status endpoint use the same reservation lifecycle as normal order updates.

New API surfaces:

- Public `GET stores/directory` and `GET stores/directory/:id/products`.
- Authenticated `POST stores/checkout-availability`, with quoted `orderItems`
  (`product`, `quantity`, `price`), verified `customerLocation` and optional
  `storefrontId`. It returns an eligible whole-cart pickup or HTTP 409.
- Store-owner `GET stores/me/locations`, `PUT stores/me/locations/:id`,
  `POST stores/me/locations/:id/branches`, and
  `GET stores/me/locations/:id/inventory` or
  `PUT/DELETE stores/me/locations/:id/inventory/:productId`.
- Store-owner `GET stores/me/assignments` and
  `POST stores/me/assignments/:id/accept` or `/reject`.

Legacy main-page purchases require exact quoted prices and a single store with enough
unreserved stock for every item. All eligible stores, including the configured
default, are ranked by customer delivery distance and must meet stock/price
requirements. Storefront purchases stay within the selected root/branch family.
Branches with different prices do not contribute to that storefront's quoted
availability. Main-catalog availability sums open, approved stores' unreserved
stock; the checkout quote still verifies that a single price-matching store can
fulfill the entire cart.

Order creation reserves the complete cart transactionally and stores purchase
prices and the assigned store's identity snapshot. Pending store assignments
have five minutes to accept; rejected orders reroute immediately, and the
existing 30-second scheduler reroutes expired assignments. Driver dispatch waits
for acceptance. When no eligible replacement exists, the order explicitly stays
unassigned and the scan retries; rejected/expired stores are not offered the same
order again. Rerouting preserves customer prices and the original delivery fee.
Cancellation/deletion releases held units; completed delivery consumes them once.
Stores cannot lower physical stock below reservations or remove reserved listings.
Removing a store with branches or reservations is blocked.

Tests: `node --test tests/store-inventory.test.js tests/order-dashboard.test.js tests/fulfillment-routing.test.js`.
The inventory tests exercise selection, transaction rollback contracts, stock
predicates, branch isolation, deadlines and ownership using model doubles.
Validate transactions with a replica-set staging database before production rollout.

#### Multi-store, multi-address and vehicle delivery checkout

This is opt-in per database. First migrate store inventory, then Admin configures
`vehicle-delivery-config` through `PUT stores/delivery-config` and optional packaged sizes
through `PUT stores/delivery-products/:productId`. The mobile Admin **Vehicles**
page exposes both controls. Vehicles are `motorcycle`, `car`, `van`, `truck`;
each has `enabled`, `baseFee`, `distanceRate`, `maxWeightKg`, `maxVolumeLiters`,
`lengthCm`, `widthCm`, `heightCm`. Rates are regional currency per mile for USA
and per kilometer otherwise. Product `packageSize` uses positive `weightKg`,
`lengthCm`, `widthCm`, `heightCm` for one packaged sale unit. No sizes or fees
are inferred for unconfigured products. Capacities must be conservative usable
limits: recommendations validate total weight/volume, cargo envelope volume and
rotated parcel dimensions, not general 3-D bin packing or special handling.
Domestic checkout does not require package measurements. Admin can save any
subset of positive measurements; blank or omitted fields clear those values.
Quote lines include their `packageSize` snapshot for customer display. Missing
weight or dimensions produce `null` cargo totals, not zero; known measurements
still constrain offered vehicles. Incomplete cargo includes
`measurementsAvailable: false`, `knownWeightKg`, and `knownVolumeLiters`.
These deliveries set `requiresVehicleSelection: true` and an empty `vehicle`:
the customer must manually select an offered vehicle before reservation.
The quoted delivery fee is the lowest offered fee until a selection is made;
capacity is not guaranteed for unmeasured items. Complete sizes retain automatic
recommendations. International US-to-Ethiopia shipping still requires complete
measurements for weight-based tariffs. Newly missing measurements at reservation
require a fresh quote and manual vehicle selection.

The server requires `GOOGLE_MAPS_API_KEY` with **Geocoding** and **Distance Matrix**
enabled and billing configured. It verifies destinations/country itself and
uses driving routes without straight-line pricing fallbacks. Each destination
must match the selected shopping region. Each store needs valid pickup coordinates.

Authenticated APIs (all paths below are relative to `/api/v1/stores/`):

- `GET delivery-config`; Admin-only `PUT delivery-config` and
  `PUT delivery-products/:productId` for capacities/rates and packaged sizes.
- `GET/POST delivery-addresses`, `PUT/DELETE delivery-addresses/:id` for private saved
  addresses; `GET delivery-current-address` prefills the latest order/profile.
  Addresses contain `label`, `address1`, `address2`, `city`, `zip`, `country`,
  `phone`. Deletion is owner-only and returns 404 for missing or other users'
  addresses. Order addresses are immutable snapshots, independent of saved edits
  or deletion.
  Postal code is optional for Ethiopia (`Ethiopia`, `Ethio`, `ET`, case-insensitive)
  in both address validation and persisted child orders; other countries still
  require it. This applies when reserving deliveries as well as requesting quotes.
- `POST checkouts/quote`: `cart` lines contain unique `key`, product ID,
  whole `quantity`, quoted `price`, optional `storefrontId`. `addresses` contain
  unique local `id` and address fields. `allocations` contain `key`, `addressId`,
  whole `quantity`; every cart unit must be allocated exactly once.
  Optional `deliveryMode` accepts `EXPRESS`, `STANDARD` or `SCHEDULED` and
  defaults to `STANDARD`. `SAME_DAY`/`NEXT_DAY` are rejected for new quotes (see
  "Delivery speeds" below). `scheduledFor` is required and must be a future
  date/time for `SCHEDULED`; it is rejected for other modes. The quote stores
  the delivery plan plus `deliveryWindowStart`/`deliveryWindowEnd` and a
  `deliverySnapshot` (`quotedAt`, window, `policy`, `speedSurcharge`).
  Vehicle fees remain based on the selected vehicle and route; each
  `vehicleOptions[]` entry is `{ type, fee, vehicleFee, speedSurcharge }` where
  `fee = vehicleFee + speedSurcharge` (surcharge defaults to 0). Reserving
  (`prepare`) persists the quoted window on every child order and fails with a
  conflict if the delivery policy or surcharge changed since the quote.
  Limits are 50 cart lines, 10 destinations, 100 allocations and 20 deliveries.
  This saves a ten-minute authoritative quote, without reserving stock.
  Stock allocation first selects the first eligible store in the existing
  store ranking that can fulfill the entire checkout. It must be eligible for
  every cart allocation at its quoted price and storefront scope, with enough
  unreserved stock for the combined quantity of each product across all lines
  and destinations. If no single eligible store can fulfill everything, stock
  is split using the existing nearest-first allocation and one shared budget
  across destinations. Constrained storefront lines are allocated before
  main-catalog lines so their limited supply cannot be consumed first.
  Products from the same pickup and destination share one delivery fee.
  Mixed main/storefront groups preserve the storefront branch constraint.
  New quotes also group stores for pricing when **every pair is within 500
  meters** (straight-line pickup distance) and they serve the same destination.
  Groups are formed deterministically, nearest road-distance pickup first;
  chains of nearby stores cannot join distant endpoints. Within a group, only
  deliveries using the **same selected vehicle type** share a fee. The fee
  (including the speed surcharge once) comes from that type's option at the
  store with the shortest quoted driving distance to the drop-off. Different
  vehicle types, distant stores and separate destination IDs are billed
  separately. Each option still shows its own store's unshared route price.
  `deliveries[].pricingGroup` snapshots the geographic group `key`,
  `radiusMeters`, and selected billing subgroup's `storeId`, `storeName`,
  `distanceKm`, `storeCount`, `vehicle`, `deliveryFee` (the full shared fee).
  Each delivery's `deliveryFee` is its equal share, rounded in cents with
  remainders assigned by delivery key. Child orders persist this snapshot as
  `deliveryPricingGroup`; their totals sum exactly to the parent and partial
  refunds use only that child's saved share, without repricing siblings.
  Fulfillment, stock, vehicle capacity and driver tracking remain per store,
  not a consolidated multi-stop driver route. International quotes apply this
  rule to the US hub leg per recipient; onward shipping fees are unchanged.
  Existing quotes/orders without pricing groups retain their original fees.
  Deploy the updated backend and mobile together: old mobile builds sum
  individual vehicle options and cannot preview the new shared total correctly.
- `POST checkouts/:id/prepare`: `method` is `card`, `bank` or `cash`;
  `selections` contain one `{ key, vehicle }` for each quoted delivery.
  `deliveryMode` and `scheduledFor` may be echoed from the quote; if supplied,
  they must match its saved delivery plan. Each reserved child order receives
  the quoted mode, schedule window, dispatch status and priority.
  Only server-offered suitable vehicles are accepted. Bank requires an active
  `bankAccountId` from `GET delivery-bank-accounts`. All child orders/items and
  stock reservations commit atomically. Stale price, stock, pickup coordinates
  or incompatible package/capacity changes roll back the entire checkout.
  Preparation is idempotent for the same checkout and payment method.
  Domestic USA cash reservation is accepted only with the explicit boolean
  `developmentCashOnDelivery: true` sent by a React Native `__DEV__` app,
  including when connected to the production Render API. Omitted, false or
  string flags are rejected. This is a client build/testing flag, not proof of
  development or a backend authorization boundary; do not rely on it to prevent
  custom clients from requesting cash. Debug checkouts create real reserved
  orders, not simulated payments. International ETB bank-only checkout and
  Ethiopia USD/service cash restrictions remain enforced even with the flag.
  Release apps hide cash and block submission; no server environment or live
  configuration change is performed automatically.
- `POST checkouts/:id/payment` creates/reuses a server-priced Stripe intent
  with a checkout-specific idempotency key, never a client-supplied amount.
  Stripe remains USA-only with the existing **live secret key** policy.
  `POST checkouts/:id/confirm` verifies Stripe status, amount received,
  currency, intent ID, checkout metadata and owner before store assignments
  become actionable. For bank payments, confirmation takes `{ sender, reference }`;
  funds stay pending until Admin verifies them. Cash confirmation activates
  Ethiopia and domestic USA development checkouts, is collected per child
  delivery, and reconciles when those deliveries finish.
- `GET checkouts` and `GET checkouts/:id` recover payments and list child
  statuses. Admin can list all with `GET checkouts?all=true`. Customer access is
  owner-scoped. Client secrets are returned only by the protected payment endpoint.
- `POST checkouts/:id/cancel` cancels an unpaid reservation. If Stripe already
  succeeded, it recovers the paid checkout instead. The 30-second scheduler
  similarly reconciles expired fifteen-minute holds. A provider outage never
  releases a potentially paid reservation. Holds without an exposed payment
  intent can be released safely; a racing intent write makes cancellation retry.
- `POST checkouts/:id/deliveries/:orderId/cancel` cancels only that delivery,
  before driver assignment. Stock releases transactionally and siblings remain
  active. Paid nonzero child totals are recorded for refund; no paid child order
  can be deleted through legacy endpoints.
- Admin `POST checkouts/:id/deliveries/:orderId/refund` reconciles/retries card
  refunds. The scheduler retries pending receipts, not failed refunds blindly.
  A failed refund requires `{ retryFailed: true }` and a new guarded attempt key.
  Lost receipts are recovered by Stripe metadata before creating any new refund;
  pending receipts are retrieved by ID until resolved.
- Admin `POST checkouts/:id/bank-confirm` records verified combined bank funds.
  Cancelled deliveries are marked for refund even if cancelled before verification.
  Admin returns bank funds manually and records `{ reference }` through
  `POST checkouts/:id/deliveries/:orderId/manual-refund`. Do not send funds again
  when a bank reservation expired: support must reconcile the original transfer.

Child orders retain the checkout ID, chosen vehicle, cargo, assigned-store
snapshot and their own destination/tracking lifecycle. Store acceptance starts
only after checkout activation and still has the five-minute response window.
Rerouting refreshes driving distance but preserves the original quoted fee and
product prices; `quotedDeliveryDistanceKm` retains the charged-route snapshot.
Vehicle-sized deliveries use an exact matching approved driver and occupy that
vehicle exclusively until completion; legacy batching remains unchanged for
other orders. Run one active dispatch process: the existing assignment queue is
process-local, so multiple independent dispatch workers require shared
serialization before enabling vehicle-capacity guarantees. Set driver vehicle
types to canonical names (supported existing
aliases include motorbike, sedan, SUV, minivan and pickup); unknown types do not
silently become motorcycles.

Validate with `node --test tests/multi-delivery.test.js tests/store-inventory.test.js tests/fulfillment-routing.test.js tests/order-dashboard.test.js`.
Tests use model/provider doubles, including atomic rollback, price/stock
constraints, quantity conservation, vehicle matching, amount verification,
recovery and partial refunds. **Replica-set transaction/concurrency validation,
real Google routes, and native Stripe payment/refund checks are still required
on staging before enabling production.** Deploy backend and mobile together;
this update does not run migration or change live settings automatically.

- Order creation and updates accept `scheduledFor` or `scheduledDeliveryDate`.
  Both represent the same ISO-8601 timestamp; conflicting values return HTTP 400.
  The database stores `scheduledFor`, and serialized orders expose both names.
- Driver queues, tracking, company-driver deliveries, and recent dashboard sales
  include the delivery mode, scheduled timestamp, and delivery window.
- Status updates that echo an unchanged schedule preserve dispatch information,
  including when the original scheduled time has passed.
- Checkout can identify its pickup store using `store`, `storeId`, or `pickupStoreId`.
  Supplied IDs are validated against the selected database before order creation.
- `GET /api/v1/stores/me/dashboard` returns the latest 20 store-scoped orders in
  `recentOrders`, including pending orders, delivery schedules, items, and totals.
  `activeOrders` includes all unfinished, non-cancelled store-scoped orders, without
  the recent-history limit or a one-year cutoff. Pending counts use this full list.
  Revenue metrics still count completed orders only; `recentCompletedOrders`
  retains the latest five completed-order summaries.
- Company-store order scope includes directly assigned orders and orders containing
  store-owned products or products with that store's `ready` fulfillment response.
  For product-linked orders, sales and units count only that store's items, not
  another store's items or delivery fees. Rejected responses do not qualify.
  Existing ready responses are supported without reassigning product ownership or
  migrating orders. Inventory remains scoped to store-owned products.
  Directly assigned company orders show and count all products, regardless of
  catalog ownership. The fulfillment product queue includes unanswered approved
  products from active assigned orders even when their catalog partner is nearby.
  Nearby company-owned products are not treated as partner coverage; ready/rejected
  products remain out of the action queue and assigned-order details retain all items.
- Existing `scheduledFor` records need no migration. Orders whose schedule or
  store association was never saved cannot be reconstructed from missing data.

### Passenger rides (regular and shared)

Ride service is a separate, initially disabled regional feature. Deploy the
matching mobile screens, configure **Admin > Rides**, and verify Google Geocoding
and Distance Matrix driving/traffic permissions before enabling requests. Admin
sets separate Economy/Comfort/Van base fares, rates per mile in USA / km in Ethiopia, minute rates, shared
discount, maximum pickup wait, maximum additional shared travel and search
radius. Configure each company car/van's usable passenger seats (excluding the
driver, 1-16). Existing drivers remain delivery-only until they opt into regular
and/or shared rides. Motorcycle/truck passenger rides are not supported.

All routes under `/api/v1/rides` require authentication and the normal regional
database header:

- `GET/PUT config`: authenticated policy read / Admin-only write. No default
  pricing is silently activated. Existing requests retain their tariff snapshot.
  Disabling requests does not strand existing riders or prevent payment.
- Per-option pricing uses `vehicleRates: { economy, comfort, van }`. Each entry
  has `enabled`; enabled entries require non-negative `baseFare`, `distanceRate`
  and `minuteRate` (at most two decimals, at least one nonzero). At least one
  option must be priced/enabled when requests are enabled. Shared discount and
  route limits remain common. Disabled entries may contain only `enabled: false`.
  No class rates are auto-derived from old global rates.
- `POST quote-options`: takes `mode` and ordered `stops`, verifies/geocodes once
  and computes one road baseline, then atomically persists and returns
  `{quotes: [...]}` for enabled Economy, Comfort and Van. Each quote has its own
  ID, `vehicleOption`, estimate and snapshotted class tariff, with a common ten-minute
  expiry. Customers explicitly select one quote and submit its ID to `:id/request`;
  the other alternatives remain unrequested. A quoted option disabled by Admin
  before submission cannot be requested. Prices do not imply driver availability.
- `POST quote`: `mode` is `regular` or `shared`; ordered `stops` contain `type`
  (`pickup`/`dropoff`), whole `passengers` and the same complete address fields
  used by delivery checkout. Server geocoding verifies country/pins. Regular
  rides allow 2-12 arranged stops with balanced passenger counts and one payer.
  A shared booking has one pickup/dropoff for its own party; separate unrelated
  bookings are pooled by the server. Quotes last ten minutes.
  With per-option pricing configured, `vehicleOption` (`economy`, `comfort`, `van`)
  is mandatory and its enabled rate is authoritative; client fares are ignored.
  The legacy global-rate path remains only for regions not yet migrated. Existing
  unclassified quotes/bookings retain their prior tariff and matching behavior.
- `POST places/current-location`: takes numeric `{latitude, longitude}` from
  device GPS, reverse geocodes with `GOOGLE_MAPS_API_KEY`, and rejects locations
  outside the selected region. Returns address fields, `currentLocation`, and
  the exact GPS point rather than moving pickup to a nearby street centroid.
  A pickup address in `POST quote` can include this `currentLocation` object;
  the server reverse geocodes it again instead of trusting client address/pin
  fields. Manual address edits must remove `currentLocation`. Other stops use
  the existing place-selection/manual-geocoding flow. Every stop's required
  `address.phone` is persisted with the quote and retained on request; this
  contact number does not update the user's account profile.
- `POST :id/request`: idempotently submits that owner's quote. Approved,
  unsuspended, online company drivers with enabled mode, adequate seats, fresh
  GPS (120 seconds), no delivery load and a suitable verified road route are
  ranked nearest-first within the configured radius. `GET /` and `GET :id`
  provide owner-scoped history/status; customers never receive other bookings'
  names, phones or stops. Driver GPS is returned only during the owner's active
  ride, not after drop-off; completed rides retain driver contact for payment.
- `GET :id` also returns `pickupEta` for assigned bookings. It uses server-side
  Google Routes (`GOOGLE_ROUTES_API_KEY`, Routes API enabled, billing required)
  with `TRAFFIC_AWARE` driving from driver GPS through every pending trip stop
  up to this booking's first remaining pickup, in the existing stop order.
  No other customer's addresses or identifiers are exposed in the ETA.
  Successful shape: `{status: "available", minutes, arrivalAt, computedAt,
  expiresAt, driverLocationUpdatedAt, stopsBeforePickup}` (dates are ISO strings).
  GPS must be less than 60 seconds old. Regional, bounded in-process caches
  coalesce concurrent requests and reuse estimates for at most 30 seconds,
  never past the source GPS freshness deadline; route/version changes invalidate
  the cache immediately. Each server process maintains its own cache.
  The route/assignment and GPS freshness are rechecked after the provider call.
  Failure shape is `{status: "unavailable", reason}`; unassigned/onboard/finished
  bookings return `pickupEta: null` without a paid routing request. Road routing
  failures do not hide the booking or fall back to straight-line distance,
  quote duration or a promised pickup deadline. Boarding delays are not included.
  Deploy the matching customer app to show the arrival countdown.
- Shared insertion preserves existing stop order and evaluates driving time,
  passenger capacity, every awaiting rider's pickup deadline and absolute
  drop-off promises. Additional insertions cannot repeatedly expand an existing
  rider's detour allowance. There are at most 12 pending stops per vehicle.
  Constraints are predictions from current road data, not a guarantee against
  traffic delays or time spent boarding. No straight-line routing substitute
  is used when Google routing fails.
- `GET me/driver` returns the authenticated company's separate ride offer,
  route and completed payments. `POST me/offers/:id/accept|reject` claims or
  immediately reroutes it. Offers expire after three minutes (earlier if the
  configured pickup window ends); expired offers are hidden and cannot be
  claimed. Claiming re-evaluates the current route and commits with optimistic
  trip-version checks. The independent 30-second scan retries waiting rides,
  expired offers and card-payment receipts, even with store inventory disabled.
  Active `riders` include the booking owner's `customerName` (name only, not the
  customer's full account) for the assigned driver's trip card.
- `POST me/start-trip` takes `{tripId}` and idempotently records `startedAt` on
  the authenticated company's active trip. A stale/different trip is rejected.
  This does not mark a pickup complete, change passenger counts or set a fare
  start time; normal next-stop boarding confirmation still controls those.
- `GET me/route`: authenticated company driver only, resolved from that driver's
  active trip (not a client-supplied booking ID). Returns a driving polyline from
  the driver's GPS through every unfinished vehicle stop in order, including
  pooled bookings. Uses `GOOGLE_ROUTES_API_KEY`; errors are explicit and stop pins
  and external navigation remain usable. Clients reload on trip version changes.
- `PUT me/vehicle` takes `{vehicleType}` (`motorcycle`, `car`, `van`, `truck`) and
  stores `pendingVehicleType`, not an approved vehicle change. Passenger dispatch
  and mode activation are blocked while a request is pending. Selecting the
  registered type cancels it. Vehicle requests/configuration are blocked during
  active passenger trips, offers or deliveries.
- `PUT admin/drivers/:id` verifies the selected `vehicleType`, clears its pending
  request, and saves `passengerSeats` (1-16 for car/van) and optional `carClass`
  (`economy`, `comfort`, or empty; cars only). Motorcycle/truck have no passenger
  seats and are reset to delivery-only modes. Changing vehicle type through older
  driver Admin forms clears the car class; use Ride settings to classify it again.
  `GET admin/drivers` and `GET me/driver` include pending type and car class.
  Class-selected bookings match the exact car class, or a van for `van`, with
  transactional rechecks at dispatch and acceptance. Unclassified cars do not
  receive class-selected bookings. Motorcycle/truck are not passenger options.
  Selected option and tariff persist through pooling, rerouting, completion and
  payment; Regular final fares use actual elapsed minutes, Shared solo route/time.
- `PUT me/modes`: explicit delivery/regular/shared booleans, at least one
  enabled. `POST me/shared-intake` with `{ open: false }` immediately removes and
  requeues accepted-but-not-picked-up shared bookings and any shared offer.
  Those accepted bookings receive a fresh replacement-pickup window. Only
  onboard riders' dropoffs remain. Disabling shared mode has the same effect;
  onboard rides always remain completable. Reopen intake explicitly after
  enabling shared mode if it was closed.
- `POST me/location` accepts authenticated numeric GPS coordinates, timestamped
  on the server. `POST me/next-stop` takes `stopKey: "<rideId>:<stopKey>"` and
  completes only the next stop after fresh GPS places the driver within 300m.
  Boarding/alighting updates onboard seats transactionally; the last stop
  completes that booking and releases the vehicle when no stops remain.
- `POST :id/cancel` is owner-only and allowed before first pickup, releasing
  route/offer locks with no fare due. An onboard/completed ride cannot be
  cancelled through this endpoint.

Payment is enabled **after completion**, independently for each booking. Regular
fares use the arranged itinerary's quoted road distance plus actual elapsed
minutes from first pickup through final dropoff; the caller pays once, including
their passengers. Shared fares use the booking's solo road distance/time,
refreshed at its own pickup, minus the agreed discount; other customers'
detours, waits and payments are never charged to this payer. Consequently the
quote is an estimate, not a guaranteed final fare.

`POST :id/payment-method` chooses card (USA native Stripe), bank transfer
(configured active account) or cash (outside USA). The selected method is stable
for recovery. `POST :id/payment` returns the existing/server-priced Stripe
attempt; intents lost before persistence are recovered by ride metadata before
creating another, including after provider idempotency retention. Confirmation
verifies intent, payer, region, amount received and currency. `POST
:id/payment-confirm` verifies card or saves bank `{ sender, reference }`, leaving
bank payment pending. `POST :id/received-payment` is Admin-only for bank funds
and assigned-driver/Admin-only for cash. Admin uses `GET admin/payments` and
`GET/PUT admin/drivers[/:id]` for payment verification and passenger seats.
Card payments retain the backend's existing live-secret-key requirement.

Delivery assignment now writes the driver dispatch version and order together
in a MongoDB transaction. **Deploy on a replica set / Atlas; standalone MongoDB
cannot run these dispatch transactions.** Ride/offered vehicles and
delivery-disabled drivers are excluded from delivery selection and claims.
Manual company-driver assignment/reopening cannot bypass dispatch. Changing
vehicle type or seat capacity during a passenger trip/offer, or deleting a
driver with an active offer/trip or unpaid completed ride, is blocked.

Keep the driver app in the foreground on its dashboard or Ride screen for GPS
and offer polling; there is no background-location service in this change.
External turn-by-turn navigation must return to the app for stop confirmation.
Shared pooling can issue multiple Google road-leg lookups; provision API quota
and billing. Run a single dispatch process as above. Test with
`node --test tests/rides.test.js tests/fulfillment-routing.test.js`.
Before production enablement, verify competing ride/delivery claims on a real
replica set, live traffic routing, GPS/native navigation and native Stripe/bank/
cash recovery on staging. No live settings or migrations run automatically.

### Automatic company fallback routing

Login and profile responses determine company-store ownership by looking for an
owner's company-owned store explicitly, rather than inspecting an arbitrary first
store. Owners who also have a partner store still receive the AdminStore role flag.
Company-store ownership is checked even if the user's cached `isStoreOwner` flag
is false. Login/profile responses restore that role and report the owned store's
approval status from the selected database. Driver-only accounts with no company
store ownership do not receive store access; stored user records are not rewritten.
Validate with `node --test tests/company-profile.test.js`.

Company-owned AdminDrivers do not require a prepaid wallet balance to receive
deliveries. Commission accounting remains unchanged, but low balances do not
warn or automatically suspend company drivers. Driver selection restores approved
company profiles previously auto-suspended specifically for low balance, without
changing wallet amounts or clearing manual/other suspensions. Availability,
capacity and rejection rules still apply. Partner-driver wallet rules are unchanged.
Validate with `node --test tests/driver-wallet.test.js tests/fulfillment-routing.test.js`.
The company-driver delivery-list response includes `driverEligibility` with
approval, availability, suspension and active-capacity status. This explains why
an approved driver may still receive no offers. Admins can enable an offline
company driver's availability through the company-driver update endpoint using
`isAvailable: true`; suspension, approval and capacity checks still apply.
Validate with `node --test tests/company-driver-availability.test.js`.

- Before company-store dashboard/product requests and each scheduled retry scan,
  unfinished orders with a null or missing pickup store are reconciled within the
  selected database. This includes legacy orders with assigned drivers, picked-up
  deliveries, future schedules, and missing dispatch metadata. Selection uses the
  same partner-first/company fallback. Conditional writes only set `store`;
  drivers, fees and schedules stay unchanged. Completed/cancelled orders and
  existing store assignments are not rewritten.
- Pickup assignment prefers an approved, open partner store within 10 km of the
  customer. A valid preferred partner in that radius is retained. Otherwise the
  nearest approved, open company store is assigned with no radius limit.
- Dispatch checks approved, available, non-suspended partner drivers within 5 km
  of pickup (including eligible batch drivers), then assigns the nearest eligible
  company driver at any distance as a claim/reject offer. Active-order capacity
  still applies to claiming. If none is currently eligible, an approved default
  company driver receives the offer even when offline, full or suspended.
  Saved offers are not reassigned just because eligibility/proximity changes.
  `PUT orders/:id/company-reroute` and `PUT orders/:id/company-reject` both
  exclude that driver and release the whole unclaimed request to other eligible
  drivers. With no alternative driver, the request stays queued for later.
- Company-store fallback uses the nearest eligible store when coordinates allow
  ranking. Otherwise it retains an eligible preferred company store, or chooses
  an available company store by stable ID order. Missing coordinates are never
  treated as zero distance. Fallback queue ownership uses stable IDs when
  driver proximity cannot be ranked; claiming still needs pickup coordinates.
- Company driver offers appear in `orders/company/my-deliveries`. Claiming is
  required before assignment; accepted deliveries persist even without a live
  socket and appear in `drivers/me/queue`. Store orders appear in
  `stores/me/dashboard`. Push notifications go to the assigned company accounts.
- Refreshing the company-driver delivery list also recovers pending/failed
  deliveries that have no company offer yet, using the same dispatch service
  within the selected database. Recovery preserves nearby-partner priority,
  approval and rejection rules; it creates an offer, never auto-claims the order.
  Availability, suspension, service/ride conflicts, capacity and exact vehicle
  requirements are enforced on claim, including the transactional driver lock.
  Future scheduled deliveries remain excluded until due.
- `stores/me/assignments` and the 30-second scheduler recover unassigned legacy
  and inventory-managed orders into a durable `fallbackStore` queue. The
  inventory-config default takes priority; otherwise use an approved company
  store by proximity/stable ID, including closed stores. Storefront orders never
  cross store families. No stock is held and no response deadline runs in this
  queue. `POST stores/me/assignments/:id/accept` validates ownership, approval,
  opening status and whole-order inventory/prices, then atomically reserves and
  accepts. `/reroute` retries another store; no alternative returns 409 without
  losing the request. `/reject` marks `adminReviewRequired:"store"`.
- Final store rejection sets `adminReviewRequired` and stops scheduler
  recovery, offers and claims. The order/payment remains intact for Admin to
  cancel/delete using existing safeguards. Grouped cancellations/refunds must
  use checkout endpoints. Driver rejection instead leaves requests available to
  others. Removing a historical final driver rejection through the existing
  admin response-deletion endpoint still clears driver review and permits routing.
  No live orders are migrated or production deployment performed automatically.
  Validate with `node --test tests/store-inventory.test.js tests/fulfillment-routing.test.js tests/company-offer-response.test.js`.
- Dashboard offer recovery uses the shared conditional offer write directly,
  without waiting behind the database-wide assignment queue or a partner's
  response timer. Push notification delivery runs after persistence without
  blocking the offer response. Actual claims retain serialized capacity checks.
  Test with `node --test tests/company-offer-response.test.js`.
  Company claims likewise return after assignment persistence and capacity updates,
  without waiting on driver/store push delivery. The database-wide assignment lock
  covers each capacity check and assignment write, but is released before push
  delivery or the 30-second partner response wait. A partner retry reacquires the
  lock before selecting and assigning another driver; unrelated company claims do
  not queue behind partner decisions. Partner acceptance behavior is unchanged.
  Test with `node --test tests/fulfillment-routing.test.js tests/company-offer-response.test.js`.
- A 30-second scan retries unassigned deliveries in each allowed database and
  dispatches scheduled/next-day orders only once their delivery window starts.
  Completed, cancelled, and already assigned deliveries are excluded.
- If no pickup store is eligible, checkout still saves the order with
  `assignmentPending: true` and an explicit waiting message. The scan assigns
  pickup when a store becomes available, including for future scheduled orders,
  without dispatching their drivers early. No eligible driver leaves the order
  pending for the next scan. Existing accepted/automatically assigned deliveries
  stay in their active queues; this policy change does not unassign them.
- Checkout accepts customer coordinates as GeoJSON or `{ latitude, longitude }`,
  persists GeoJSON on the order, and resolves pickup on the server rather than
  trusting an out-of-radius client selection. Product ownership is unchanged.

Run the focused regression tests without MongoDB or external services:

```bash
node --test tests/delivery-schedule.test.js tests/order-dashboard.test.js tests/fulfillment-routing.test.js
```

## 🛠️ Tech Stack

### Early ride termination

`POST /api/v1/rides/me/rides/:id/terminate` accepts `{reason}` (1-500
characters) from the assigned company driver for an assigned/onboard booking.
The driver must report GPS within the last two minutes; proximity to the planned
destination is not required. Termination records the reason, driver, timestamp
and GPS snapshot, removes that booking's unfinished stops and releases its occupied
seats atomically. Other shared bookings remain active. No destination drop-off
or completed booking is fabricated. The driver must confirm passengers have safely
exited before using this action.

Terminated bookings appear in driver history, customer history and
`GET /api/v1/rides/admin/payments` with `paymentStatus: "review_required"`.
Payment is blocked until Admin submits
`POST /api/v1/rides/admin/terminations/:id/review` with `{fare, note}`.
The fare must be a non-negative number with at most two decimals; a non-empty
note is required. Zero sets payment to `waived`; a positive fare enables the
existing regional payment methods. The booking remains `terminated` and the
review records the Admin and timestamp. Reviews cannot be overwritten through
this endpoint. Deploy the server update before the matching mobile UI.

### Delivery speeds

- `EXPRESS`: 1-2 business days; `STANDARD`: 2-5 business days (default);
  `SCHEDULED`: unchanged. Business days are Monday-Friday with no holiday
  calendar. Counting starts on the next business day after the order date
  (weekend orders count from Monday) in the business time zone. The window
  opens at `businessDayStartHour` (9) of the earliest day and closes at
  `businessDayEndHour` (18) of the latest day. Time zone defaults to
  `Africa/Addis_Ababa` (`America/New_York` for USA databases) unless an admin
  sets `businessTimeZone`; there was no earlier regional time-zone convention.
- New orders get `dispatchStatus: scheduled` (priority 80 Express, 55
  Standard), so dispatch only routes them once `deliveryWindowStart` is due.
- Historical `SAME_DAY`/`NEXT_DAY` orders keep their mode and timing (the
  Order model default stays `SAME_DAY` so old documents are not relabelled).
  New plans reject those values unless the order already has that mode.
  Quotes created before this release still prepare with their old timing.
- `GET/PUT /api/v1/settings/delivery` `deliveryConfig` adds
  `expressMinBusinessDays`=1, `expressMaxBusinessDays`=2,
  `standardMinBusinessDays`=2, `standardMaxBusinessDays`=5 (whole numbers 1-30,
  max >= min), `businessDayStartHour`=9, `businessDayEndHour`=18,
  `businessTimeZone`="" (region default; GET also returns
  `effectiveBusinessTimeZone`), and `expressSurcharge`, `standardSurcharge`,
  `scheduledSurcharge` (default 0). Invalid PUT values return 400. A PUT that
  omits these keys keeps the stored values.
- Legacy single-order checkout (`POST /orders`) prices EXPRESS with the
  existing `sameDayBase`/`sameDayPremium`/`sameDayPerKm` fields and STANDARD
  with `nextDayBase`/`nextDayPerKm`; initial fees are unchanged.
- Vehicle multi-delivery does not charge the per-distance speed fees (vehicle
  fees already cover distance); it only adds the flat per-delivery
  `expressSurcharge`/`standardSurcharge`/`scheduledSurcharge`.

- International US-to-Ethiopia quotes (`paymentCurrency:"etb"`) reuse the same
  group fields (`deliveryMode`, `deliveryWindowStart/End`, `deliverySnapshot`
  with the USA-region policy and surcharge, per-delivery `speedSurcharge`).
  The window and surcharge apply to the US store-to-hub leg only. `international`
  and each delivery's `quotedCargo` are unchanged; child orders created at
  prepare carry `internationalShipping.shipmentId` and the quoted window.
- Hour validation: `businessDayStartHour` is a whole hour 0-23 and
  `businessDayEndHour` a whole hour 1-24, with end after start; the check also
  uses stored values for fields omitted from a PUT.
- Deployment: deploy this backend first, then the upgraded mobile app. New
  orders and quotes reject `SAME_DAY`/`NEXT_DAY` (400/conflict), so older mobile
  builds that still send them cannot place new orders until updated. Existing
  orders and in-flight quotes are unaffected.

### Checkout driving-distance configuration

USA delivery fees use miles for `E_ShopUSA` (including `E_ShoppingUSA` alias).
Existing `sameDayPerKm`, `nextDayPerKm`, and `scheduledPerKm` field names remain
compatible, but their unchanged amounts are interpreted as per-mile rates in USA.
Same-day, next-day and scheduled fees divide road kilometers by 1.609344
before multiplying by the rate. Other databases remain per-kilometer. Stored
`deliveryDistanceKm` stays in kilometers and existing order fees are preserved.

`POST /api/v1/settings/delivery/estimate-distance` requires an authenticated
session and a backend `GOOGLE_MAPS_API_KEY` authorized for **Distance Matrix API**,
with billing enabled. This is a server key, not the Android Maps SDK key or the
mobile `EXPO_PUBLIC_GOOGLE_DIRECTIONS_API_KEY`. Restrict it to the required server
APIs and stable outbound server IPs when available. `GOOGLE_ROUTES_API_KEY`
configures the separate driver Routes API endpoint, not this checkout endpoint.

The endpoint uses valid pickup-store coordinates (latitude, longitude) as the
origin, otherwise the full store address or configured delivery hub. The distance
endpoint resolves eligible pickup stores on the server using `customerLocation`
and an optional preferred `storeId`, applying the same partner-first/AdminStore
fallback as order creation. A missing/stale mobile store cache does not require a
separate hub address when an eligible registered pickup store has an origin. Missing API
configuration returns 503, missing origin returns 422, and lookup failure returns
502 with a diagnostic message. It never returns success with a null distance.
When `customerLocation` is supplied, its validated coordinates are also the driving
destination, avoiding another Google lookup of address text such as Ethiopian
shipping addresses. Both `{ latitude, longitude }` and GeoJSON-style
`{ coordinates: [longitude, latitude] }` are supported. Invalid supplied coordinates
return 400; omitted coordinates retain the address-based lookup for older clients.
`ZERO_RESULTS` indicates no driving route between the locations, not a key or
billing failure. Check both map pins, road access and local routing coverage.
`NOT_FOUND` indicates Google could not resolve one of the locations. No estimated
or straight-line distance is substituted for either failure.
Deploy changes and set environment variables on the actual API hosting service;
editing a local environment file does not configure the deployed API.

Run `node --test tests/google-distance.test.js tests/delivery-distance.test.js`
for the focused checkout distance tests.

The driver route endpoint uses `GOOGLE_ROUTES_API_KEY` and **Routes API**.
Google rejection messages are returned with key values redacted so missing API
enablement, application restrictions or billing can be diagnosed. Its rate limiter
returns the remaining cooldown in `Retry-After`. Run
`node --test tests/driver-route.test.js` for route and throttling tests.

- **Runtime**: Node.js
- **Framework**: Express.js v4.21.2
- **Database**: MongoDB with Mongoose ORM v8.10.0
- **Authentication**: JWT (express-jwt v8.5.1)
- **File Upload**: Multer v1.4.5
- **Payment Processing**: Stripe v19.1.0, Telebirr v1.2.0
- **Email Service**: Nodemailer v7.0.7
- **API Documentation**: Swagger UI Express + Swagger JSDoc
- **Security**: bcryptjs, CORS

## 📋 Prerequisites

- Node.js (v14 or higher)
- MongoDB Atlas account or local MongoDB instance
- Stripe account (for payment processing)
- Email service credentials (Gmail, SendGrid, etc.)

## 🔧 Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/Gmen2025/easy-shop-server.git
   cd easy-shop-server
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   
   Create a `.env` file in the root directory (use `.env.example` as template):
   ```env
   # Database
   CONNECTION_STRING=mongodb+srv://username:password@cluster.mongodb.net/E_Shopping?retryWrites=true&w=majority
  DEFAULT_DB_NAME=E_Shopping
  ALLOWED_DB_NAMES=E_Shopping,E_Shopping_2
   
   # API Configuration
   API_URL=/api/v1
   secret=your-jwt-secret-key
   
   # Email Configuration (Option 1: Use service name)
   EMAIL_SERVICE=gmail
   EMAIL_User=your-email@gmail.com
   EMAIL_Pass=your-app-password
   
   # Email Configuration (Option 2: Custom SMTP)
   # SMTP_HOST=smtp.example.com
   # SMTP_PORT=587
   # SMTP_SECURE=false
   # EMAIL_User=your-email@example.com
   # EMAIL_Pass=your-password
   
   # Payment Gateways
   STRIPE_KEY=sk_test_your_stripe_secret_key
  # Optional per-database Stripe keys (recommended for multi-database setups)
  # For E_ShopUSA selected via x-database-name
  STRIPE_KEY_E_SHOPUSA=sk_test_your_usa_stripe_secret_key
  # Optional short alias fallback used by backend
  STRIPE_KEY_USA=sk_test_your_usa_stripe_secret_key
   
   TELEBIRR_BASE_URL=https://api.telebirr.com
   USE_MOCK_TELEBIRR=true
   TELEBIRR_PRIVATE_KEY=your-telebirr-private-key
   
   # Environment
   NODE_ENV=development
   PORT=3001
   ```

## 🗄️ Multi-Database Selection

- Default database is `E_Shopping`.
- Frontend can choose a database from a dropdown and send it with each API request.
- Supported request sources (priority order):
  - Header: `x-database-name`
  - Query: `?db=...`
  - Body: `databaseName`
- If the provided database is invalid or not allowed, the backend falls back to `E_Shopping`.

Example request header:

```http
x-database-name: E_Shopping_2
```

4. **Start the server**
   
   Development mode (with auto-reload):
   ```bash
   npm run dev
   ```
   
   Production mode:
   ```bash
   npm start
   ```

## 📚 API Documentation

Once the server is running, access the interactive API documentation:

- **Local**: http://localhost:3001/api-docs
- **Production**: https://easy-shop-server-wldr.onrender.com/api-docs

## 🔐 Authentication

Most endpoints require JWT authentication. To authenticate:

1. **Register a new user**: `POST /api/v1/users/register`
2. **Verify email**: Click the link sent to your email
3. **Login**: `POST /api/v1/users/login` - Returns a JWT token
4. **Use the token**: Include in Authorization header: `Bearer <your-token>`

## 📡 API Endpoints

### Products
- `GET /api/v1/products` - Get all products
- `GET /api/v1/products/:id` - Get product by ID
- `POST /api/v1/products` - Create product (Auth required)
- `PUT /api/v1/products/:id` - Update product (Auth required)
- `DELETE /api/v1/products/:id` - Delete product (Auth required)
- `GET /api/v1/products/get/featured/:count` - Get featured products
- `GET /api/v1/products/get/count` - Get product count

#### Frontend payload format (Cloudinary image)

If your app uploads directly to Cloudinary, send the returned `secure_url` in `image`.

Create product (JSON):
```json
{
  "name": "iPhone 16",
  "description": "Latest model",
  "richDescription": "Detailed description",
  "image": "https://res.cloudinary.com/<cloud>/image/upload/...",
  "brand": "Apple",
  "price": 1200,
  "category": "<CATEGORY_ID>",
  "countInStock": 10,
  "isFeatured": true
}
```

Update product image (JSON):
```json
{
  "category": "<CATEGORY_ID>",
  "image": "https://res.cloudinary.com/<cloud>/image/upload/..."
}
```

Postman collection example:
- `docs/postman_products_cloudinary.json`

### Categories
- `GET /api/v1/categories` - Get all categories
- `GET /api/v1/categories/:id` - Get category by ID
- `POST /api/v1/categories` - Create category (Auth required)
- `PUT /api/v1/categories/:id` - Update category (Auth required)
- `DELETE /api/v1/categories/:id` - Delete category (Auth required)

### Orders
- `GET /api/v1/orders` - Get all orders (Auth required)
- `GET /api/v1/orders/:id` - Get order by ID (Auth required)
- `POST /api/v1/orders` - Create order (Auth required)
- `PUT /api/v1/orders/:id` - Update order status (Auth required)
- `DELETE /api/v1/orders/:id` - Delete order (Auth required)
- `GET /api/v1/orders/get/totalsales` - Get total sales (Auth required)
- `GET /api/v1/orders/get/count` - Get order count (Auth required)
- `GET /api/v1/orders/get/userorders/:userid` - Get user orders (Auth required)

### Users
- `POST /api/v1/users/register` - Register new user
- `POST /api/v1/users/login` - Login user
- `GET /api/v1/users` - Get all users (Auth required)
- `GET /api/v1/users/:id` - Get user by ID (Auth required)
- `GET /api/v1/users/verify-email` - Verify email with token
- `POST /api/v1/users/forgot-password` - Request password reset
- `POST /api/v1/users/reset-password` - Reset password with token
- `POST /api/v1/users/resend-verification` - Resend verification email
- `GET /api/v1/users/get/count` - Get user count (Auth required)

### Payments
- `POST /api/v1/stripe/create-payment-intent` - Create Stripe payment
- `POST /api/v1/telebirr/initiate-payment` - Initiate Telebirr payment
- `POST /api/v1/telebirr/verify-payment` - Verify payment status
- `GET /api/v1/telebirr/payment-status/:transactionId` - Get payment status
- `POST /api/v1/telebirr/webhook` - Telebirr webhook endpoint

## 🌐 Deployment

The API is deployed on Render.com:
- **Production URL**: https://easy-shop-server-wldr.onrender.com

### Deploy to Render

1. Push your code to GitHub
2. Connect your repository to Render
3. Set environment variables in Render dashboard (including Cloudinary server vars)
4. Deploy using the `render.yaml` configuration

Required Cloudinary env vars on backend (Render Environment tab):
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

Do not expose these in Expo/mobile env files.

## 📁 Project Structure

```
backend/
├── config/              # Configuration files
│   └── config.js        # Telebirr configuration
├── helpers/             # Helper utilities
│   ├── jwt.js           # JWT authentication middleware
│   └── error-handler.js # Centralized error handling
├── models/              # Mongoose schemas
│   ├── product.js
│   ├── category.js
│   ├── order.js
│   ├── order-item.js
│   └── user.js
├── routers/             # Express route handlers
│   ├── products.js
│   ├── categories.js
│   ├── orders.js
│   ├── users.js
│   ├── stripe.js
│   └── telebirr.js
├── service/             # Business logic services
│   ├── applyFabricToken.js
│   ├── createOrder.js
│   └── mockTelebirrService.js
├── utils/               # Utility functions
├── public/uploads/      # Uploaded images (local only)
├── app.js               # Express application setup
├── swagger.js           # Swagger configuration
├── package.json
└── .env.example         # Environment variables template
```

## 🔒 Security Features

- JWT token-based authentication
- Password hashing with bcryptjs
- CORS configuration with Safari support
- Email verification requirement
- Protected admin routes
- Secure payment gateway integrations

## 🧪 Testing

For testing Telebirr payments without real API calls, set:
```env
USE_MOCK_TELEBIRR=true
```

## 📧 Email Configuration

The API supports multiple email service providers:

**Using Gmail:**
```env
EMAIL_SERVICE=gmail
EMAIL_User=your-email@gmail.com
EMAIL_Pass=your-app-specific-password
```

**Using SendGrid, Mailgun, etc.:**
```env
EMAIL_SERVICE=sendgrid
EMAIL_User=apikey
EMAIL_Pass=your-api-key
```

**Using Custom SMTP:**
```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
EMAIL_User=your-email
EMAIL_Pass=your-password
```

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the ISC License.

## 👨‍💻 Author

**Girma Halie**
- Email: girma.m.halie19@gmail.com
- GitHub: [@Gmen2025](https://github.com/Gmen2025)

## 🙏 Acknowledgments

- Express.js team for the excellent framework
- MongoDB team for the powerful database
- Stripe and Telebirr for payment processing capabilities
- All contributors and users of this API

## 📞 Support

For support, email girma.m.halie19@gmail.com or open an issue on GitHub.

---

⭐ If you find this project helpful, please consider giving it a star on GitHub!
# Driver driving routes

`POST /api/v1/drivers/me/orders/:id/route` accepts
`{ "origin": { "latitude": 9, "longitude": 38 } }` with the driver's bearer token
and database header. Only approved, non-suspended drivers with that active
assigned order can request routes. The destination comes from the pickup store
before pickup and customer coordinates after pickup; missing coordinates return
422 rather than routing to a placeholder.

Configure `GOOGLE_ROUTES_API_KEY` in Render's server environment. Use a separate
server key restricted to **Routes API**, enable that API and billing, and restrict
to the service's outbound IP addresses where available. Never put this key in the
mobile app. Deploy the backend before using the updated driver screen.

Results contain `coordinates` (latitude/longitude objects), `distance` in km and
`duration` in minutes. Requests have a 15-second upstream timeout and a per-driver,
per-database 10-second process-local throttle (not a distributed quota). The app
refreshes once per minute. Configure Google quotas/budget alerts for additional
cost control, especially when running multiple server instances.

Validate with `node --test tests/driver-route.test.js`.
# Authentication

See [social sign-in and optional two-factor authentication](docs/authentication.md)
for API contracts, provider console setup, deployment secrets, required MongoDB
indexes, recovery behavior, and focused tests.
