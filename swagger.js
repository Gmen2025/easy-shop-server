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
        url: 'http://localhost:3001',
        description: 'Development server'
      },
      {
        url: 'https://easy-shop-server-wldr.onrender.com',
        description: 'Production server'
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
      }
    },
    security: [{
      bearerAuth: []
    }]
  },
  apis: ['./routers/*.js'] // Path to the API routes
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);

module.exports = swaggerDocs;
