# E-Shop Backend API

A comprehensive REST API for an e-commerce platform built with Node.js, Express, and MongoDB. Features include JWT authentication, payment gateway integrations (Stripe & Telebirr), order management, and email notifications.

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

### Scheduled delivery and store order dashboards

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
  still applies; rejecting excludes that driver and passes the offer to the next
  eligible company driver on the next scan.
- Company-store fallback uses the nearest eligible store when coordinates allow
  ranking. Otherwise it retains an eligible preferred company store, or chooses
  an available company store by stable ID order. Missing coordinates are never
  treated as zero distance. Company drivers still require a rankable location
  when multiple eligible drivers are available.
- Company driver offers appear in `orders/company/my-deliveries`. Claiming is
  required before assignment; accepted deliveries persist even without a live
  socket and appear in `drivers/me/queue`. Store orders appear in
  `stores/me/dashboard`. Push notifications go to the assigned company accounts.
- Refreshing the company-driver delivery list also recovers pending/failed
  deliveries that have no company offer yet, using the same dispatch service
  within the selected database. Recovery preserves nearby-partner priority,
  approval, availability, suspension, capacity and rejection rules; it creates
  an offer, never auto-claims the order. The sole eligible company driver does
  not need GPS to rank against other drivers, but the order still needs valid
  pickup/customer coordinates. Future scheduled orders remain excluded until due.
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
