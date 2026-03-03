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

## 🛠️ Tech Stack

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
   
   TELEBIRR_BASE_URL=https://api.telebirr.com
   USE_MOCK_TELEBIRR=true
   TELEBIRR_PRIVATE_KEY=your-telebirr-private-key
   
   # Environment
   NODE_ENV=development
   PORT=3001
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
