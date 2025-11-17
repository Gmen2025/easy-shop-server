# E-Shop Backend - AI Coding Guide

## Architecture Overview
This is a **Node.js/Express REST API** for an e-commerce platform with MongoDB/Mongoose ORM. The app follows a modular router-based architecture with centralized middleware and service layers.

**Key Components:**
- **Routers** (`routers/`): Route handlers for products, categories, orders, users, payment gateways (Stripe, Telebirr)
- **Models** (`models/`): Mongoose schemas with virtual ID fields (e.g., `order.js`, `product.js`, `user.js`)
- **Services** (`service/`): Business logic for payment integrations (Telebirr order creation, token management)
- **Helpers** (`helpers/`): JWT authentication middleware (`jwt.js`), centralized error handler (`error-handler.js`)
- **Config** (`config/`): Telebirr API configuration with private key loading from filesystem

## Critical Patterns

### Authentication & Authorization
- JWT middleware in `helpers/jwt.js` uses `express-jwt` v8 with **`expressjwt`** (not `jwt`) import
- Public routes defined in `.unless()` block: `/login`, `/register`, `/verify-email`, GET `/products`, GET `/categories`, Telebirr endpoints
- Protected routes require valid JWT token in Authorization header
- User model has `isEmailVerified` flag - login blocked until verified (`routers/users.js`)

### CORS Configuration
- **Safari-specific setup** in `app.js` with dynamic origin checking
- Allows local network IPs matching `192.168.x.x` pattern via regex
- Credentials enabled for all CORS requests
- Pre-flight OPTIONS requests handled globally with `app.options('*', cors(corsConfig))`

### Database Patterns
- MongoDB via Mongoose with database name `E_Shopping`
- Virtual `id` field on schemas for frontend compatibility: `orderSchema.virtual('id').get(function () { return this._id.toHexString(); })`
- Populate chains for nested data: `Order.findById(id).populate('user').populate({ path: 'orderItems', populate: { path: 'product', populate: 'category' }})`
- OrderItems stored separately and linked via array of ObjectIds in Order model

### Order Creation Workflow
1. Create OrderItem documents in parallel with `Promise.all()`
2. Calculate `totalPrice` by fetching product prices and multiplying by quantities
3. Save Order with resolved OrderItem IDs
4. Populate user data and send confirmation email via nodemailer (Gmail SMTP)
5. Email failures don't block order creation - returns 201 with error message

### File Upload Pattern
- Multer middleware in `routers/products.js` with `FILE_TYPE_MAP` for image validation
- Upload destination: `public/uploads/` (served statically at `/public/uploads`)
- Filename format: `${originalname}-${Date.now()}.${extension}`
- Base path construction: `${req.protocol}://${req.get('host')}/public/uploads/`
- Usage: `router.post('/', uploadOptions.single('image'), async (req, res) => {...})`

### Payment Gateway Integration

#### Telebirr (Ethiopian Mobile Money)
- **Mock mode**: Set `USE_MOCK_TELEBIRR=true` in `.env` to bypass real API calls during development
- Service flow: `applyFabricToken()` → `createOrder()` → construct checkout URL with `prepay_id`
- Config in `config/config.js` loads private key from filesystem: `fs.readFileSync(path.join(__dirname, 'telebirr_private_key.pem'), 'utf8')`
- Phone validation: Must start with `251` and be exactly 12 digits
- Webhook endpoint: `/api/v1/telebirr/webhook` (configured in `notifyUrl`)

#### Stripe
- Separate router at `routers/stripe.js` for standard Stripe checkout

### Environment Variables
Required in `.env`:
```
CONNECTION_STRING=mongodb://...
API_URL=/api/v1
secret=<jwt_secret>

# Email Configuration (Option 1: Use service name)
EMAIL_SERVICE=gmail  # 'gmail', 'sendgrid', 'outlook', 'mailgun', etc.
EMAIL_User=<email_address>
EMAIL_Pass=<email_password_or_api_key>

# Email Configuration (Option 2: Use custom SMTP)
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_SECURE=false
# EMAIL_User=<email_address>
# EMAIL_Pass=<email_password>

TELEBIRR_BASE_URL=...
USE_MOCK_TELEBIRR=true  # Enable for development/testing
TELEBIRR_PRIVATE_KEY=...
```

## Development Workflow

### Running the Server
```powershell
npm start  # Uses nodemon for auto-reload
```
Server binds to `0.0.0.0:3001` and logs all local network IPs for mobile testing.

### Error Handling
- Centralized middleware in `helpers/error-handler.js` catches:
  - `UnauthorizedError` → 401 (JWT failures)
  - `ValidationError` → 401 (Mongoose validation)
  - Default → 500
- Error handler **must** be registered after `authJwt()` in middleware chain

### Testing Payments
- Use `USE_MOCK_TELEBIRR=true` to simulate Telebirr responses without real API calls
- Mock service returns fake transaction IDs and payment URLs for frontend testing
- Check console logs for payment flow debugging (extensive logging in `routers/telebirr.js`)

## Project Conventions

### Mongoose Model Exports
Use named exports: `exports.Order = mongoose.model('Order', orderSchema);`  
Import: `const { Order } = require('../models/order');`

### Router Structure
Express Router pattern:
```javascript
const router = require('express').Router();
// Define routes...
module.exports = router;
```

### API Versioning
All routes prefixed with `process.env.API_URL` (typically `/api/v1`)

### Email Configuration
- Nodemailer transporter supports both service-based (`EMAIL_SERVICE=gmail`) and custom SMTP configuration
- Falls back to Gmail SMTP (`smtp.gmail.com:587`) if no service specified
- Used in `routers/orders.js` (order confirmations) and `routers/users.js` (email verification, password reset)
- Plain text email templates with manual string formatting (no templating engine)

## Known Issues & Quirks
- Twilio SMS integration exists but is commented out in order creation
- User registration endpoint has two implementations (one commented out) in `users.js`
- Procfile exists for Heroku deployment but production server config is commented out
