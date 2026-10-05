const assert = require("node:assert/strict");
const test = require("node:test");
const storeRouter = require("../routers/stores");
const orderRouter = require("../routers/orders");
const driverRouter = require("../routers/drivers");
const productRouter = require("../routers/products");

function query(value, onSelect = () => {}) {
  let fields;
  const chain = {
    select(selection) {
      fields = selection.split(" ");
      onSelect(fields);
      return chain;
    },
    populate() { return chain; },
    sort() { return chain; },
    limit(limit) {
      if (Array.isArray(value)) value = value.slice(0, limit);
      return chain;
    },
    lean() { return chain; },
    then(resolve, reject) {
      const project = (entry) => fields && entry
        ? Object.fromEntries(fields.filter((key) => key in entry).map((key) => [key, entry[key]]))
        : entry;
      return Promise.resolve(Array.isArray(value) ? value.map(project) : project(value)).then(resolve, reject);
    },
  };
  return chain;
}

function handler(router, path, method) {
  const route = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]).route;
  return route.stack.at(-1).handle;
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

test("AdminStore product queue includes every unanswered product on its active assigned orders", async () => {
  const storeId = "company";
  const nearbyPartner = {
    _id: "partner", isCompanyOwned: false, isOpen: true, approvalStatus: "approved",
    location: { coordinates: [0.01, 0] },
  };
  const products = [
    { _id: "company-owned", store: { _id: storeId, isCompanyOwned: true, location: { coordinates: [0, 0] } } },
    { _id: "unassigned", store: null },
    { _id: "ordered-partner", store: nearbyPartner },
    { _id: "unrelated-partner", store: nearbyPartner },
    { _id: "ready", store: null, companyStoreResponses: [{ store: storeId, status: "ready" }] },
  ];
  for (const location of [{ coordinates: [0, 0] }, null]) {
    const req = {
      auth: { userId: "company-owner" }, query: {},
      dbModels: {
        Store: { findOne: () => query({ _id: storeId, location }) },
        Order: { find: (filter) => {
          assert.equal(filter.store, storeId);
          assert.deepEqual(filter.status.$nin, ["3", "4", "Delivered", "Cancelled"]);
          assert.equal(filter.deliveryStatus.$ne, "Delivered");
          return query([{ orderItems: [{ product: "ordered-partner" }, null] }]);
        } },
        Product: { find: (filter) => {
          assert.equal(filter.approvalStatus, "approved");
          assert.equal(filter["companyStoreResponses.store"].$ne, storeId);
          return query(products.filter((product) =>
            !product.companyStoreResponses?.some((entry) => entry.store === storeId)));
        } },
      },
    };
    const res = response();
    await handler(productRouter, "/company/my-products", "get")(req, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.products.some((product) => product._id === "ordered-partner"));
    assert.ok(res.body.products.some((product) => product._id === "company-owned"));
    assert.ok(res.body.products.some((product) => product._id === "unassigned"));
    assert.ok(!res.body.products.some((product) => product._id === "ready"));
    if (location) assert.ok(!res.body.products.some((product) => product._id === "unrelated-partner"));
  }
});

test("admin and company product lists both retain nearby company-owned products", async () => {
  const products = [
    { _id: "owned", store: { isCompanyOwned: true, location: { coordinates: [0, 0] } } },
    { _id: "nearby-partner", store: { isCompanyOwned: false, location: { coordinates: [0.01, 0] } } },
    { _id: "unassigned", store: null },
  ];
  const req = {
    query: { latitude: "0", longitude: "0" },
    dbModels: { Product: { find: () => query(products) } },
  };
  const res = response();
  await handler(productRouter, "/admin/company-fulfillable", "get")(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.products.map((product) => product._id), ["owned", "unassigned"]);
});

test("store dashboard returns pending scheduled orders and keeps completed-sales metrics unchanged", async () => {
  const storeId = "store-a";
  const dateOrdered = new Date(Date.now() - 60_000);
  const scheduledFor = new Date(Date.now() + 86_400_000);
  const pending = {
    _id: "pending-order",
    status: "1",
    deliveryStatus: "Pending",
    deliveryMode: "SCHEDULED",
    scheduledFor,
    deliveryWindowStart: scheduledFor,
    deliveryWindowEnd: new Date(scheduledFor.getTime() + 7_200_000),
    dateOrdered,
    totalPrice: 25,
    deliveryFee: 5,
    orderItems: [{ quantity: 2, product: { _id: "product-a", name: "Apples", price: 10, store: storeId } }],
  };
  const completed = { ...pending, _id: "completed-order", status: "3", deliveryStatus: "Delivered", deliveredAt: dateOrdered };
  let orderQueryCount = 0;
  const req = {
    auth: { userId: "owner-a" },
    dbModels: {
      Store: { findOne(filter) {
        assert.deepEqual(filter, { owner: "owner-a", isCompanyOwned: true });
        return query({ _id: storeId, name: "Company store" });
      } },
      Product: { find: () => query([]), countDocuments: async () => 0 },
      OrderItem: { find: () => query([]) },
      Order: { find(filter) {
        assert.deepEqual((filter.$and?.[0] || filter).$or[0], { store: storeId });
        orderQueryCount += 1;
        if (filter.$and) return query([completed]);
        if (filter.dateOrdered) return query([pending, completed]);
        if (filter.deliveryStatus?.$ne) return query([pending]);
        return query([pending, completed], (fields) => {
          for (const field of ["scheduledFor", "deliveryMode", "orderItems", "status", "dateOrdered"]) {
            assert.ok(fields.includes(field));
          }
        });
      } },
      Review: { find: () => query([]) },
      Payout: { find: () => query([]) },
    },
  };
  const res = response();
  await handler(storeRouter, "/me/dashboard", "get")(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(orderQueryCount, 4);
  assert.equal(res.body.periods.daily.orders, 2);
  assert.equal(res.body.periods.daily.completedOrders, 1);
  assert.equal(res.body.periods.daily.sales, 20);
  assert.equal(res.body.orders.pending, 1);
  assert.equal(res.body.recentOrders.length, 2);
  assert.equal(res.body.recentOrders[0]._id, pending._id);
  assert.deepEqual(res.body.recentOrders[0].scheduledFor, scheduledFor);
  assert.deepEqual(res.body.recentOrders[0].scheduledDeliveryDate, scheduledFor);
  assert.equal(res.body.recentOrders[0].completedAt, null);
  assert.equal(res.body.recentOrders[0].orderItems[0].product.name, "Apples");
  assert.equal(res.body.recentCompletedOrders.length, 1);
  assert.equal(res.body.activeOrders.length, 1);
  assert.equal(res.body.activeOrders[0]._id, pending._id);
});

test("admin recent sales include schedule metadata selected from the database", async () => {
  const dateOrdered = new Date(Date.now() - 60_000);
  const scheduledFor = new Date(Date.now() - 120_000);
  const completed = {
    _id: "completed",
    status: "3",
    deliveryStatus: "Delivered",
    deliveryMode: "SCHEDULED",
    scheduledFor,
    dateOrdered,
    deliveredAt: dateOrdered,
    orderItems: [{ quantity: 1 }],
    itemsSubtotal: 10,
    totalPrice: 15,
    deliveryFee: 5,
  };
  const req = { dbModels: {
    Order: {
      find: (filter) => query([completed]),
      countDocuments: async () => 0,
    },
    Product: { find: () => query([]) },
    Payout: { find: () => query([]) },
  } };
  const res = response();
  await handler(orderRouter, "/admin/dashboard", "get")(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.recentSales[0].scheduledFor, scheduledFor);
  assert.deepEqual(res.body.recentSales[0].scheduledDeliveryDate, scheduledFor);
  assert.equal(res.body.recentSales[0].totalSales, 15);
});

test("checkout store aliases are validated instead of being silently discarded", async () => {
  for (const key of ["store", "storeId", "pickupStoreId"]) {
    const req = { auth: { userId: "customer" }, dbModels: {}, body: { [key]: "invalid-store" } };
    const res = response();
    await handler(orderRouter, "/", "post")(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message, "Invalid store id.");
  }
});

test("company-driver deliveries and assigned queues retain scheduled dates", async () => {
  const scheduledFor = new Date(Date.now() + 86_400_000);
  const order = {
    _id: "scheduled-order",
    companyOfferDriver: "driver-a",
    driver: "driver-a",
    deliveryMode: "SCHEDULED",
    scheduledFor,
    deliveryWindowStart: scheduledFor,
    deliveryWindowEnd: new Date(scheduledFor.getTime() + 7_200_000),
    deliveryStatus: "Driver Assigned",
    store: { _id: "store-a", name: "Company store", location: { coordinates: [38, 9] } },
    orderItems: [],
  };
  const driver = { _id: "driver-a", isCompanyOwned: true, location: { coordinates: [38, 9] } };
  const req = {
    auth: { userId: "driver-user" },
    query: {},
    dbModels: {
      Driver: {
        findOne: (filter) => query(filter.user ? driver : null),
        find: (filter) => query(filter.isCompanyOwned === true ? [driver] : []),
      },
      Order: { find: () => query([order]), countDocuments: async () => 0 },
    },
  };
  const deliveries = response();
  await handler(orderRouter, "/company/my-deliveries", "get")(req, deliveries);
  assert.equal(deliveries.statusCode, 200);
  assert.deepEqual(deliveries.body.orders[0].scheduledFor, scheduledFor);
  assert.deepEqual(deliveries.body.orders[0].scheduledDeliveryDate, scheduledFor);

  const queue = response();
  await handler(driverRouter, "/me/queue", "get")(req, queue);
  assert.equal(queue.statusCode, 200);
  assert.deepEqual(queue.body.queue[0].scheduledFor, scheduledFor);
  assert.deepEqual(queue.body.queue[0].deliveryWindowEnd, order.deliveryWindowEnd);
});

test("store dashboard limits recent orders to twenty without adding pending orders to revenue", async () => {
  const orders = Array.from({ length: 25 }, (_, index) => ({
    _id: `order-${index}`,
    status: "1",
    deliveryStatus: "Pending",
    dateOrdered: new Date(Date.now() - (index === 24 ? 400 : 0) * 86_400_000),
    itemsSubtotal: 100,
    totalPrice: 105,
    deliveryFee: 5,
    orderItems: [],
  }));
  const req = {
    auth: { userId: "store-owner" },
    dbModels: {
      Store: { findOne: () => query({ _id: "store-a", name: "Store" }) },
      Product: { find: () => query([]), countDocuments: async () => 0 },
      OrderItem: { find: () => query([]) },
      Order: { find: (filter) => {
        assert.deepEqual((filter.$and?.[0] || filter).$or[0], { store: "store-a" });
        if (filter.deliveryStatus?.$ne) {
          assert.equal(filter.dateOrdered, undefined);
          return query(orders);
        }
        return query(filter.$and ? [] : filter.dateOrdered ? orders.slice(0, 24) : orders);
      } },
      Review: { find: () => query([]) },
      Payout: { find: () => query([]) },
    },
  };
  const res = response();
  await handler(storeRouter, "/me/dashboard", "get")(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.recentOrders.length, 20);
  assert.equal(res.body.periods.daily.sales, 0);
  assert.equal(res.body.periods.daily.completedOrders, 0);
  assert.equal(res.body.orders.pending, 25);
  assert.equal(res.body.activeOrders.length, 25);
  assert.equal(res.body.activeOrders[24]._id, "order-24");
});

test("company dashboard includes ready-product orders without crediting unrelated items or rejected products", async () => {
  const storeId = "company-store";
  const dateOrdered = new Date(Date.now() - 60_000);
  const products = [
    { _id: "ready", store: "partner-store", companyStoreResponses: [{ store: storeId, status: "ready" }] },
    { _id: "owned", store: storeId, companyStoreResponses: [] },
    { _id: "rejected", store: "partner-store", companyStoreResponses: [{ store: storeId, status: "rejected" }] },
    { _id: "other-ready", store: "partner-store", companyStoreResponses: [{ store: "other-company", status: "ready" }] },
  ];
  const orderItems = products.map((product) => ({
    _id: `item-${product._id}`, quantity: 2, product: { ...product, name: product._id, price: 10 },
  }));
  const mixed = {
    _id: "mixed", store: "partner-store", dateOrdered, deliveredAt: dateOrdered,
    status: "3", deliveryStatus: "Delivered", totalPrice: 65, deliveryFee: 5,
    orderItems: [orderItems[0], orderItems[2], orderItems[3]],
  };
  const orders = [
    mixed,
    { ...mixed, _id: "unassigned", store: null, status: "1", deliveryStatus: "Pending", deliveredAt: null },
    { ...mixed, _id: "owned-order", store: "partner-store", orderItems: [orderItems[1]] },
    { ...mixed, _id: "unrelated", orderItems: [orderItems[2], orderItems[3]] },
    { ...mixed, _id: "assigned", store: storeId, orderItems: [] , itemsSubtotal: 30 },
  ];
  const req = {
    auth: { userId: "owner" },
    dbModels: {
      Store: { findOne: () => query({ _id: storeId, name: "Company store" }) },
      Product: {
        find: (filter) => {
          if (!filter.$or) return query(products.filter((product) => product.store === filter.store));
          assert.deepEqual(filter.$or, [
            { store: storeId },
            { companyStoreResponses: { $elemMatch: { store: storeId, status: "ready" } } },
          ]);
          return query(products.filter((product) => product.store === storeId ||
            product.companyStoreResponses.some((entry) => entry.store === storeId && entry.status === "ready")));
        },
        countDocuments: async () => 1,
      },
      OrderItem: { find: (filter) => {
        assert.deepEqual(filter.product.$in, ["ready", "owned"]);
        return query(orderItems.filter((item) => filter.product.$in.includes(item.product._id)));
      } },
      Order: { find: (filter) => {
        const scope = filter.$and?.[0] || filter;
        assert.deepEqual(scope.$or, [
          { store: storeId }, { orderItems: { $in: ["item-ready", "item-owned"] } },
        ]);
        const scoped = orders.filter((order) => order.store === storeId ||
          order.orderItems.some((item) => scope.$or[1].orderItems.$in.includes(item._id)));
        return query(filter.$and ? scoped.filter((order) => order.status === "3") :
          filter.deliveryStatus?.$ne ? scoped.filter((order) => order.deliveryStatus !== "Delivered") : scoped);
      } },
      Review: { find: () => query([]) },
      Payout: { find: () => query([{ amount: 10, status: "paid" }, { amount: 5, status: "pending" }]) },
    },
  };
  const res = response();
  await handler(storeRouter, "/me/dashboard", "get")(req, res);
  assert.equal(res.statusCode, 200);
  for (const period of Object.values(res.body.periods)) {
    assert.equal(period.orders, 4);
    assert.equal(period.completedOrders, 3);
    assert.equal(period.sales, 70);
    assert.equal(period.earnings, 70);
    assert.equal(period.unitsSold, 4);
    assert.equal(period.averageOrder, 70 / 3);
  }
  assert.equal(res.body.orders.pending, 1);
  assert.equal(res.body.payouts.available, 55);
  assert.equal(res.body.products.total, 1);
  assert.equal(res.body.products.readyFulfillments, 1);
  assert.equal(res.body.recentOrders.length, 4);
  assert.equal(res.body.recentOrders[0].sales, 20);
  assert.equal(res.body.recentOrders[0].units, 2);
  assert.equal(res.body.recentOrders[0].orderItems.length, 1);
  assert.equal(res.body.recentOrders[0].orderItems[0].product._id, "ready");
});

test("status updates can echo elapsed scheduled dates without resetting dispatch metadata", async () => {
  const scheduledFor = new Date(Date.now() - 86_400_000);
  const current = {
    _id: "507f1f77bcf86cd799439011",
    status: "1",
    deliveryMode: "SCHEDULED",
    scheduledFor,
    dispatchStatus: "driver_assigned",
    deliveryFee: 5,
    deliveryDistanceKm: 0,
    totalPrice: 25,
  };
  let savedFields;
  const req = {
    params: { id: current._id },
    body: {
      status: "3",
      deliveryMode: "SCHEDULED",
      scheduledFor: scheduledFor.toISOString(),
      scheduledDeliveryDate: scheduledFor.toISOString(),
    },
    dbModels: { Order: {
      findById: () => query(current),
      findByIdAndUpdate: async (id, fields) => {
        savedFields = fields;
        return { ...current, ...fields };
      },
    } },
    app: { get: () => null },
  };
  const res = response();
  await handler(orderRouter, "/:id", "put")(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(savedFields, { status: "3" });
  assert.equal(res.body.dispatchStatus, "driver_assigned");
});
