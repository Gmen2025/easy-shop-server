const {Order} = require('../models/order');
const express = require('express');
const {OrderItem }= require('../models/order-item');
const router = require("express").Router();

router.get(`/`, async(req, res) => {
    const orderList = await Order.find().populate('user', 'name').sort({'dateOrdered': -1}); // sort in descending order
 
    if(!orderList) {
       res.status(500).json({success: false});
     }
     
     res.send(orderList);
});

router.get(`/:id`, async(req, res) => {
  const order = await Order.findById(req.params.id)
  .populate('user', 'name')
  .populate({
    path: 'orderItems', populate: {
      path: 'product', populate: 'category'}}); 

  if(!order) {
     res.status(500).json({success: false});
   }
   
   res.send(order);
});



router.post(`/`, async(req, res) => {

  // Create an array of promises for creating OrderItem documents
  const orderItemsIDS = Promise.all(req.body.orderItems.map(async orderItem => {
    let newOrderItem = new OrderItem({
      quantity: orderItem.quantity,
      product: orderItem.product
    })

    // Save the OrderItem document and return its ID
    newOrderItem = await newOrderItem.save(); 
    return newOrderItem._id;
  }));

  // Wait for all OrderItem documents to be created and get their IDs
  const orderItemsIDSResolved = await orderItemsIDS;

  // Calculate the total price of the order from backend to avoid front-end manipulation
  const totalPrices = await Promise.all(orderItemsIDSResolved.map(async orderItemId => {
    const orderItem = await OrderItem.findById(orderItemId).populate('product', 'price');
    const totalPrice = orderItem.product.price * orderItem.quantity;
    return totalPrice;
  }
  ));

  const totalPrice = totalPrices.reduce((a, b) => a + b, 0);


   // Create a new Order document with the resolved OrderItem IDs
  const order = new Order({
      orderItems: orderItemsIDSResolved,
      shippingAddress1: req.body.shippingAddress1,
      shippingAddress2: req.body.shippingAddress2,
      city: req.body.city,
      zip: req.body.zip,
      country: req.body.country,
      phone: req.body.phone,
      status: req.body.status,
      totalPrice: totalPrice,
      user: req.body.user
  })

  // Save the Order document
  const ord = await order.save();

  // Handle the case where the order could not be created
    if(!ord){
        return res.status(404).send('the order cannot be created!');
    }

    // Send the created order as the response
    res.send(ord);
});

//updating order status
router.put('/:id', async(req, res) => {
    const order = await Order.findByIdAndUpdate(req.params.id, 
    {
        status: req.body.status
    }, 
    {
        new: true
    })
     if(!order) {
         return res.status(400).send('the category cannot be updated!')
     }
        res.send(order);
})

//deleting order
router.delete('/:id', (req, res) => {
    
  Order.findByIdAndDelete(req.params.id).exec().then(async order => {  
      if(order) {
          await order.orderItems.map(async orderItem => {
            await OrderItem.findByIdAndDelete(orderItem)
          });
          return res.status(200).json({success: true, message: 'the order is deleted!'})
      } else {
          return res.status(404).json({success: false, message: 'order not found!'})
      }
  }).catch(err => { 
      return res.status(400).json({success: false, error: err})
  })
})

//sum of the totral sales
router.get('/get/totalsales', async(req, res) => {
    const totalSales = await Order.aggregate([
        { $group: { _id: null , totalsales: { $sum: '$totalPrice'}}}
    ])

    if(!totalSales) {
        return res.status(400).send('the order sales cannot be generated!')
    }

    res.send({totalsales: totalSales.pop().totalsales});
})

//count of the orders
router.get(`/get/count`, async(req, res) => {
  const orderCount = await Order.countDocuments({}); //counting all orders

    if(!orderCount) {
        res.status(500).json({success: false});
      }
         
        res.send({
          orderCount: orderCount
        });
})

//User orders history
router.get(`/get/userorders/:userid`, async(req, res) => {
  const userOrderList = await Order.find({user: req.params.userid})
  .populate({
    path: 'orderItems', populate: {
      path: 'product', populate: 'category'}}).sort({'dateOrdered': -1}); // sort in descending order

  if(!userOrderList) {
    res.status(500).json({success: false});
  }

  res.send(userOrderList); //sending back the user order list to the frontend

});



module.exports = router;