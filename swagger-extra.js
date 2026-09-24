const response = (description) => ({ description });

const operation = (summary, tags, options = {}) => ({
  summary,
  tags: [tags],
  ...(options.security === false ? { security: [] } : {}),
  ...(options.parameters ? { parameters: options.parameters } : {}),
  ...(options.requestBody ? {
    requestBody: {
      required: options.requestBody.required !== false,
      content: {
        'application/json': {
          schema: options.requestBody.schema || { type: 'object', additionalProperties: true },
        },
      },
    },
  } : {}),
  responses: {
    [options.success || '200']: response(options.successDescription || 'Successful response'),
    ...(options.errorResponses || {
      400: response('Invalid request'),
      401: response('Authentication required'),
      500: response('Server error'),
    }),
  },
});

const pathParameter = (name) => ({
  in: 'path',
  name,
  required: true,
  schema: { type: 'string' },
});

const queryParameter = (name, description) => ({
  in: 'query',
  name,
  required: false,
  description,
  schema: { type: 'string' },
});

module.exports = {
  '/': {
    get: operation('Check API health', 'System', { security: false, successDescription: 'API is available' }),
  },
  '/api-docs/swagger.json': {
    get: operation('Get the OpenAPI document', 'System', { security: false, success: '200', successDescription: 'OpenAPI JSON document' }),
  },
  '/sign': {
    post: operation('Create a signed Cloudinary upload payload', 'Cloudinary', { requestBody: { required: false }, success: '200' }),
  },
  '/api/v1/cloudinary/sign': {
    post: operation('Create a signed Cloudinary upload payload', 'Cloudinary', { requestBody: { required: false }, success: '200' }),
  },
  '/api/v1/notifications/drivers/{driverId}/push-token': {
    put: operation('Register a push token for a driver', 'Notifications', { parameters: [pathParameter('driverId')], requestBody: { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } } }),
  },
  '/api/v1/users/drivers/{driverId}/push-token': {
    put: operation('Register a push token for a driver', 'Notifications', { parameters: [pathParameter('driverId')], requestBody: { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } } }),
  },
  '/api/v1/drivers/{id}/approve': {
    put: operation('Approve a driver application', 'Drivers', { parameters: [pathParameter('id')], success: '200' }),
  },
  '/api/v1/drivers/{id}/{action}': {
    put: operation('Deny or recover a driver application', 'Drivers', { parameters: [pathParameter('id'), { ...pathParameter('action'), schema: { type: 'string', enum: ['deny', 'recover'] } }], success: '200' }),
  },
  '/api/v1/drivers/me': {
    put: operation('Update the authenticated driver vehicle', 'Drivers', { requestBody: { schema: { type: 'object', required: ['vehicle'], properties: { vehicle: { type: 'object', additionalProperties: true } } } } }),
  },
  '/api/v1/drivers/me/queue': {
    get: operation('Get the authenticated driver delivery queue', 'Drivers'),
  },
  '/api/v1/drivers/me/wallet': {
    get: operation('Get the authenticated driver wallet', 'Drivers'),
  },
  '/api/v1/drivers/me/wallet/deposit-requests': {
    post: operation('Submit a driver wallet deposit request', 'Drivers', { success: '201', requestBody: { schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', minimum: 0 }, provider: { type: 'string' }, reference: { type: 'string' }, notes: { type: 'string' } } } } }),
  },
  '/api/v1/drivers/wallet/deposit-requests': {
    get: operation('List driver wallet deposit requests', 'Drivers', { parameters: [queryParameter('status', 'Filter by pending, completed, failed, or all')] }),
  },
  '/api/v1/drivers/wallet/deposit-requests/{transactionId}/approve': {
    put: operation('Approve a driver wallet deposit request', 'Drivers', { parameters: [pathParameter('transactionId')] }),
  },
  '/api/v1/drivers/wallet/deposit-requests/{transactionId}/reject': {
    put: operation('Reject a driver wallet deposit request', 'Drivers', { parameters: [pathParameter('transactionId')], requestBody: { required: false, schema: { type: 'object', properties: { reason: { type: 'string' } } } } }),
  },
  '/api/v1/drivers/{id}/wallet/adjust': {
    post: operation('Adjust a driver wallet balance', 'Drivers', { parameters: [pathParameter('id')], requestBody: { schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' }, reference: { type: 'string' }, notes: { type: 'string' } } } } }),
  },
  '/api/v1/drivers/{id}/wallet/transactions': {
    get: operation('List transactions for a driver wallet', 'Drivers', { parameters: [pathParameter('id')] }),
  },
  '/api/v1/drivers/{id}/suspend': {
    put: operation('Suspend a driver account', 'Drivers', { parameters: [pathParameter('id')], requestBody: { required: false, schema: { type: 'object', properties: { reason: { type: 'string' } } } } }),
  },
  '/api/v1/drivers/{id}/reinstate': {
    put: operation('Reinstate a suspended driver account', 'Drivers', { parameters: [pathParameter('id')] }),
  },
  '/api/v1/products/admin/pending': {
    get: operation('List products awaiting approval', 'Products'),
  },
  '/api/v1/products/{id}/approve': {
    put: operation('Approve a product listing', 'Products', { parameters: [pathParameter('id')] }),
  },
  '/api/v1/products/{id}/deny': {
    put: operation('Deny a product listing', 'Products', { parameters: [pathParameter('id')], requestBody: { required: false, schema: { type: 'object', properties: { reason: { type: 'string' } } } } }),
  },
  '/api/v1/stores/register-owner': {
    post: operation('Register a store owner and store application', 'Store Owner', { security: false, success: '201', requestBody: { schema: { type: 'object', required: ['fullName', 'storeName', 'email', 'password', 'latitude', 'longitude'], additionalProperties: true } } }),
  },
  '/api/v1/stores/admin/owners': {
    get: operation('List store-owner applications', 'Stores', { parameters: [queryParameter('approvalStatus', 'Filter by pending, approved, or denied'), queryParameter('allDatabases', 'Aggregate results across configured databases')] }),
  },
  '/api/v1/stores/{id}/{action}': {
    put: operation('Approve, deny, or recover a store-owner application', 'Stores', { parameters: [pathParameter('id'), { ...pathParameter('action'), schema: { type: 'string', enum: ['approve', 'deny', 'recover'] } }] }),
  },
  '/api/v1/stores/mine/by-owner': {
    get: operation('Get the authenticated owner store', 'Store Owner'),
  },
  '/api/v1/stores/mine/update': {
    put: operation('Update the authenticated owner store profile', 'Store Owner', { requestBody: { schema: { type: 'object', additionalProperties: true } } }),
  },
  '/api/v1/stores/{id}/dashboard': {
    get: operation('Get store dashboard metrics', 'Store Owner', { parameters: [pathParameter('id')] }),
  },
  '/api/v1/stores/{id}/sales': {
    get: operation('Get store sales breakdown', 'Store Owner', { parameters: [pathParameter('id'), queryParameter('range', 'today, 7d, 30d, 3m, or 1y')] }),
  },
  '/api/v1/stores/{id}/top-products': {
    get: operation('Get best-selling store products', 'Store Owner', { parameters: [pathParameter('id')] }),
  },
  '/api/v1/stores/{id}/products': {
    get: operation('List products belonging to a store', 'Store Owner', { parameters: [pathParameter('id')] }),
    post: operation('Submit a store product for approval', 'Store Owner', { parameters: [pathParameter('id')], success: '201', requestBody: { schema: { type: 'object', required: ['name', 'price', 'category'], additionalProperties: true } } }),
  },
  '/api/v1/stores/{id}/products/{productId}': {
    put: operation('Update a store product', 'Store Owner', { parameters: [pathParameter('id'), pathParameter('productId')], requestBody: { schema: { type: 'object', additionalProperties: true } } }),
  },
  '/api/v1/stores/{id}/products/{productId}/stock': {
    post: operation('Adjust store product stock', 'Store Owner', { parameters: [pathParameter('id'), pathParameter('productId')], requestBody: { schema: { type: 'object', required: ['delta'], properties: { delta: { type: 'integer' }, reason: { type: 'string' } } } } }),
  },
  '/api/v1/stores/{id}/orders': {
    get: operation('List orders for a store', 'Store Owner', { parameters: [pathParameter('id')] }),
  },
  '/api/v1/stores/{id}/orders/{orderId}': {
    patch: operation('Update a store order status', 'Store Owner', { parameters: [pathParameter('id'), pathParameter('orderId')], requestBody: { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } } } }),
  },
  '/api/v1/stores/{id}/reviews': {
    get: operation('List customer reviews for a store', 'Store Owner', { parameters: [pathParameter('id')] }),
  },
  '/api/v1/telebirr/verify': {
    post: operation('Verify a Telebirr payment', 'Telebirr', { requestBody: { schema: { type: 'object', additionalProperties: true } } }),
  },
  '/api/v1/telebirr/check-status': {
    post: operation('Check Telebirr payment status', 'Telebirr', { requestBody: { schema: { type: 'object', additionalProperties: true } } }),
  },
  '/api/v1/telebirr/payment-status': {
    post: operation('Check Telebirr payment status', 'Telebirr', { requestBody: { schema: { type: 'object', additionalProperties: true } } }),
  },
  '/api/v1/telebirr/verify/{transactionId}': {
    get: operation('Verify a Telebirr transaction by ID', 'Telebirr', { parameters: [pathParameter('transactionId')] }),
  },
  '/api/v1/users/driver-login': {
    post: operation('Sign in to the driver application', 'Users', { security: false, requestBody: { schema: { $ref: '#/components/schemas/LoginRequest' } } }),
  },
  '/api/v1/users': {
    post: operation('Create a user account', 'Users', { security: false, success: '200', requestBody: { schema: { $ref: '#/components/schemas/RegisterRequest' } } }),
  },
  '/api/v1/users/store-owner-login': {
    post: operation('Sign in to the store owner application', 'Users', { security: false, requestBody: { schema: { $ref: '#/components/schemas/LoginRequest' } } }),
  },
  '/api/v1/users/verify-email': {
    post: operation('Verify an email address with a token', 'Users', { security: false, requestBody: { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } } }),
  },
  '/api/v1/users/reset-password': {
    get: operation('Open the password reset form', 'Users', { security: false, parameters: [queryParameter('token', 'Password reset token'), queryParameter('email', 'User email')] }),
  },
  '/api/v1/users/upgrade-role': {
    post: operation('Upgrade an account role', 'Users', { requestBody: { schema: { type: 'object', additionalProperties: true } } }),
  },
  '/api/v1/users/me': {
    get: operation('Get the authenticated user', 'Users'),
  },
  '/api/v1/service-requests': {
    get: operation('List service requests', 'Service Requests', { parameters: [queryParameter('customer', 'Filter by customer ID')] }),
    post: operation('Create a service request', 'Service Requests', { success: '201', requestBody: { schema: { type: 'object', required: ['country', 'serviceLocation', 'machineType', 'problemDescription', 'contactPhone'], properties: { country: { type: 'string', enum: ['Ethiopia', 'USA'] }, serviceLocation: { type: 'string' }, machineType: { type: 'string' }, problemDescription: { type: 'string' }, contactPhone: { type: 'string' }, priority: { type: 'string', enum: ['Low', 'Normal', 'High', 'Emergency'] }, photos: { type: 'array', items: { type: 'string' } }, videos: { type: 'array', items: { type: 'string' } } } } } }),
  },
  '/api/v1/service-requests/mine': {
    get: operation('List the authenticated customer service requests', 'Service Requests'),
  },
  '/api/v1/service-requests/assigned': {
    get: operation('List service requests assigned to the technician', 'Service Requests'),
  },
  '/api/v1/service-requests/{id}': {
    get: operation('Get a service request', 'Service Requests', { parameters: [pathParameter('id')] }),
    put: operation('Update a service request', 'Service Requests', { parameters: [pathParameter('id')], requestBody: { schema: { type: 'object', additionalProperties: true } } }),
    delete: operation('Delete a service request', 'Service Requests', { parameters: [pathParameter('id')] }),
  },
};
