const router = require('express').Router();
const { FEATURES, KINDS, fail, reviewSettings, requireReviews, validateReviewInput, reviewContext, ratingSummary } = require('../helpers/reviews');

const endpoint = (action) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { await action(req, res); }
  catch (error) {
    console.error('Review request failed:', error.message);
    res.status(error.code === 11000 ? 409 : error.status || 500).json({
      message: error.code === 11000 ? 'You already reviewed this transaction.' : error.status ? error.message : 'Unable to complete the review request. Please retry.',
    });
  }
};
function signedIn(req) {
  if (!req.auth?.userId) throw fail('Sign in to review.', 401);
}
async function requireAdmin(req) {
  signedIn(req);
  const admin = await req.dbModels.User.findOne({ _id: req.auth.userId, isAdmin: true }).select('_id').lean();
  if (!admin) throw fail('Admin access required.', 403);
}

router.get('/settings', endpoint(async (req, res) => res.json(await reviewSettings(req.dbModels))));
router.put('/settings', endpoint(async (req, res) => {
  await requireAdmin(req);
  if (!req.body || !Object.keys(req.body).length ||
      Object.entries(req.body).some(([key, value]) => !FEATURES.includes(key) || typeof value !== 'boolean')) {
    throw fail('Supply boolean products, deliveries, rides or services switches.');
  }
  if (Object.values(req.body).some((enabled) => enabled)) await req.dbModels.Review.createIndexes();
  await req.dbModels.SiteSetting.findOneAndUpdate({ key: 'reviews' },
    { $set: { ...Object.fromEntries(Object.entries(req.body).map(([key, value]) => [`reviewFeatures.${key}`, value])), updatedBy: req.auth.userId } },
    { upsert: true, runValidators: true });
  res.json(await reviewSettings(req.dbModels));
}));
router.get('/admin', endpoint(async (req, res) => {
  await requireAdmin(req);
  if (typeof req.query.kind !== 'string' || !Object.hasOwn(KINDS, req.query.kind)) throw fail('Choose a review type.');
  await requireReviews(req.dbModels, req.query.kind);
  const reviews = await req.dbModels.Review.find({ kind: req.query.kind })
    .select('kind transaction product rating comment dateCreated').sort({ dateCreated: -1 }).limit(100).lean();
  res.json({ reviews });
}));
router.get('/products/:id', endpoint(async (req, res) => {
  await requireReviews(req.dbModels, 'product');
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw fail('Invalid product.');
  if (!await req.dbModels.Product.exists({ _id: req.params.id })) throw fail('Product not found.', 404);
  const [rating, reviews] = await Promise.all([
    ratingSummary(req.dbModels, 'product', req.params.id),
    req.dbModels.Review.find({ kind: 'product', product: req.params.id }).select('rating comment dateCreated').sort({ dateCreated: -1 }).limit(50).lean(),
  ]);
  res.json({ rating, reviews });
}));
router.get('/context', endpoint(async (req, res) => {
  signedIn(req);
  const context = await reviewContext(req.dbModels, req.auth.userId, req.query.kind, req.query.transaction, req.query.product);
  const review = await req.dbModels.Review.findOne({ kind: context.kind, transaction: context.transaction,
    author: context.author, subject: context.subject }).select('rating comment dateCreated').lean();
  res.json({ review });
}));
router.post('/', endpoint(async (req, res) => {
  signedIn(req);
  validateReviewInput(req.body);
  const context = await reviewContext(req.dbModels, req.auth.userId, req.body.kind, req.body.transaction, req.body.product);
  const review = await req.dbModels.Review.db.transaction(async (session) => {
    // Serialize submissions with switch changes, including an in-flight disable.
    const enabled = await req.dbModels.SiteSetting.findOneAndUpdate({
      key: 'reviews', [`reviewFeatures.${KINDS[context.kind]}`]: true,
    }, { $inc: { reviewWriteVersion: 1 } }, { session });
    if (!enabled) throw fail('This review feature is disabled.', 403);
    const [saved] = await req.dbModels.Review.create([{ ...context, rating: req.body.rating, comment: req.body.comment?.trim() || '' }], { session });
    if (context.kind === 'product') {
      const summary = await ratingSummary(req.dbModels, 'product', context.subject, session);
      const updated = await req.dbModels.Product.updateOne({ _id: context.subject },
        { $set: { rating: summary.average, numReviews: summary.count,
          verifiedRating: summary.average, verifiedReviewCount: summary.count } }, { session });
      if (updated.matchedCount === 0) throw fail('This product is no longer available to review.', 404);
    }
    return saved;
  });
  res.status(201).json({ review: { rating: review.rating, comment: review.comment, dateCreated: review.dateCreated } });
}));
module.exports = router;
