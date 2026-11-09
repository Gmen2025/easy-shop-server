const cloudinary = require("cloudinary").v2;
const { ratingSummary } = require("./reviews");

const TERMINAL_ORDER_STATUSES = ["3", "4", "Delivered", "Cancelled"];
const TERMINAL_RIDE_STATUSES = ["completed", "cancelled", "terminated"];
const TERMINAL_SERVICE_STATUSES = ["completed", "cancelled"];

const conflict = (message) => Object.assign(new Error(message), { status: 409 });

function activeOrderFilter(owners) {
  return {
    $and: [
      { $or: owners },
      {
        $nor: [
          { status: { $in: TERMINAL_ORDER_STATUSES } },
          { deliveryStatus: { $in: ["Delivered", "Cancelled"] } },
          { fulfillmentStatus: { $in: ["completed", "cancelled"] } },
        ],
      },
    ],
  };
}

async function exists(model, filter, session) {
  const query = model.exists(filter);
  if (session) query.session(session);
  return Boolean(await query);
}

async function assertNoActiveWork(models, userId, session) {
  const driverQuery = models.Driver.findOne({ user: userId })
    .select("_id walletBalance activeRideTrip pendingRideOffer profilePhotoUrl");
  const storesQuery = models.Store.find({ owner: userId }).select("_id logo");
  if (session) {
    driverQuery.session(session);
    storesQuery.session(session);
  }
  const driver = await driverQuery.lean();
  const stores = await storesQuery.lean();
  const storeIds = stores.map((store) => store._id);
  const storeOrders = storeIds.length
    ? activeOrderFilter([
      { store: { $in: storeIds } },
      { storefrontId: { $in: storeIds } },
      { fallbackStore: { $in: storeIds } },
      { fallbackInventoryStore: { $in: storeIds } },
    ])
    : null;
  const active = [];
  active.push(await exists(models.Order, activeOrderFilter([{ user: userId }, { customer: userId }]), session));
  active.push(await exists(models.Ride, { $or: [{ user: userId }, ...(driver ? [{ driver: driver._id }] : [])],
    status: { $nin: TERMINAL_RIDE_STATUSES } }, session));
  active.push(await exists(models.ServiceRequest, {
    $or: [{ customer: userId }, ...(driver ? [{ assignedTechnician: driver._id }] : [])],
    status: { $nin: TERMINAL_SERVICE_STATUSES },
  }, session));
  active.push(await exists(models.CheckoutGroup, { user: userId, status: { $in: ["awaiting_payment", "bank_review"] },
    expiresAt: { $gt: new Date() } }, session));
  if (storeOrders) active.push(await exists(models.Order, storeOrders, session));
  if (driver) {
    active.push(await exists(models.RideTrip, { driver: driver._id, status: "active" }, session));
    active.push(await exists(models.Ride, { driver: driver._id, status: { $in: TERMINAL_RIDE_STATUSES },
      paymentStatus: { $in: ["pending", "review_required"] } }, session));
    active.push(await exists(models.Order, { driver: driver._id,
      deliveryStatus: { $in: ["Driver Assigned", "Picked Up"] } }, session));
    active.push(Number(driver.walletBalance || 0) !== 0);
    active.push(await exists(models.Payout, { driver: driver._id,
      status: { $in: ["pending", "processing", "review_required"] } }, session));
  }
  if (storeIds.length) {
    active.push(await exists(models.StoreInventory, { store: { $in: storeIds }, reserved: { $gt: 0 } }, session));
    active.push(await exists(models.Payout, { store: { $in: storeIds },
      status: { $in: ["pending", "processing", "review_required"] } }, session));
  }

  if (active.some(Boolean)) {
    throw conflict("Complete or cancel active orders, rides, service requests, and store assignments, and reconcile pending payments or payouts before deleting this account.");
  }

  return { driver, stores };
}

function cloudinaryAsset(url, cloudName) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw conflict("An uploaded file cannot be removed automatically. Contact support to complete account deletion.");
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const typeIndex = parts[1] === "image" || parts[1] === "video" ? 1 : -1;
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com" ||
      parts[0] !== cloudName || typeIndex < 0 || parts[typeIndex + 1] !== "upload") {
    throw conflict("An uploaded file cannot be removed automatically. Contact support to complete account deletion.");
  }
  const uploadIndex = typeIndex + 1;
  const versionIndex = parts.findIndex((part, index) => index > uploadIndex && /^v\d+$/.test(part));
  if (versionIndex < 0 || versionIndex === parts.length - 1) {
    throw conflict("An uploaded file cannot be removed automatically. Contact support to complete account deletion.");
  }
  const publicId = parts.slice(versionIndex + 1).join("/").replace(/\.[^.]+$/, "");
  if (!publicId) throw conflict("An uploaded file cannot be removed automatically. Contact support to complete account deletion.");
  return { publicId, resourceType: parts[typeIndex] };
}

async function deleteUploadedMedia(urls) {
  const uniqueUrls = [...new Set(urls.filter((url) => typeof url === "string" && url.trim()).map((url) => url.trim()))];
  if (!uniqueUrls.length) return;
  const config = cloudinary.config();
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || config.cloud_name;
  if (!cloudName || !(process.env.CLOUDINARY_API_KEY || config.api_key) ||
      !(process.env.CLOUDINARY_API_SECRET || config.api_secret)) {
    throw Object.assign(new Error("Uploaded media deletion is unavailable. Try again later."), { status: 503 });
  }
  const assets = [...new Map(uniqueUrls.map((url) => {
    const asset = cloudinaryAsset(url, cloudName);
    return [`${asset.resourceType}:${asset.publicId}`, asset];
  })).values()];
  for (const resourceType of ["image", "video"]) {
    const ids = assets.filter((asset) => asset.resourceType === resourceType).map((asset) => asset.publicId);
    for (let index = 0; index < ids.length; index += 100) {
      const batch = ids.slice(index, index + 100);
      const result = await cloudinary.api.delete_resources(batch, { resource_type: resourceType });
      const statuses = Object.values(result.deleted || {});
      if (statuses.length !== batch.length || statuses.some((status) => status !== "deleted" && status !== "not found")) {
        throw new Error("Cloudinary did not confirm deletion of every account media file.");
      }
    }
  }
}

async function removeAccountData(models, userId, session, { driver, stores }) {
  const storeIds = stores.map((store) => store._id);
  const productReviewQuery = models.Review.find({ kind: "product", $or: [{ author: userId }, { customer: userId }] })
    .select("product").session(session);
  const productReviews = await productReviewQuery.lean();
  if (driver) await models.Review.deleteMany({ kind: "rideDriver", subject: driver._id }, { session });
  const productIds = [...new Set(productReviews.map((review) => String(review.product)).filter(Boolean))];

  await models.Review.deleteMany({ $or: [{ author: userId }, { customer: userId }] }, { session });
  await models.Notification.deleteMany({ user: userId }, { session });
  await models.DeliveryAddress.deleteMany({ user: userId }, { session });
  await models.AuthRecord.deleteMany({ userId }, { session });
  await models.AuthIdentity.deleteMany({ userId }, { session });
  await models.CheckoutGroup.deleteMany({ user: userId }, { session });
  await models.FinancialWorkspace.deleteMany({ owner: userId }, { session });
  await models.CustomerFinancialWorkspace.deleteMany({ owner: userId }, { session });
  await models.Order.updateMany({ $or: [{ user: userId }, { customer: userId }] }, { $set: {
    user: null, customer: null, orderItems: [], customerEmail: "", shippingAddress1: "", shippingAddress2: "",
    city: "", zip: "", phone: "", customerLocation: null, pickupAddress: null,
    pickupConfirmation: null, internationalShipping: null, paymentNote: "",
    "paymentMeta.senderName": "", "paymentMeta.transferReference": "",
  } }, { session });
  await models.Ride.updateMany({ user: userId }, { $set: {
    user: null, stops: [], routePath: null, tariff: null, baseline: null,
    bankAccount: null, bankSender: "", bankReference: "",
  } }, { session });
  await models.ServiceRequest.updateMany({ customer: userId }, { $set: {
    customer: null, country: "", serviceLocation: "", machineType: "", manufacturer: "",
    model: "", controller: "", errorCode: "", problemDescription: "", priority: "Normal",
    locationCity: "", locationAddress: "", contactPhone: "", photos: [], videos: [],
    budgetEstimate: null, technicianNotes: "", assignedTechnician: null,
  } }, { session });
  await models.Product.updateMany({ submittedBy: userId }, { $set: { submittedBy: null } }, { session });
  await models.Product.updateMany({ approvedBy: userId }, { $set: { approvedBy: null } }, { session });
  await models.Store.updateMany({ approvedBy: userId }, { $set: { approvedBy: null } }, { session });
  await models.Driver.updateMany({ approvedBy: userId }, { $set: { approvedBy: null } }, { session });
  await models.Driver.updateMany({ suspendedBy: userId }, { $set: { suspendedBy: null } }, { session });
  await models.Payout.updateMany({ processedBy: userId }, { $set: { processedBy: null } }, { session });
  await models.StoreDispatch.updateMany({ createdBy: userId }, { $set: { createdBy: null } }, { session });
  await models.DriverWalletTransaction.updateMany({ createdBy: userId }, { $set: { createdBy: null } }, { session });

  if (storeIds.length) {
    await models.Store.updateMany({ _id: { $in: storeIds } }, { $set: {
      owner: null, name: "Closed store", address: "", phone: "", email: "",
      city: "", country: "", location: null, description: "", logo: "",
      bankAccount: "", isOpen: false, payoutsEnabled: false,
    } }, { session });
    await models.Payout.updateMany({ store: { $in: storeIds } }, { $set: { accountDetails: "" } }, { session });
  }
  if (driver) {
    await models.Driver.updateOne({ _id: driver._id }, { $set: {
      name: "Deleted driver", email: `deleted-${driver._id}@deleted.invalid`,
      phone: "", profilePhotoUrl: "", address: "", isAvailable: false, isSuspended: true,
      payoutsEnabled: false, pushTokens: [], location: null, activeRideTrip: null,
      pendingRideOffer: null, activeCartRoutes: [],
      vehicle: { type: "", make: "", model: "", year: null, plateNumber: "", color: "",
        insuranceProvider: "", insurancePolicyNumber: "", insuranceExpiresAt: null },
    }, $unset: { user: "" } }, { session });
    await models.Payout.updateMany({ driver: driver._id }, { $set: { accountDetails: "" } }, { session });
  }

  for (const productId of productIds) {
    const summary = await ratingSummary(models, "product", productId, session);
    if (summary.count) {
      await models.Product.updateOne({ _id: productId }, { $set: {
        rating: summary.average, numReviews: summary.count,
        verifiedRating: summary.average, verifiedReviewCount: summary.count,
      } }, { session });
    } else {
      await models.Product.updateOne({ _id: productId }, {
        $set: { rating: 0, numReviews: 0 },
        $unset: { verifiedRating: "", verifiedReviewCount: "" },
      }, { session });
    }
  }
  await models.User.findByIdAndDelete(userId, { session });
  return { driver, stores };
}

async function deleteAccount(models, userId) {
  const user = await models.User.findById(userId).select("_id rideProfilePhotoUrl").lean();
  if (!user) return false;
  const profiles = await assertNoActiveWork(models, userId);
  const serviceRequests = await models.ServiceRequest.find({ customer: userId }).select("photos videos").lean();
  await deleteUploadedMedia([
    user.rideProfilePhotoUrl,
    profiles.driver?.profilePhotoUrl,
    ...profiles.stores.map((store) => store.logo),
    ...serviceRequests.flatMap((request) => [...(request.photos || []), ...(request.videos || [])]),
  ]);
  return models.User.db.transaction(async (session) => {
    if (!await models.User.findById(userId).session(session).lean()) return false;
    const currentProfiles = await assertNoActiveWork(models, userId, session);
    await removeAccountData(models, userId, session, currentProfiles);
    return true;
  });
}

module.exports = { deleteAccount, assertNoActiveWork, cloudinaryAsset };
