const { getDeliverySchedule } = require("./delivery");

function summarizeStoreOrder(order, storeId) {
  let sales = 0;
  let units = 0;
  for (const item of order.orderItems || []) {
    if (item?.product && String(item.product.store) === String(storeId)) {
      const quantity = Number(item.quantity || 0);
      sales += Number(item.product.price || 0) * quantity;
      units += quantity;
    }
  }
  if (sales === 0) {
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

function buildStoreOrderSummary(order, storeId) {
  const summary = summarizeStoreOrder(order, storeId);
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
    orderItems: (order.orderItems || []).map((item) => ({
      quantity: item.quantity,
      product: item.product
        ? { _id: item.product._id, name: item.product.name, price: item.product.price }
        : null,
    })),
  };
}

module.exports = { summarizeStoreOrder, buildStoreOrderSummary };
