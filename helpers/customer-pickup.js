const { conflict, release } = require("./store-inventory");
const id = (value) => String(value?._id || value || "");
const isStorePickup = (order) => order.fulfillmentMethod === "pickup" && !order.internationalShipping;

async function confirmPickup(models, groupId, orderId, auth, body) {
  if (!["customer", "operator"].includes(body?.party) || typeof body?.note !== "string" ||
      !body.note.trim() || body.note.trim().length > 300) {
    throw conflict("Choose customer or operator confirmation and enter a collection note (1-300 characters).");
  }
  return models.Order.db.transaction(async (session) => {
    const group = await models.CheckoutGroup.findById(groupId).session(session);
    const order = await models.Order.findOne({ _id: orderId, checkoutGroup: groupId }).session(session);
    if (!group || group.status !== "placed" || !order || !group.orders.some((key) => id(key) === id(order)) ||
        order.fulfillmentMethod !== "pickup") throw conflict("This order is not available for customer collection.");
    if (body.party === "customer") {
      if (id(group.user) !== id(auth.userId)) throw Object.assign(new Error("Only the purchasing customer can confirm collection."), { status: 403 });
    } else if (!auth.isAdmin) {
      const store = await models.Store.findOne({ _id: order.store, owner: auth.userId }).session(session).lean();
      if (!store) throw Object.assign(new Error("Only the assigned store owner or Admin can verify collection."), { status: 403 });
    }
    if (order.fulfillmentStatus === "cancelled" || order.status === "4") throw conflict("This order was cancelled.");
    if (group.paymentMethod !== "cash" && order.paymentStatus !== "completed") throw conflict("Payment must be verified before confirming collection.");
    if (order.internationalShipping) {
      const shipment = group.international?.shipments.find((entry) => entry.id === order.internationalShipping.shipmentId);
      if (!shipment || !["arrived_ethiopia", "delivered"].includes(shipment.status) || order.deliveryStatus !== "Delivered") {
        throw conflict("Wait until the shipment has arrived in Ethiopia before confirming collection.");
      }
    } else if (!["pending", "accepted", "completed"].includes(order.fulfillmentStatus) || order.driver || order.storeDispatchBatch) {
      throw conflict("This order is not awaiting collection from its supplying store.");
    }
    const confirmation = order.pickupConfirmation || {};
    const field = body.party === "customer" ? "customerAt" : "operatorAt";
    if (confirmation[field]) return order;
    order.pickupConfirmation = { ...confirmation, [field]: new Date(),
      [`${body.party}User`]: auth.userId, [`${body.party}Note`]: body.note.trim() };
    const complete = order.pickupConfirmation.customerAt && order.pickupConfirmation.operatorAt;
    if (complete) {
      if (isStorePickup(order)) {
        await release(models, order, session, true);
        order.reservedItems = [];
        order.fulfillmentStatus = "completed";
        order.deliveryStatus = "Delivered";
        order.dispatchStatus = "delivered";
        order.status = "3";
        order.deliveredAt = new Date();
        if (group.paymentMethod === "cash") {
          order.paymentStatus = "completed";
          order.paymentPaidAt = new Date();
          order.paymentProvider = "cash";
        }
      } else {
        order.internationalShipping = { ...order.internationalShipping, collectionCompletedAt: new Date() };
        order.markModified("internationalShipping");
      }
    }
    order.markModified("pickupConfirmation");
    await order.save({ session });
    group.fulfillmentRevision = (group.fulfillmentRevision || 0) + 1;
    if (order.internationalShipping && complete) {
      const siblings = await models.Order.find({ checkoutGroup: groupId }).session(session);
      const shipment = group.international.shipments.find((entry) => entry.id === order.internationalShipping.shipmentId);
      const active = siblings.filter((entry) => entry.internationalShipping?.shipmentId === shipment.id && entry.fulfillmentStatus !== "cancelled");
      if (active.length && shipment.status !== "delivered" && active.every((entry) => entry.fulfillmentMethod === "pickup" && entry.pickupConfirmation?.customerAt && entry.pickupConfirmation?.operatorAt)) {
        shipment.status = "delivered";
        shipment.history.push({ status: "delivered", at: new Date(), note: "Customer and operator confirmed collection.", user: auth.userId });
        group.markModified("international");
        for (const sibling of active) {
          sibling.internationalShipping = { ...sibling.internationalShipping, status: "delivered", history: shipment.history };
          sibling.markModified("internationalShipping");
          await sibling.save({ session });
        }
        order.internationalShipping = { ...order.internationalShipping, status: "delivered", history: shipment.history };
      }
    }
    await group.save({ session });
    if (complete && group.paymentMethod === "cash") await require("./multi-delivery").syncCashPayment(models, groupId, session);
    return order;
  });
}

module.exports = { isStorePickup, confirmPickup };
