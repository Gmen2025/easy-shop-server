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
  '/api/v1/orders/admin/dashboard': {
    get: {
      ...operation('Read platform sales and operations dashboard', 'Orders'),
      description: 'Admin only. Daily/weekly/monthly/quarterly/yearly periods cover trailing 1/7/30/90/365 days. Revenue is based on completed deliveries; order counts include placed orders.',
      responses: {
        200: { description: 'Platform dashboard', content: { 'application/json': { schema: {
          type: 'object', properties: {
            success: { type: 'boolean' }, periods: { $ref: '#/components/schemas/DashboardPeriods' },
            operations: { type: 'object', properties: { outstandingOrders: { type: 'integer' }, activeDeliveries: { type: 'integer' } } },
            inventory: { type: 'object', additionalProperties: { type: 'number' } },
            payouts: { type: 'object', properties: { paid: { type: 'number' }, pending: { type: 'number' } } },
            lifetime: { type: 'object', additionalProperties: { type: 'number' } },
            recentSales: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        } } } },
        401: response('Authentication required'), 403: response('Admin access required'), 500: response('Dashboard unavailable'),
      },
    },
  },
  '/api/v1/stores/me/dashboard': {
    get: {
      ...operation('Read the authenticated company-store dashboard', 'Store Owner'),
      description: 'Requires a company-owned store profile. Returns trailing daily/weekly/monthly/quarterly/yearly sales, inventory across owned locations when managed, payout balances, recent and active orders.',
      responses: {
        200: { description: 'Company-store metrics', content: { 'application/json': { schema: {
          type: 'object', properties: {
            success: { type: 'boolean' }, store: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
            periods: { $ref: '#/components/schemas/DashboardPeriods' },
            products: { type: 'object', additionalProperties: { type: 'number' } },
            inventory: { type: 'object', additionalProperties: { type: 'number' } },
            orders: { type: 'object', properties: { pending: { type: 'integer' } } },
            payouts: { type: 'object', properties: { paidOut: { type: 'number' }, pending: { type: 'number' }, available: { type: 'number' } } },
            recentOrders: { type: 'array', items: { type: 'object', additionalProperties: true } },
            activeOrders: { type: 'array', items: { type: 'object', additionalProperties: true } },
            recentCompletedOrders: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        } } } },
        401: response('Authentication required'), 404: response('Company-store profile not found'), 500: response('Dashboard unavailable'),
      },
    },
  },
  '/api/v1/drivers/me/dashboard': {
    get: {
      ...operation('Read the authenticated driver earnings dashboard', 'Drivers'),
      description: 'Uses delivered orders assigned to the current driver, with trailing 1/7/30/90/365-day periods and at most five recent deliveries.',
      responses: {
        200: { description: 'Driver metrics', content: { 'application/json': { schema: {
          type: 'object', properties: {
            success: { type: 'boolean' }, periods: { $ref: '#/components/schemas/DashboardPeriods' },
            recentDeliveries: { type: 'array', maxItems: 5, items: { type: 'object', properties: {
              _id: { type: 'string' }, storeName: { type: 'string' }, deliveryFee: { type: 'number' },
              deliveredAt: { type: 'string', format: 'date-time' },
              deliveryMode: { type: 'string' }, scheduledFor: { type: 'string', format: 'date-time', nullable: true },
            } } },
          },
        } } } },
        401: response('Authentication required'), 404: response('Driver profile not found'), 500: response('Dashboard unavailable'),
      },
    },
  },
  '/api/v1/drivers/me/orders/{id}/route': {
    post: {
      ...operation('Calculate a traffic-aware route for an assigned delivery', 'Drivers', {
        parameters: [pathParameter('id')],
        requestBody: { schema: { type: 'object', required: ['origin'], properties: {
          origin: { type: 'object', required: ['latitude', 'longitude'], properties: {
            latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 },
          } },
        } } },
      }),
      description: 'Approved, non-suspended driver with an assigned active order only. Routes to pickup while Driver Assigned and to the customer after Picked Up. Requires server GOOGLE_ROUTES_API_KEY. Rate limited to one request per driver per database per ten seconds.',
      responses: {
        200: { description: 'Driving geometry, kilometres and minutes', content: { 'application/json': { schema: {
          type: 'object', properties: {
            success: { type: 'boolean' }, distance: { type: 'number', description: 'Kilometres' },
            duration: { type: 'number', description: 'Traffic-aware duration in minutes' },
            coordinates: { type: 'array', items: { type: 'object', properties: {
              latitude: { type: 'number' }, longitude: { type: 'number' },
            } } },
          },
        } } } },
        400: response('Invalid order ID or GPS origin'), 401: response('Authentication required'),
        403: response('Approved non-suspended driver required'), 404: response('Assigned active delivery not found'),
        422: response('Missing destination or no driving route'),
        429: { description: 'Driver route cooldown', headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait' } } },
        502: response('Routes provider error'), 503: response('Routes API not configured'),
      },
    },
  },
  '/api/v1/orders/{id}/company-reroute': {
    put: {
      ...operation('Return a company-driver offer for rerouting', 'Orders', {
        parameters: [pathParameter('id')],
        errorResponses: { 400: response('Invalid ID'), 401: response('Authentication required'),
          403: response('Company driver required'), 404: response('Order not found'),
          409: response('Already responded, offer no longer available, or no alternate driver'), 500: response('Reroute failed') },
      }),
      description: 'Only the offered company driver can respond, once, before assignment. Requires another eligible company or nearby partner driver. Does not cancel/delete an order or issue a refund.',
    },
  },
  '/': {
    get: operation('Check API health', 'System', { security: false, successDescription: 'API is available' }),
  },
  '/api-docs/swagger.json': {
    get: operation('Get the OpenAPI document', 'System', { security: false, success: '200', successDescription: 'OpenAPI JSON document' }),
  },
  '/sign': {
    post: {
      ...operation('Create a signed Cloudinary upload payload', 'Cloudinary', {
        requestBody: { required: false }, success: '200',
        errorResponses: {
          401: response('Authentication required'),
          403: response('Admin or approved linked store-owner access required; store owners may sign only product-folder uploads.'),
          500: response('Cloudinary is not configured'),
        },
      }),
      description: 'Requires an authenticated admin or approved linked store owner. Store owners are limited to the eshop/products folder.',
    },
  },
  '/api/v1/cloudinary/sign': {
    post: {
      ...operation('Create a signed Cloudinary upload payload', 'Cloudinary', {
        requestBody: { required: false }, success: '200',
        errorResponses: {
          401: response('Authentication required'),
          403: response('Admin or approved linked store-owner access required; store owners may sign only product-folder uploads.'),
          500: response('Cloudinary is not configured'),
        },
      }),
      description: 'Requires an authenticated admin or approved linked store owner. Store owners are limited to the eshop/products folder.',
    },
  },
  '/api/v1/notifications/drivers/{driverId}/push-token': {
    put: {
      ...operation('Register an Expo push token for a driver', 'Notifications'),
      parameters: [pathParameter('driverId')],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['pushToken'],
              properties: { pushToken: { type: 'string', description: 'Expo push token' } },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Push token saved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  driverId: { type: 'string' },
                  totalTokens: { type: 'integer' },
                },
              },
            },
          },
        },
        400: response('Invalid Expo push token'),
        401: response('Authentication required'),
        404: response('Driver not found'),
        500: response('Driver model is not available'),
      },
    },
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
  '/api/v1/settings/payment-methods': {
    get: {
      ...operation('Get enabled payment methods', 'Settings', { security: false }),
      responses: {
        200: {
          description: 'Payment method availability',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  methods: {
                    type: 'object',
                    properties: {
                      cash: { type: 'boolean' },
                      bank: { type: 'boolean' },
                      card: { type: 'boolean' },
                      telebirr: { type: 'boolean' },
                    },
                  },
                  enabled: { type: 'boolean' },
                  updatedAt: { type: 'string', format: 'date-time', nullable: true },
                },
              },
            },
          },
        },
        503: response('Payment availability could not be loaded'),
      },
    },
    put: {
      ...operation('Update enabled payment methods', 'Settings', {
        requestBody: {
          schema: {
            type: 'object',
            required: ['methods'],
            additionalProperties: false,
            properties: {
              methods: {
                type: 'object',
                minProperties: 1,
                additionalProperties: false,
                properties: {
                  cash: { type: 'boolean' },
                  bank: { type: 'boolean' },
                  card: { type: 'boolean' },
                  telebirr: { type: 'boolean' },
                },
              },
            },
          },
        },
      }),
      description: 'Admin only. The methods object may update one or more supported payment methods.',
      responses: {
        200: response('Payment method availability updated'),
        400: response('Methods must contain supported boolean switches'),
        401: response('Authentication required'),
        403: response('Admin access required'),
        503: response('Payment method settings could not be saved'),
      },
    },
  },
  '/api/v1/drivers/me/available-deliveries': {
    get: {
      ...operation('List available delivery assignments for the authenticated driver', 'Drivers'),
      description: 'Requires a driver profile. The response includes assignment eligibility and filters shared assignments by pickup proximity, vehicle, and remaining capacity.',
      responses: {
        200: {
          description: 'Available delivery assignments and driver eligibility',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  orders: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  driverEligibility: {
                    type: 'object',
                    properties: {
                      eligible: { type: 'boolean' },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        401: response('Authentication required'),
        403: response('Driver profile required'),
        500: response('Available assignments could not be loaded'),
      },
    },
  },
  '/api/v1/drivers/me/available-deliveries/{id}/claim': {
    put: {
      ...operation('Claim an available delivery assignment', 'Drivers', {
        parameters: [pathParameter('id')],
      }),
      responses: {
        200: {
          description: 'Delivery assignment claimed',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  message: { type: 'string' },
                  cartOrderIds: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        400: response('Invalid order ID'),
        401: response('Authentication required'),
        403: response('Driver profile required'),
        409: response('Assignment is no longer available or exceeds driver capacity'),
        500: response('Delivery assignment could not be claimed'),
      },
    },
  },
  '/api/v1/stores/admin/assignments': {
    get: {
      ...operation('List store fulfillment assignments requiring admin attention', 'Store inventory'),
      description: 'Admin only. Returns active fulfillment assignments, store-review requests, and eligible pending deliveries.',
      responses: {
        200: {
          description: 'Assignments requiring review or fulfillment',
          content: {
            'application/json': {
              schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
        },
        401: response('Authentication required'),
        403: response('Admin access required'),
        500: response('Assignments could not be loaded'),
      },
    },
  },
  '/api/v1/stores/me/assignments/{id}/drivers/{decision}': {
    post: {
      ...operation('Reroute a store assignment to an eligible driver', 'Store inventory', {
        parameters: [
          pathParameter('id'),
          { ...pathParameter('decision'), schema: { type: 'string', enum: ['reroute', 'assign'] } },
        ],
      }),
      description: 'Store owner only. The assign decision is restricted to admins; store owners can use reroute.',
      responses: {
        200: response('Driver assignment updated'),
        400: response('Invalid order, action, or driver ID'),
        401: response('Authentication required'),
        403: response('Store owner access required or action is admin-only'),
        404: response('Assignment not found'),
        409: response('Assignment cannot be rerouted'),
        500: response('Driver assignment could not be updated'),
      },
    },
  },
  '/api/v1/stores/admin/assignments/{id}/drivers/{decision}': {
    post: {
      ...operation('Assign or reroute a store delivery to a driver', 'Store inventory', {
        parameters: [
          pathParameter('id'),
          { ...pathParameter('decision'), schema: { type: 'string', enum: ['reroute', 'assign'] } },
        ],
        requestBody: {
          required: false,
          schema: {
            type: 'object',
            properties: { driverId: { type: 'string', description: 'Required when decision is assign' } },
          },
        },
      }),
      description: 'Admin only. Use assign with driverId to select a driver, or reroute to find an eligible driver.',
      responses: {
        200: response('Driver assignment updated'),
        400: response('Invalid order, action, or driver ID'),
        401: response('Authentication required'),
        403: response('Admin access required'),
        404: response('Assignment not found'),
        409: response('Assignment cannot be rerouted or assigned'),
        500: response('Driver assignment could not be updated'),
      },
    },
  },
  '/api/v1/stores/admin/assignments/{id}/{decision}': {
    post: {
      ...operation('Respond to a store fulfillment assignment as an admin', 'Store inventory', {
        parameters: [
          pathParameter('id'),
          { ...pathParameter('decision'), schema: { type: 'string', enum: ['accept', 'reroute', 'ready', 'enable-preparation'] } },
        ],
        requestBody: {
          required: false,
          schema: {
            type: 'object',
            properties: {
              storeId: { type: 'string', description: 'Target store ID when accepting an assignment' },
              vehicle: { type: 'string', description: 'Vehicle type when enabling preparation' },
            },
          },
        },
      }),
      description: 'Admin only. Decisions are accept, reroute, ready, or enable-preparation.',
      responses: {
        200: response('Assignment updated'),
        400: response('Invalid assignment ID or decision'),
        401: response('Authentication required'),
        403: response('Admin access required'),
        404: response('Assignment not found'),
        409: response('Assignment cannot be updated in its current state'),
        500: response('Assignment could not be updated'),
      },
    },
  },
  '/api/v1/stores/admin/dispatch-batches': {
    post: {
      ...operation('Create a delivery dispatch batch as an admin', 'Store inventory', {
        success: '201',
        requestBody: {
          schema: {
            type: 'object',
            required: ['orderIds'],
            properties: {
              orderIds: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                uniqueItems: true,
                items: { type: 'string' },
              },
            },
          },
        },
      }),
      description: 'Admin only. Select 1-20 distinct ready packages with the same required delivery vehicle. Driver assignment starts asynchronously.',
      responses: {
        201: {
          description: 'Dispatch batch created',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  batchId: { type: 'string' },
                  orderIds: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        400: response('Select 1-20 distinct valid ready packages'),
        401: response('Authentication required'),
        403: response('Admin access required'),
        409: response('Packages are not eligible for a dispatch batch'),
        500: response('Dispatch batch could not be created'),
      },
    },
  },
  '/api/v1/stores/me/dispatch-batches': {
    post: {
      ...operation('Create a delivery dispatch batch for the authenticated store', 'Store inventory', {
        success: '201',
        requestBody: {
          schema: {
            type: 'object',
            required: ['orderIds'],
            properties: {
              orderIds: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                uniqueItems: true,
                items: { type: 'string' },
              },
            },
          },
        },
      }),
      description: 'Requires ownership of the selected store packages. Select 1-20 distinct ready packages with the same required delivery vehicle. Driver assignment starts asynchronously.',
      responses: {
        201: {
          description: 'Dispatch batch created',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  batchId: { type: 'string' },
                  orderIds: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        400: response('Select 1-20 distinct valid ready packages'),
        401: response('Authentication required'),
        403: response('Store owner access required'),
        409: response('Packages are not eligible for a dispatch batch'),
        500: response('Dispatch batch could not be created'),
      },
    },
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
