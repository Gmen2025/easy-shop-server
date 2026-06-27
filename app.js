const express = require('express');
const app = express();
const morgan = require('morgan');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const authJwt = require('./helpers/jwt');
const errorHandler = require('./helpers/error-handler');
const dbSelector = require('./helpers/db-selector');
const { connectDefaultDatabase } = require('./helpers/db-manager');
const { verifyMailerConnection } = require('./helpers/mailer');

// Respect x-forwarded-* headers when running behind Render/reverse proxies.
app.set('trust proxy', 1);


function parseCsvEnv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const localhostOriginRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const localNetworkOriginRegex = /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/;

// Safari-compatible CORS configuration
const deployedFrontendOrigin = 'https://easy-shop-webapp.onrender.com';
const customFrontendOrigin = 'https://addugeneteshop.com';
const customFrontendWwwOrigin = 'https://www.addugeneteshop.com';
const allowedOrigins = [
  deployedFrontendOrigin,
  customFrontendOrigin,
  customFrontendWwwOrigin,
  process.env.FRONTEND_URL,
  process.env.BACKEND_URL,
  ...parseCsvEnv(process.env.CORS_ORIGINS),
].filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) {
    return true;
  }

  if (localhostOriginRegex.test(origin) || localNetworkOriginRegex.test(origin)) {
    return true;
  }

  return allowedOrigins.includes(origin);
}

const corsConfig = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, postman)
    if (!origin) return callback(null, true);

    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization', 
    'X-Requested-With',
    'x-database-name',
    'Accept',
    'Origin'
  ],
  exposedHeaders: ['x-selected-database']
};

app.use(cors(corsConfig));

// Log all inbound requests early (including OPTIONS preflight)
app.use((req, res, next) => {
  console.log(`[Inbound] ${req.method} ${req.originalUrl} from ${req.headers.origin || 'unknown-origin'}`);
  next();
});


app.options('*', cors(corsConfig)); // Enable pre-flight for all routes

// Safari-specific headers middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, x-database-name');
  res.setHeader('Access-Control-Expose-Headers', 'x-selected-database');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

const api = process.env.API_URL;

// Swagger documentation
const swaggerUi = require('swagger-ui-express');
const swaggerDocs = require('./swagger');

const productsRouter = require('./routers/products');
const categoriesRouter = require('./routers/categories');
const ordersRouter = require('./routers/orders');
const usersRouter = require('./routers/users');
const stripeRouter = require('./routers/stripe');
const telebirrRouter = require('./routers/telebirr');
const cloudinaryRouter = require('./routers/cloudinary');
const databaseRouter = require('./routers/database');
const notificationsRouter = require('./routers/notifications');


//Middleware
app.use(express.json());
app.use(morgan('tiny'));
app.use(express.urlencoded({ extended: true }));
app.use(dbSelector);

//Swagger Documentation Route (MUST be before authJwt middleware)
app.get('/api-docs/swagger.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.send(swaggerDocs);
});

const swaggerOptions = {
  swaggerOptions: {
    url: '/api-docs/swagger.json',
  }
};

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(null, swaggerOptions));

// Apply JWT authentication (after Swagger route)
app.use(authJwt());
app.use('/public/uploads', express.static(__dirname + '/public/uploads'));;


//Routers
app.use(`${api}/products`, productsRouter);
app.use(`${api}/categories`, categoriesRouter);
app.use(`${api}/orders`, ordersRouter);
app.use(`${api}/users`, usersRouter);
app.use(`${api}/stripe`, stripeRouter); 
app.use(`${api}/telebirr`, telebirrRouter);
app.use(`${api}/cloudinary`, cloudinaryRouter);
app.use(`${api}/database`, databaseRouter);
// Notifications: push-token sub-routes live under /users, send/health under /notifications
app.use(`${api}/notifications`, notificationsRouter);
app.use(`${api}/users`, notificationsRouter);
app.use('/', cloudinaryRouter);

app.use(errorHandler);

const PORT = process.env.PORT || 3001;

function getConfiguredStripeEnvNames() {
  const stripeEnvPrefixes = ['STRIPE_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_API_KEY'];

  return Object.keys(process.env)
    .filter((name) => stripeEnvPrefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}_`)))
    .filter((name) => !!process.env[name])
    .sort();
}

//Database connection
connectDefaultDatabase().then(() => {
  console.log('Database connection is ready...');
   // Bind to 0.0.0.0 to accept connections from any network interface
    const server = app.listen(PORT, '0.0.0.0', () => {
        const networkInterfaces = require('os').networkInterfaces();
        const addresses = [];
        
        // Collect all non-internal IPv4 addresses
        for (const name of Object.keys(networkInterfaces)) {
            for (const net of networkInterfaces[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    addresses.push(net.address);
                }
            }
        }
        
        console.log(`Server is running on:`);
        console.log(`- http://localhost:${PORT}`);
        addresses.forEach(addr => {
            console.log(`- http://${addr}:${PORT}`);
        });
        console.log(`API available at ${process.env.API_URL}`);

        const stripeEnvNames = getConfiguredStripeEnvNames();
        if (stripeEnvNames.length > 0) {
          console.log(`[Startup] Stripe env keys detected: ${stripeEnvNames.join(', ')}`);
        } else {
          console.log('[Startup] Stripe env keys detected: none');
        }

        // Surface SMTP/auth issues immediately in startup logs.
        verifyMailerConnection('startup').catch((error) => {
          console.error('[Mail:startup] Unexpected verification error:', error?.message || error);
        });
    });
    
    server.on('error', (err) => {
        console.error('Server error:', err);
    });
}).catch((err) => {
  console.error('Database connection failed:', err);
})

//Development server
// app.listen(3001, () => {
  
//   console.log('Server is running http://localhost:3001');
// })

//Production server
// var server = app.listen(process.env.PORT || 3001, () => {
//   var port = server.address().port;
//   console.log("Express is working on port " + port);
// });

//API Base URL: https://easy-shop-server-wldr.onrender.com/api/v1
//Documentation: https://easy-shop-server-wldr.onrender.com/api-docs

