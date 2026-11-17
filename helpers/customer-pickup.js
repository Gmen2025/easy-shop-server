const { conflict, release } = require("./store-inventory");
const id = (value) => String(value?._id || value || "");
const isStorePickup = (order) => order.fulfillmentMethod === "pickup" && !order.internationalShipping;

async function confirmPickup(models, groupId, orderId, auth, body, options = {}) {
  if (!["customer", "operator"].includes(body?.party) || typeof body?.note !== "string" ||
      !body.note.trim() || body.note.trim().length > 300) {
    throw conflict("Choose customer or operator confirmation and enter a collection note (1-300 characters).");
  }
  const hub = require("./international-hub");
  let pending = [];
  let ctx;
  const result = await models.Order.db.transaction(async (session) => {
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
      const shipmentRoute = require("./international-shipping").route(group.international?.direction);
      const shipment = group.international?.shipments.find((entry) => entry.id === order.internationalShipping.shipmentId);
      if (!shipment || ![shipmentRoute.stages[3], "delivered"].includes(shipment.status) || order.deliveryStatus !== "Delivered") {
        throw conflict(`Wait until the shipment has arrived in ${shipmentRoute.destination} before confirming collection.`);
      }
      if (shipment.status !== "delivered" && !hub.releaseAllowsCollection(shipment)) {
        throw conflict(`Wait until the ${shipmentRoute.destination} hub clears customs, settles charges and marks this shipment ready for pickup.`);
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
      const direction = group.international?.direction || "usa-to-ethiopia";
      const siblings = await models.Order.find({ checkoutGroup: groupId }).session(session);
      const shipment = group.international.shipments.find((entry) => entry.id === order.internationalShipping.shipmentId);
      const members = siblings.filter((entry) => entry.internationalShipping?.shipmentId === shipment.id && id(entry) !== id(order));
      const active = [...members, order].filter((entry) => entry.fulfillmentStatus !== "cancelled");
      if (hub.completeIfFinished(shipment, active, auth.userId, "Customer and operator confirmed collection.")) {
        group.markModified("international");
        for (const sibling of members) {
          hub.syncOrder(sibling, shipment);
          await sibling.save({ session });
        }
        hub.syncOrder(order, shipment);
        await order.save({ session });
        ctx = hub.originContext(models, direction, options);
        const notify = hub.notices(group, shipment, ctx.route);
        notify.customer("Shipment completed", `All packages for shipment ${shipment.trackingCode || shipment.id} were handed over. Thank you!`);
        pending = notify.list;
      }
    }
    await group.save({ session });
    if (complete && group.paymentMethod === "cash") await require("./multi-delivery").syncCashPayment(models, groupId, session);
    return order;
  });
  if (ctx) await hub.deliver(ctx, pending);
  return result;
}

module.exports = { isStorePickup, confirmPickup };
