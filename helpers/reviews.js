const mongoose = require('mongoose');

const FEATURES = ['products', 'deliveries', 'rides', 'services'];
const KINDS = { product: 'products', delivery: 'deliveries', rideDriver: 'rides', rideCustomer: 'rides', service: 'services' };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const same = (left, right) => String(left?._id || left) === String(right?._id || right);
const validId = (value) => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

async function reviewSettings(models) {
  const setting = await models.SiteSetting.findOne({ key: 'reviews' }).lean();
  return Object.fromEntries(FEATURES.map((key) => [key, setting?.reviewFeatures?.[key] === true]));
}

async function requireReviews(models, kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) throw fail('Unknown review type.');
  if (!(await reviewSettings(models))[KINDS[kind]]) throw fail('This review feature is disabled.', 403);
}

function validateReviewInput(body) {
  if (!body || Array.isArray(body) || Object.keys(body).some((key) => !['kind', 'transaction', 'product', 'rating', 'comment'].includes(key)) ||
      typeof body.kind !== 'string' || !Object.hasOwn(KINDS, body.kind) || !validId(body.transaction) ||
      (body.kind === 'product' && !validId(body.product)) ||
      (body.kind !== 'product' && body.product !== undefined) ||
      !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5 ||
      (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.trim().length > 2000))) {
    throw fail('Use a valid transaction, 1-5 whole stars and at most 2000 characters of text.');
  }
}

async function reviewContext(models, userId, kind, transaction, product) {
  if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind) || !validId(transaction) || (kind === 'product' && !validId(product))) {
    throw fail('Invalid review type or transaction.');
  }
  await requireReviews(models, kind);
  let record, subject, customer, store;
  if (kind === 'product' || kind === 'delivery') {
    record = await models.Order.findById(transaction).populate('orderItems').lean();
    if (!record || !same(record.user, userId)) throw fail('Order not found.', 404);
    if (record.fulfillmentStatus === 'cancelled' || record.status === 'Cancelled' ||
        (record.deliveryStatus !== 'Delivered' && !['Delivered', '3'].includes(record.status))) throw fail('Reviews require a delivered order.', 409);
    customer = userId; store = record.store || null;
    if (kind === 'product') {
      if (!record.orderItems.some((item) => same(item?.product, product))) throw fail('This product is not in your order.', 403);
      subject = product;
    } else subject = record._id;
  } else if (kind === 'service') {
    record = await models.ServiceRequest.findById(transaction).lean();
    if (!record || !same(record.customer, userId)) throw fail('Service request not found.', 404);
    if (record.status !== 'completed') throw fail('Reviews require a completed service request.', 409);
    customer = userId; subject = record._id;
  } else {
    record = await models.Ride.findById(transaction).lean();
    if (!record) throw fail('Ride not found.', 404);
    const driver = record.driver && await models.Driver.findById(record.driver).lean();
    if (!driver || (kind === 'rideDriver' ? !same(record.user, userId) : !same(driver.user, userId))) {
      throw fail('Only the ride participants may review this ride.', 403);
    }
    if (same(record.user, driver.user)) throw fail('You cannot review yourself.', 403);
    if (record.status !== 'completed') throw fail('Reviews require a completed ride.', 409);
    subject = kind === 'rideDriver' ? driver._id : record.user;
    customer = record.user;
  }
  return { kind, transaction: record._id, author: userId, subject, customer, store,
    ...(kind === 'product' ? { product, order: record._id } : {}) };
}

async function ratingSummary(models, kind, subject, session) {
  const [result] = await models.Review.aggregate([
    { $match: { kind, subject: new mongoose.Types.ObjectId(String(subject)) } },
    { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
  ], session ? { session } : {});
  return { average: result?.average || 0, count: result?.count || 0 };
}

async function participantProfile(models, kind, person) {
  if (!person) return null;
  const enabled = (await reviewSettings(models)).rides;
  const reviews = enabled ? await models.Review.find({ kind, subject: person._id })
    .select('rating comment dateCreated').sort({ dateCreated: -1 }).limit(10).lean() : [];
  return { name: person.name, profilePhotoUrl: kind === 'rideCustomer' ? person.rideProfilePhotoUrl || '' : person.profilePhotoUrl || '',
    joinedAt: person.joinedAt || person.dateCreated || person.createdAt || person._id?.getTimestamp?.() || null,
    rating: enabled ? await ratingSummary(models, kind, person._id) : null, reviews };
}

module.exports = { FEATURES, KINDS, fail, reviewSettings, requireReviews, validateReviewInput, reviewContext, ratingSummary, participantProfile };
