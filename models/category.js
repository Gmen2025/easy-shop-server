const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    color: {
        type: String
    },
    icon: {
        type: String
    },
    image: {
        type: String
    },
    createdByStore: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Store',
        default: null
    }
});

exports.Category = mongoose.model('Category', categorySchema);
exports.categorySchema = categorySchema;
