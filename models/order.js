const mongoose = require('mongoose');
const Product = require('./product');
const User = require('./user');

const orderSchema = new mongoose.Schema({
    orderItems: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'OrderItem',
            required: true
        }
    ],
    shippingAddress1: {
        type: String,
        required: true
    },
    shippingAddress2: {
        type: String,
        default: ''
    },
    city: {
        type: String,
        required: true
    },
    zip: {
        type: String,
        required: true
    },
    country: {
        type: String,
        required: true
    },
    phone: {
        type: String,
        required: true
    },
    status: {
        type: String,
        required: true,
        default: 'Pending'
    },
    totalPrice: {
        type: Number
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    dateOrdered: {
        type: Date,
        default: Date.now
    }
    
});

orderSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

orderSchema.set('toJSON', {
  virtuals: true,
});

exports.Order = mongoose.model('Order', orderSchema);

// {
//     "orderItems": [
//         {
//             "quantity": 3,
//             "product": "5f0b3f0b6b9b1c3c2c0c3b0b"
//         },
//         {
//             "quantity": 2,
//             "product": "5f0b3f0b6b9b1c3c2c0c3b0b"
//         }
//     ],
//     "shippingAddress1": "1234",
//     "shippingAddress2": "1234",
//     "city": "1234",
//     "zip": "1234",
//     "country": "1234",
//     "phone": "1234",
//     "status": "Pending",
//     "totalPrice": 100,
//     "user": "5f0b3f0b6b9b1c3c2c0c3b0b"
// }