const swaggerJsDoc = require('swagger-jsdoc');
const extraSwaggerPaths = require('./swagger-extra');
const authSwagger = require('./swagger-auth');
const commerceSwagger = require('./swagger-commerce');
const ridesSwagger = require('./swagger-rides');
const path = require('node:path');

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'E-Shop API',
      version: '1.0.0',
      description: 'E-commerce REST API with JWT authentication, payment gateways (Stripe, Telebirr), and order management',
      contact: {
        name: 'API Support',
        email: 'girma.m.halie19@gmail.com'
      }
    },
    servers: [
      {
        url: process.env.NODE_ENV === 'production' 
          ? 'https://easy-shop-server-wldr.onrender.com'
          : 'http://localhost:3001',
        description: process.env.NODE_ENV === 'production' ? 'Production server' : 'Development server'
      }
    ],
    paths: JSON.parse(JSON.stringify(extraSwaggerPaths)),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter JWT token obtained from /api/v1/users/login'
        }
      },
      schemas: {
        DashboardPeriods: {
          type: 'object',
          description: 'Trailing periods. Metrics vary by platform/store/driver dashboard; monetary amounts use the selected region.',
          properties: Object.fromEntries(['daily', 'weekly', 'monthly', 'quarterly', 'yearly'].map((period) => [period, {
            type: 'object', properties: {
              start: { type: 'string', format: 'date-time' }, end: { type: 'string', format: 'date-time' },
              totalSales: { type: 'number' }, productSales: { type: 'number' }, deliveryIncome: { type: 'number' },
              sales: { type: 'number' }, earnings: { type: 'number' }, income: { type: 'number' },
              orders: { type: 'integer' }, completedOrders: { type: 'integer' }, deliveries: { type: 'integer' },
              cancelledOrders: { type: 'integer' }, paidOrders: { type: 'integer' }, pendingPaymentOrders: { type: 'integer' },
              unitsSold: { type: 'integer' }, deliveryDistanceKm: { type: 'number' }, distanceKm: { type: 'number' },
              averageOrder: { type: 'number' }, averageDeliveryFee: { type: 'number' }, averageFee: { type: 'number' },
              reviews: { type: 'integer' }, averageRating: { type: 'number' },
              paymentMethods: { type: 'object', additionalProperties: { type: 'number' } },
            },
          }])),
        },
        GeoPoint: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['Point'],
              default: 'Point'
            },
            coordinates: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: { type: 'number' },
              description: '[longitude, latitude]'
            }
          }
        },
        Product: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            richDescription: { type: 'string' },
            image: { type: 'string' },
            images: { 
              type: 'array',
              items: { type: 'string' }
            },
            brand: { type: 'string' },
            price: { type: 'number' },
            category: { 
              oneOf: [
                { type: 'string' },
                { $ref: '#/components/schemas/Category' }
              ]
            },
            store: {
              oneOf: [
                { type: 'string' },
                { $ref: '#/components/schemas/Store' }
              ]
            },
            countInStock: { type: 'number', minimum: 0, maximum: 255 },
            rating: { type: 'number', default: 0 },
            numReviews: { type: 'number', default: 0 },
            isFeatured: { type: 'boolean', default: false },
            dateCreated: { type: 'string', format: 'date-time' }
          }
        },
        Store: {
          type: 'object',
          required: ['name', 'address'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            address: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string' },
            bankAccount: { type: 'string', description: 'Bank / Payout account for weekly settlements or early requests' },
            approvalStatus: {
              type: 'string',
              enum: ['pending', 'approved', 'denied'],
              default: 'pending'
            },
            location: {
              $ref: '#/components/schemas/GeoPoint'
            }
          }
        },
        Payout: {
          type: 'object',
          required: ['store', 'amount'],
          properties: {
            id: { type: 'string' },
            store: {
              oneOf: [
                { type: 'string' },
                { $ref: '#/components/schemas/Store' }
              ]
            },
            amount: { type: 'number', minimum: 0, description: 'Payout amount in regional currency' },
            currency: { type: 'string', enum: ['ETB', 'USD'], default: 'ETB' },
            payoutType: {
              type: 'string',
              enum: ['weekly', 'early_request'],
              default: 'early_request',
              description: 'Weekly scheduled settlement or on-demand early request'
            },
            status: {
              type: 'string',
              enum: ['pending', 'processing', 'paid', 'rejected'],
              default: 'pending'
            },
            method: { type: 'string', example: 'telebirr_or_cbe', description: 'Payout payment method' },
            accountDetails: { type: 'string', description: 'Account number, Telebirr phone, or wire details' },
            reference: { type: 'string', example: 'REQ-1694688000000', description: 'Transaction reference code' },
            adminNotes: { type: 'string', description: 'Optional admin confirmation or reason notes' },
            dateRequested: { type: 'string', format: 'date-time' },
            dateProcessed: { type: 'string', format: 'date-time', nullable: true }
          }
        },
        EarlyPayoutRequest: {
          type: 'object',
          required: ['amount'],
          properties: {
            amount: { type: 'number', minimum: 0.01, example: 500.0, description: 'Amount to withdraw before weekly settlement' },
            method: { type: 'string', example: 'bank', description: 'Payment channel: bank, telebirr, or stripe_or_wire' },
            accountDetails: { type: 'string', example: 'CBE 1000123456789', description: 'Custom or override payout account number' }
          }
        },
        StoreEarningsResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            currency: { type: 'string', example: 'ETB' },
            payoutSchedule: { type: 'string', example: 'Weekly settlement every Monday. Early payout available on-demand.' },
            available: { type: 'number', example: 1250.50, description: 'Balance available for early withdrawal' },
            pending: { type: 'number', example: 400.00, description: 'Amount currently in pending/processing payouts' },
            totalEarned: { type: 'number', example: 5400.00, description: 'Lifetime net earnings (95% after 5% platform fee)' },
            bankAccount: { type: 'string', example: 'CBE 1000123456789' },
            phone: { type: 'string', example: '+251911223344' },
            transactions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  date: { type: 'string', format: 'date-time' },
                  order: { type: 'string', example: '#ab1234' },
                  amount: { type: 'number', description: 'Gross order amount' },
                  commission: { type: 'number', description: '5% platform fee' },
                  net: { type: 'number', description: '95% store revenue' }
                }
              }
            },
            payouts: {
              type: 'array',
              items: { $ref: '#/components/schemas/Payout' }
            }
          }
        },
        Driver: {
          type: 'object',
          required: ['name'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            isAvailable: { type: 'boolean', default: true },
            vehicleType: { type: 'string' },
            location: {
              $ref: '#/components/schemas/GeoPoint'
            }
          }
        },
        Category: {
          type: 'object',
          required: ['name'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            color: { type: 'string' },
            icon: { type: 'string' },
            image: { type: 'string' }
          }
        },
        Order: {
          type: 'object',
          required: ['orderItems', 'shippingAddress1', 'city', 'zip', 'country', 'phone'],
          properties: {
            id: { type: 'string' },
            orderItems: {
              type: 'array',
              items: { $ref: '#/components/schemas/OrderItem' }
            },
            shippingAddress1: { type: 'string' },
            shippingAddress2: { type: 'string' },
            city: { type: 'string' },
            zip: { type: 'string' },
            country: { type: 'string' },
            phone: { type: 'string' },
            status: { 
              type: 'string',
              enum: ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'],
              default: 'Pending'
            },
            totalPrice: { type: 'number' },
            user: {
              oneOf: [
                { type: 'string' },
                { $ref: '#/components/schemas/User' }
              ]
            },
            customer: {
              oneOf: [
                { type: 'string' },
                { $ref: '#/components/schemas/User' }
              ]
            },
            store: {
              oneOf: [
                { type: 'string' },
                { $ref: '#/components/schemas/Store' }
              ]
            },
            driver: {
              oneOf: [
                { type: 'string' },
                { $ref: '#/components/schemas/Driver' }
              ]
            },
            deliveryStatus: {
              type: 'string',
              enum: ['Pending', 'Driver Assigned', 'Picked Up', 'Delivered'],
              default: 'Pending'
            },
            dateOrdered: { type: 'string', format: 'date-time' }
          }
        },
        OrderItem: {
          type: 'object',
          required: ['quantity', 'product'],
          properties: {
            id: { type: 'string' },
            quantity: { type: 'number' },
            product: {
              oneOf: [
                { type: 'string' },
                { $ref: '#/components/schemas/Product' }
              ]
            }
          }
        },
        User: {
          type: 'object',
          required: ['name', 'email', 'password', 'phone'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string' },
            isAdmin: { type: 'boolean', default: false },
            street: { type: 'string' },
            apartment: { type: 'string' },
            zip: { type: 'string' },
            city: { type: 'string' },
            country: { type: 'string' },
            isEmailVerified: { type: 'boolean', default: false }
          }
        },
        LoginRequest: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', example: 'user@example.com' },
            password: { type: 'string', example: 'password123' }
          }
        },
        LoginResponse: {
          type: 'object',
          required: ['_id', 'token'],
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string' },
            isAdmin: { type: 'boolean' },
            isDriver: { type: 'boolean' },
            isStoreOwner: { type: 'boolean' },
            role: { type: 'string' },
            driverId: { type: 'string' },
            storeId: { type: 'string' },
            isCompanyOwned: { type: 'boolean' },
            isCompanyOwnedDriver: { type: 'boolean' },
            isCompanyOwnedStore: { type: 'boolean' },
            storeOwnerApprovalStatus: { type: 'string', nullable: true },
            isEmailVerified: { type: 'boolean' },
            token: { type: 'string', description: 'JWT authentication token' }
          }
        },
        RegisterRequest: {
          type: 'object',
          required: ['name', 'email', 'password', 'phone'],
          properties: {
            name: { type: 'string', example: 'John Doe' },
            email: { type: 'string', format: 'email', example: 'john@example.com' },
            password: { type: 'string', example: 'securePassword123' },
            phone: { type: 'string', example: '+1234567890' },
            isAdmin: { type: 'boolean', default: false },
            street: { type: 'string' },
            apartment: { type: 'string' },
            zip: { type: 'string' },
            city: { type: 'string' },
            country: { type: 'string' }
          }
        },
        ForgotPasswordRequest: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email', example: 'user@example.com' }
          }
        },
        ResetPasswordRequest: {
          type: 'object',
          required: ['token', 'email', 'password'],
          properties: {
            token: { type: 'string', description: 'Password reset token from email' },
            email: { type: 'string', format: 'email' },
            password: { type: 'string', description: 'New password' }
          }
        },
        StripePaymentIntent: {
          type: 'object',
          required: ['orderItems'],
          properties: {
            orderItems: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  quantity: { type: 'number' },
                  product: { type: 'string', description: 'Product ID' }
                }
              }
            }
          }
        },
        TelebirrPaymentRequest: {
          type: 'object',
          required: ['amount', 'phone', 'orderId'],
          properties: {
            amount: { type: 'number', example: 100.00 },
            phone: { type: 'string', pattern: '^251[0-9]{9}$', example: '251912345678' },
            orderId: { type: 'string' },
            outTradeNo: { type: 'string', description: 'Unique transaction reference' }
          }
        },
        TelebirrPaymentResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                toPayUrl: { type: 'string', description: 'Payment URL for user to complete transaction' },
                rawResponse: { type: 'object' }
              }
            }
          }
        },
        DatabaseListResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            databases: {
              type: 'array',
              items: { type: 'string' },
              example: ['E_Shopping', 'E_ShopUSA']
            },
            default: { type: 'string', example: 'E_Shopping' }
          }
        },
        DatabaseSwitchRequest: {
          type: 'object',
          required: ['database'],
          properties: {
            database: { type: 'string', example: 'E_ShopUSA', description: 'Name of the database to switch to' },
            databaseName: { type: 'string', description: 'Alias for database' },
            db: { type: 'string', description: 'Alias for database' }
          }
        },
        DatabaseSwitchResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string' },
            database: { type: 'string', example: 'E_ShopUSA' },
            instruction: { type: 'string', example: 'Add header to every request: x-database-name: E_ShopUSA' }
          }
        },
        MaintenanceSettingResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            enabled: { type: 'boolean', example: false },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
            message: { type: 'string' }
          }
        },
        MaintenanceSettingUpdateRequest: {
          type: 'object',
          required: ['enabled'],
          properties: {
            enabled: {
              type: 'boolean',
              example: true,
              description: 'Turn maintenance mode on or off'
            }
          }
        },
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', default: false },
            message: { type: 'string' },
            error: { type: 'string' }
          }
        }
      }
    },
    tags: [
      { name: 'Stores', description: 'Store management endpoints with GeoJSON coordinates for delivery dispatching.' },
      { name: 'Store Owner', description: 'Store owner portal for inventory, reviews, sales analysis, earnings, and on-demand early payouts.' },
      { name: 'Store Payouts', description: 'Platform admin endpoints for managing weekly batch settlements and approving early payout requests across Ethiopia (ETB) and USA (USD).' },
      { name: 'Drivers', description: 'Driver management endpoints with availability and live GPS location.' },
      { name: 'Notifications', description: 'Push notification endpoints for device token management and admin message delivery.' },
      { name: 'Cloudinary', description: 'Signed media upload helpers.' },
      { name: 'Products', description: 'Product catalog and moderation endpoints.' },
      { name: 'Users', description: 'User registration, authentication, and account management endpoints.' },
      { name: 'Authentication', description: 'Provider OAuth and optional authenticator/email 2FA. Keep the selected database throughout the flow. Challenges are not access JWTs.' },
      { name: 'Rides', description: 'Passenger quotes, shared/private ride lifecycle, driver workflows, routing and payments.' },
      { name: 'Store inventory', description: 'Public storefront discovery and authenticated owner inventory/assignment management.' },
      { name: 'Delivery checkout', description: 'Saved delivery addresses, regional configuration, grouped reservations, payments, cancellations and refunds.' },
      { name: 'Exchange rates', description: 'Regional USD/ETB purchasing rates and admin enablement, apply and refresh controls.' },
      { name: 'Telebirr', description: 'Telebirr payment initiation and verification endpoints.' },
      { name: 'Service Requests', description: 'Customer service request and technician workflow endpoints.' },
      { name: 'System', description: 'API health and documentation endpoints.' },
      { name: 'Database', description: 'Multi-database switching endpoints — no authentication required. Use x-database-name header on all subsequent requests after switching.' },
      { name: 'Settings', description: 'Site-wide configuration endpoints for maintenance mode and other admin-only settings.' }
    ],
    security: [{
      bearerAuth: []
    }]
  },
  apis: [path.join(__dirname, 'routers', '*.js').replace(/\\/g, '/'), path.join(__dirname, 'app.js').replace(/\\/g, '/')]
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);

// swagger-jsdoc mutates definition paths while merging router annotations.
// Merge supplemental operations again so aliases and app-level routes are retained.
swaggerDocs.paths = swaggerDocs.paths || {};
for (const [path, operations] of Object.entries(extraSwaggerPaths)) {
  swaggerDocs.paths[path] = {
    ...(swaggerDocs.paths[path] || {}),
    ...operations,
  };
}

Object.assign(swaggerDocs.components.schemas, authSwagger.schemas, commerceSwagger.schemas, ridesSwagger.schemas);
swaggerDocs.components.parameters = {
  ...(swaggerDocs.components.parameters || {}), ...authSwagger.parameters,
};
Object.assign(swaggerDocs.paths, authSwagger.paths, commerceSwagger.paths, ridesSwagger.paths);
for (const endpoint of ['login', 'driver-login', 'store-owner-login']) {
  const operation = swaggerDocs.paths[`/api/v1/users/${endpoint}`].post;
  operation.security = [];
  operation.parameters = [
    { $ref: '#/components/parameters/AuthDatabaseHeader' },
    { $ref: '#/components/parameters/AuthDatabaseQuery' },
  ];
  operation.responses = authSwagger.loginResponses;
  operation.description = `${operation.description || ''} Returns either the original access-token response or a token-free 2FA challenge. If requiresTwoFactor is true, complete /users/auth/2fa/verify before authenticating. An email deliveryError still permits backup-code verification.`;
}
const upgrade = swaggerDocs.paths['/api/v1/users/upgrade-role'].post;
upgrade.responses['200'] = {
  description: 'Role-upgrade token response, or a second-factor challenge without an access token',
  content: { 'application/json': { schema: { oneOf: [
    { $ref: '#/components/schemas/RoleUpgradeLoginResponse' },
    { $ref: '#/components/schemas/TwoFactorChallenge' },
  ] } } },
};
swaggerDocs.paths['/api/v1/stores/register-owner'].post.responses['201'] = {
  description: 'Registration response or an existing account second-factor challenge; no token until factor verification',
  content: { 'application/json': { schema: { oneOf: [
    { $ref: '#/components/schemas/StoreRegistrationLoginResponse' },
    { $ref: '#/components/schemas/TwoFactorChallenge' },
  ] } } },
};

for (const method of ['put', 'delete']) {
  swaggerDocs.paths['/api/v1/notifications/{userId}/push-token'] = {
    ...(swaggerDocs.paths['/api/v1/notifications/{userId}/push-token'] || {}),
    [method]: JSON.parse(JSON.stringify(swaggerDocs.paths['/api/v1/users/{userId}/push-token'][method])),
  };
}
for (const [endpoint, operations] of Object.entries(swaggerDocs.paths)) {
  if (endpoint.startsWith('/api/v1/notifications/')) {
    const alias = endpoint.replace('/api/v1/notifications/', '/api/v1/users/');
    const aliased = JSON.parse(JSON.stringify(operations));
    for (const operation of Object.values(aliased)) {
      if (operation && typeof operation === 'object' && operation.responses) {
        operation.security = [{ bearerAuth: [] }];
      }
    }
    swaggerDocs.paths[alias] = { ...aliased, ...(swaggerDocs.paths[alias] || {}) };
  }
}

const companyOperations = {
  '/api/v1/drivers/admin/company-drivers': ['get', 'post'],
  '/api/v1/drivers/admin/company-drivers/{id}': ['put'],
  '/api/v1/drivers/me/completed-today': ['get'],
  '/api/v1/orders/admin/company-fulfillable': ['get'],
  '/api/v1/orders/company/my-deliveries': ['get'],
  '/api/v1/orders/{id}/company-claim': ['put'],
  '/api/v1/orders/{id}/company-reject': ['put'],
  '/api/v1/orders/admin/company-rejections': ['get'],
  '/api/v1/orders/{id}/company-responses/{responseId}': ['delete'],
  '/api/v1/products/admin/company-fulfillable': ['get'],
  '/api/v1/products/company/my-products': ['get'],
  '/api/v1/products/{id}/company-ready': ['put'],
  '/api/v1/products/{id}/company-reject': ['put'],
  '/api/v1/products/admin/company-rejections': ['get'],
  '/api/v1/products/{id}/company-responses/{responseId}': ['delete'],
  '/api/v1/stores/admin/company-stores': ['get', 'post'],
  '/api/v1/stores/admin/company-stores/{id}': ['put'],
  '/api/v1/users/admin/assign-role': ['post'],
};
for (const [endpoint, methods] of Object.entries(companyOperations)) {
  for (const method of methods) {
    const operation = swaggerDocs.paths[endpoint][method];
    operation.parameters = [...endpoint.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      in: 'path', name: match[1], required: true, schema: { type: 'string' },
    }));
    const success = method === 'post' && /\/company-(stores|drivers)$/.test(endpoint) ? '201' : '200';
    operation.responses = {
      [success]: { description: operation.summary },
      400: { description: 'Invalid request' },
      401: { description: 'Authentication required' },
      403: { description: 'Required admin, company-driver or company-store access is missing' },
      404: { description: 'Requested account, order, product or response not found' },
      409: { description: 'Assignment or availability changed; reload before retrying' },
      500: { description: 'Unable to complete the operation' },
    };
  }
}

module.exports = swaggerDocs;
