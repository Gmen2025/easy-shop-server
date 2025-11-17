const express = require('express');
const app = express();
const morgan = require('morgan');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const authJwt = require('./helpers/jwt');
const errorHandler = require('./helpers/error-handler');


// Safari-compatible CORS configuration
const corsConfig = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, postman)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      process.env.FRONTEND_URL,
      process.env.BACKEND_URL
    ];

     // Allow all local network IPs (192.168.x.x)
    if (origin.match(/^http:\/\/192\.168\.\d+\.\d+:\d+$/)) {
      return callback(null, true);
    }
    
    // Check if the origin is in the allowed list
    if (allowedOrigins.includes(origin)) {
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
    'Accept',
    'Origin'
  ]
};

app.use(cors(corsConfig));
// app.use(cors({
//   origin: 'http://localhost:3001', // or your frontend URL
//   credentials: true
// }));


app.options('*', cors(corsConfig)); // Enable pre-flight for all routes

// Safari-specific headers middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  
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


//Middleware
app.use(express.json());
app.use(morgan('tiny'));
app.use(express.urlencoded({ extended: true }));

//Swagger Documentation Route (MUST be before authJwt middleware)
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Apply JWT authentication (after Swagger route)
app.use(authJwt());
app.use('/public/uploads', express.static(__dirname + '/public/uploads'));;
app.use(errorHandler);


//Routers
app.use(`${api}/products`, productsRouter);
app.use(`${api}/categories`, categoriesRouter);
app.use(`${api}/orders`, ordersRouter);
app.use(`${api}/users`, usersRouter);
app.use(`${api}/stripe`, stripeRouter); 
app.use(`${api}/telebirr`, telebirrRouter);

const PORT = process.env.PORT || 3001;

//Database connection
mongoose.connect(process.env.CONNECTION_STRING, {
  dbName: 'E_Shopping'
}).then(() => {
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

