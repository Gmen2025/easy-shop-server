// Builds the driver-facing view of an order: pre-pickup, only an approximate drop
// zone is exposed (no exact address/phone); full details unlock once picked up.

const REVEALED_STATUSES = ["Picked Up", "Delivered"];

function roundCoordinate(value, decimals = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function isDropoffRevealed(order) {
  return REVEALED_STATUSES.includes(order?.deliveryStatus);
}

function getApproxDropZone(order) {
  const coordinates = order?.customerLocation?.coordinates;
  return {
    city: order?.city || "",
    zip: order?.zip || "",
    country: order?.country || "",
    // Rounded to ~1km grid so the exact address/building isn't derivable pre-pickup.
    approxCoordinates:
      Array.isArray(coordinates) && coordinates.length === 2
        ? [roundCoordinate(coordinates[0]), roundCoordinate(coordinates[1])]
        : null,
  };
}

function buildDriverOrderSummary(order) {
  const revealed = isDropoffRevealed(order);
  const customerSource = (order?.customer && typeof order.customer === "object" ? order.customer : null) ||
    (order?.user && typeof order.user === "object" ? order.user : null) ||
    {};
  const storeSource = order?.store && typeof order.store === "object" ? order.store : null;

  return {
    orderId: String(order._id),
    deliveryStatus: order.deliveryStatus,
    dispatchStatus: order.dispatchStatus,
    queueBatchId: order.queueBatchId || null,
    queueSequence: order.queueSequence || 0,
    deliveryFee: order.deliveryFee,
    deliveryMode: order.deliveryMode,
    itemCount: (order.orderItems || []).reduce((sum, item) => sum + Number(item?.quantity || 0), 0),
    items: (order.orderItems || []).map((item) => ({
      name: item?.product?.name || "Item",
      image: item?.product?.image || "",
      quantity: item?.quantity,
    })),
    store: storeSource
      ? {
          id: String(storeSource._id || storeSource),
          name: storeSource.name || "",
          address: storeSource.address || "",
          location: storeSource.location || null,
        }
      : null,
    dropZone: getApproxDropZone(order),
    dropoffRevealed: revealed,
    customer: revealed
      ? {
          name: customerSource.name || order.customerEmail || "Customer",
          phone: order.phone || customerSource.phone || "",
        }
      : { name: "Customer" },
    address: revealed
      ? {
          address1: order.shippingAddress1 || "",
          address2: order.shippingAddress2 || "",
          city: order.city || "",
          zip: order.zip || "",
          country: order.country || "",
          coordinates: order?.customerLocation?.coordinates || null,
        }
      : null,
  };
}

module.exports = {
  roundCoordinate,
  isDropoffRevealed,
  getApproxDropZone,
  buildDriverOrderSummary,
};
