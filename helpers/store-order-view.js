const { getDeliverySchedule } = require("./delivery");

function isStoreItem(item, storeId, productIds) {
  return item?.product && (
    String(item.product.store) === String(storeId) ||
    productIds?.has(String(item.product._id))
  );
}

function summarizeStoreOrder(order, storeId, productIds) {
  let sales = 0;
  let units = 0;
  let matchedItems = 0;
  for (const item of order.orderItems || []) {
    if (isStoreItem(item, storeId, productIds)) {
      matchedItems += 1;
      const quantity = Number(item.quantity || 0);
      sales += Number(item.product.price || 0) * quantity;
      units += quantity;
    }
  }
  if (productIds ? matchedItems === 0 && String(order.store) === String(storeId) : sales === 0) {
    sales = Number(order.itemsSubtotal || 0) || Math.max(
      0,
      Number(order.totalPrice || 0) - Number(order.deliveryFee || 0)
    );
    units = (order.orderItems || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  }

  return {
    ...order,
    sales,
    units,
    completedAt: order.deliveredAt || order.dateOrdered,
  };
}

function buildStoreOrderSummary(order, storeId, productIds) {
  const summary = summarizeStoreOrder(order, storeId, productIds);
  const items = productIds && String(order.store) !== String(storeId)
    ? (order.orderItems || []).filter((item) => isStoreItem(item, storeId, productIds))
    : order.orderItems || [];
  return {
    _id: order._id,
    ...getDeliverySchedule(order),
    status: order.status,
    deliveryStatus: order.deliveryStatus,
    dateOrdered: order.dateOrdered,
    completedAt: order.deliveredAt || null,
    sales: summary.sales,
    units: summary.units,
    totalPrice: order.totalPrice,
    deliveryFee: order.deliveryFee,
    orderItems: items.map((item) => ({
      quantity: item.quantity,
      product: item.product
        ? { _id: item.product._id, name: item.product.name, price: item.product.price }
        : null,
    })),
  };
}

module.exports = { summarizeStoreOrder, buildStoreOrderSummary };
