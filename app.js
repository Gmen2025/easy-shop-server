const express = require('express');
const app = express();
const morgan = require('morgan');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const authJwt = require('./helpers/jwt');
const errorHandler = require('./helpers/error-handler');


app.use(cors());
// app.use(cors({
//   origin: 'http://localhost:3001', // or your frontend URL
//   credentials: true
// }));
app.options('*', cors());

const api = process.env.API_URL;

const productsRouter = require('./routers/products');
const categoriesRouter = require('./routers/categories');
const ordersRouter = require('./routers/orders');
const usersRouter = require('./routers/users');


//Middleware
app.use(express.json());
app.use(morgan('tiny'));
app.use(authJwt());
app.use('/public/uploads', express.static(__dirname + '/public/uploads'));;
app.use(errorHandler);


//Routers
app.use(`${api}/products`, productsRouter);
app.use(`${api}/categories`, categoriesRouter);
app.use(`${api}/orders`, ordersRouter);
app.use(`${api}/users`, usersRouter);





//Database connection
mongoose.connect(process.env.CONNECTION_STRING, {
  dbName: 'E_Shopping'
}).then(() => {
  console.log('Database connection is ready...');
}).catch((err) => {
  console.log(err);
})

//Development server
// app.listen(3001, () => {
  
//   console.log('Server is running http://localhost:3001');
// })

//Production server
var server = app.listen(process.env.PORT || 3001, () => {
  var port = server.address().port;
  console.log("Express is working on port " + port);
});


