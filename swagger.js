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
            countInStock: { type: 'number', minimum: 0, maximum: 255 },
            rating: { type: 'number', default: 0 },
            numReviews: { type: 'number', default: 0 },
            isFeatured: { type: 'boolean', default: false },
            dateCreated: { type: 'string', format: 'date-time' }
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
    security: [{
      bearerAuth: []
    }]
  },
  apis: ['./routers/*.js', './app.js'] // Path to the API routes
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);

module.exports = swaggerDocs;
