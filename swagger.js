const swaggerJsDoc = require('swagger-jsdoc');

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
          properties: {
            user: { type: 'string', format: 'email' },
            _id: { type: 'string' },
            name: { type: 'string' },
            phone: { type: 'string' },
            isAdmin: { type: 'boolean' },
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
      { name: 'Database', description: 'Multi-database switching endpoints — no authentication required. Use x-database-name header on all subsequent requests after switching.' },
      { name: 'Settings', description: 'Site-wide configuration endpoints for maintenance mode and other admin-only settings.' }
    ],
    security: [{
      bearerAuth: []
    }]
  },
  apis: ['./routers/*.js', './app.js'] // Path to the API routes
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);

module.exports = swaggerDocs;
