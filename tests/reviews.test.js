const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { reviewSettings, validateReviewInput, reviewContext, participantProfile } = require('../helpers/reviews');
const router = require('../routers/reviews');
const rideRouter = require('../routers/rides');
const { reviewSchema } = require('../models/review');
const { userSchema } = require('../models/user');
const id = (number) => number.toString(16).padStart(24, '0');
const customer = id(1), driverUser = id(2), driverId = id(3), transaction = id(4), product = id(5);
const query = (value) => ({
  lean: async () => value, select() { return this; }, populate() { return this; },
  sort() { return this; }, limit() { return this; },
});
function fixture() {
  const features = { products: true, deliveries: true, rides: true, services: true };
  const records = [];
  const data = {
    order: { _id: transaction, user: customer, status: '3', deliveryStatus: 'Delivered', store: id(6), orderItems: [{ product }] },
    service: { _id: transaction, customer, status: 'completed' },
    ride: { _id: transaction, user: customer, driver: driverId, status: 'completed' },
    driver: { _id: driverId, user: driverUser },
  };
  let currentAdmin = false;
  let disableDuringWrite = false;
  const models = {
    SiteSetting: {
      findOne: () => query({ reviewFeatures: { ...features } }),
      findOneAndUpdate: async (filter, update) => {
        if (update.$inc) {
          if (disableDuringWrite || !features[Object.keys(filter)[1].split('.')[1]]) return null;
          return { reviewFeatures: features };
        }
        for (const [key, value] of Object.entries(update.$set)) if (key.startsWith('reviewFeatures.')) features[key.split('.')[1]] = value;
        return {};
      },
    },
    Order: { findById: () => query(data.order) },
    Ride: { findById: () => query(data.ride) },
    Driver: { findById: () => query(data.driver) },
    ServiceRequest: { findById: () => query(data.service) },
    User: {
      findOne: () => query(currentAdmin ? { _id: customer } : null),
      findById: () => query({ _id: new mongoose.Types.ObjectId(customer), name: 'Customer', rideProfilePhotoUrl: '', ridePhotoPromptedAt: null }),
      findByIdAndUpdate: (key, update) => query({ _id: new mongoose.Types.ObjectId(key), name: 'Customer',
        rideProfilePhotoUrl: update.$set.rideProfilePhotoUrl || '' }),
    },
    Review: {
      createIndexes: async () => {},
      db: { transaction: async (action) => action({}) },
      create: async ([record]) => {
        if (records.some((saved) => ['kind', 'author', 'transaction', 'subject'].every((key) => String(saved[key]) === String(record[key])))) {
          throw Object.assign(new Error('duplicate'), { code: 11000 });
        }
        const saved = { ...record, _id: id(10 + records.length), dateCreated: new Date() };
        records.push(saved);
        return [saved];
      },
      findOne: (filter) => query(records.find((record) => Object.entries(filter).every(([key, value]) => String(record[key]) === String(value))) || null),
      find: () => query(records),
      aggregate: async () => [{ average: 4, count: records.length }],
    },
    Product: { exists: async () => ({ _id: product }), updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }) },
  };
  return { models, data, features, records, admin: () => { currentAdmin = true; }, disableWrite: () => { disableDuringWrite = true; } };
}
async function call(path, method, fixture, { userId = customer, body = {}, query: params = {} } = {}, routes = router) {
  const layer = routes.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `${method} ${path}`);
  const req = { auth: userId ? { userId } : undefined, body, query: params, dbModels: fixture.models };
  const res = { code: 200, set() { return this; }, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await layer.route.stack[0].handle(req, res);
  return res;
}

test('regional review switches default off and fail explicitly if settings cannot be read', async () => {
  assert.deepEqual(await reviewSettings({ SiteSetting: { findOne: () => query(null) } }),
    { products: false, deliveries: false, rides: false, services: false });
  const broken = fixture();
  broken.models.SiteSetting.findOne = () => { throw new Error('offline'); };
  assert.equal((await call('/settings', 'get', broken)).code, 500);
});

test('strict review shape enforces exact star and comment limits and rejects forged fields', () => {
  const body = { kind: 'product', transaction, product, rating: 5, comment: 'a'.repeat(2000) };
  assert.doesNotThrow(() => validateReviewInput(body));
  for (const changes of [
    { rating: 0 }, { rating: 6 }, { rating: 1.5 }, { rating: '5' }, { rating: NaN },
    { comment: 'a'.repeat(2001) }, { comment: [] }, { transaction: 'bad' },
    { kind: '__proto__' }, { author: driverUser }, { subject: driverId }, { product: id(0).slice(1) },
  ]) assert.throws(() => validateReviewInput({ ...body, ...changes }), /valid transaction/);
});

test('products and delivery require ownership, delivered status and the actual purchased product', async () => {
  const f = fixture();
  assert.equal((await reviewContext(f.models, customer, 'product', transaction, product)).subject, product);
  assert.equal((await reviewContext(f.models, customer, 'delivery', transaction)).subject, transaction);
  await assert.rejects(reviewContext(f.models, driverUser, 'product', transaction, product), /Order not found/);
  await assert.rejects(reviewContext(f.models, customer, 'product', transaction, id(99)), /not in your order/);
  f.data.order.status = 'Pending'; f.data.order.deliveryStatus = 'Pending';
  await assert.rejects(reviewContext(f.models, customer, 'delivery', transaction), /delivered/);
});

test('service fulfillment requires the owning customer and completed status', async () => {
  const f = fixture();
  assert.equal((await reviewContext(f.models, customer, 'service', transaction)).subject, transaction);
  await assert.rejects(reviewContext(f.models, driverUser, 'service', transaction), /not found/);
  f.data.service.status = 'in_progress';
  await assert.rejects(reviewContext(f.models, customer, 'service', transaction), /completed/);
});

test('ride participants can review each other once per completed ride, never themselves or strangers', async () => {
  const f = fixture();
  assert.equal((await reviewContext(f.models, customer, 'rideDriver', transaction)).subject, driverId);
  assert.equal((await reviewContext(f.models, driverUser, 'rideCustomer', transaction)).subject, customer);
  for (const [user, kind] of [[driverUser, 'rideDriver'], [customer, 'rideCustomer'], [id(99), 'rideCustomer']]) {
    await assert.rejects(reviewContext(f.models, user, kind, transaction), /participants/);
  }
  for (const status of ['assigned', 'onboard', 'cancelled', 'terminated']) {
    f.data.ride.status = status;
    await assert.rejects(reviewContext(f.models, customer, 'rideDriver', transaction), /completed/);
  }
  f.data.ride.status = 'completed'; f.data.driver.user = customer;
  await assert.rejects(reviewContext(f.models, customer, 'rideDriver', transaction), /yourself/);
});

test('review writes derive all ownership server-side and prevent duplicates including concurrent writes', async () => {
  const f = fixture();
  const updates = [];
  f.models.Product.updateOne = async (filter, update, options) => {
    updates.push({ filter, update, options });
    return { matchedCount: 1 };
  };
  const body = { kind: 'product', transaction, product, rating: 4, comment: '  Great  ' };
  const results = await Promise.all([call('/', 'post', f, { body }), call('/', 'post', f, { body })]);
  assert.deepEqual(results.map((result) => result.code).sort(), [201, 409]);
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].author, customer);
  assert.equal(f.records[0].comment, 'Great');
  assert.equal(updates[0].filter._id, product);
  assert.equal(updates[0].update.$set.verifiedRating, 4);
  assert.equal(updates[0].update.$set.verifiedReviewCount, 1);
  assert.ok(updates[0].options.session);
  assert.equal((await call('/context', 'get', f, { query: { kind: 'product', transaction, product } })).body.review.rating, 4);
  assert.equal((await call('/', 'post', f, { userId: null, body })).code, 401);
});

test('enabling a switch fails explicitly if the duplicate-prevention index cannot be installed', async () => {
  const f = fixture();
  f.admin(); f.features.products = false;
  f.models.Review.createIndexes = async () => { throw new Error('Index build failed'); };
  assert.equal((await call('/settings', 'put', f, { body: { products: true } })).code, 500);
  assert.equal(f.features.products, false);
});

test('separate switches block reads and writes while retaining reviews for re-enable', async () => {
  const f = fixture();
  const body = { kind: 'delivery', transaction, rating: 3 };
  assert.equal((await call('/', 'post', f, { body })).code, 201);
  assert.equal((await call('/settings', 'put', f, { body: { deliveries: false } })).code, 403);
  f.admin();
  assert.equal((await call('/settings', 'put', f, { body: { deliveries: 'false' } })).code, 400);
  assert.equal((await call('/settings', 'put', f, { body: { deliveries: false } })).code, 200);
  assert.equal(f.features.products, true);
  assert.equal((await call('/context', 'get', f, { query: { kind: 'delivery', transaction } })).code, 403);
  assert.equal((await call('/', 'post', f, { body })).code, 403);
  assert.equal(f.records.length, 1);
  await call('/settings', 'put', f, { body: { deliveries: true } });
  assert.equal((await call('/context', 'get', f, { query: { kind: 'delivery', transaction } })).body.review.rating, 3);
  f.disableWrite();
  assert.equal((await call('/', 'post', f, { body: { kind: 'service', transaction, rating: 5 } })).code, 403);
  assert.equal(f.records.length, 1);
});

test('new review unique index excludes legacy store reviews and schema requires participant identifiers', () => {
  const index = reviewSchema.indexes().find(([, options]) => options.unique);
  assert.deepEqual(index[1].partialFilterExpression, { kind: { $type: 'string' } });
  const Model = mongoose.model('ReviewTest', reviewSchema);
  assert.equal(new Model({ customer, product, store: id(6), rating: 5 }).validateSync(), undefined);
  assert.ok(new Model({ kind: 'rideDriver', rating: 5 }).validateSync().errors.author);
  assert.equal(new Model({ kind: 'rideCustomer', transaction, author: driverUser, subject: customer, rating: 5 }).validateSync(), undefined);
});

test('customer photos are private in generic user serialization, optional and validated in the ride endpoint', async () => {
  for (const key of ['rideProfilePhotoUrl', 'ridePhotoPromptedAt', 'rideProfilePhotoUpdatedAt']) assert.equal(userSchema.path(key).options.select, false);
  const Model = mongoose.model('ReviewUserTest', userSchema);
  const serialized = new Model({ _id: new mongoose.Types.ObjectId(customer), name: 'Customer', email: 'customer@example.test',
    rideProfilePhotoUrl: 'https://example.test/private.jpg' }).toJSON();
  assert.equal(serialized.rideProfilePhotoUrl, undefined);
  const f = fixture();
  assert.equal((await call('/me/customer-profile', 'put', f, { body: { skip: true } }, rideRouter)).body.prompted, true);
  assert.equal((await call('/me/customer-profile', 'put', f, { body: { profilePhotoUrl: 'http://example.test/image.jpg' } }, rideRouter)).code, 409);
  const result = await call('/me/customer-profile', 'put', f, { body: { profilePhotoUrl: 'https://res.cloudinary.com/demo/image/upload/v1/photo.jpg' } }, rideRouter);
  assert.equal(result.code, 200);
  assert.match(result.body.profilePhotoUrl, /photo.jpg$/);
  assert.equal((await call('/me/customer-profile', 'get', f, { userId: null }, rideRouter)).code, 401);
});

test('participant summaries expose ratings and latest text only while rides reviews are enabled', async () => {
  const f = fixture();
  const person = { _id: new mongoose.Types.ObjectId(customer), name: 'Customer', rideProfilePhotoUrl: 'photo' };
  f.records.push({ rating: 4, comment: 'Polite', dateCreated: new Date() });
  const enabled = await participantProfile(f.models, 'rideCustomer', person);
  assert.equal(enabled.rating.average, 4);
  assert.equal(enabled.reviews[0].comment, 'Polite');
  assert.equal(enabled.profilePhotoUrl, 'photo');
  assert.equal(enabled.joinedAt.toISOString(), person._id.getTimestamp().toISOString());
  f.features.rides = false;
  const disabled = await participantProfile(f.models, 'rideCustomer', person);
  assert.equal(disabled.rating, null);
  assert.deepEqual(disabled.reviews, []);
});
