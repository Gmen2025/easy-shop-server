const {Product} = require('../models/product');
const {Category} = require('../models/category');
const express = require('express');
const router = require("express").Router();
const mongoose = require('mongoose');
const multer = require('multer');

//KEYS FOR FILE UPLOAD AND THE FILE EXTENSION MAP BASED ON MIME TYPES
const FILE_TYPE_MAP = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpg'
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
    const isValid = FILE_TYPE_MAP[file.mimetype];
    let uploadError = new Error('invalid image type');
    if(isValid) {
        uploadError = null;
    }
      
    cb(uploadError, 'public/uploads')
    },
    filename: function (req, file, cb) {
      const fileName = file.originalname.split(' ').join('-');
      const extension = FILE_TYPE_MAP[file.mimetype];
      cb(null, `${fileName}-${Date.now()}.${extension}`)
    }
  })
  
  const uploadOptions = multer({ storage: storage })

//Get all products
router.get(`/`, async(req, res) => {
    const productList = await Product.find().populate('category');
 
    if(!productList) {
       res.status(500).json({success: false});
     }
     
     res.send(productList);
 })

 router.get('/:id', async(req, res) => {
    const product = await Product.findById(req.params.id).populate('category');
 
    if(!product) {
        res.status(500).json({message: 'The product with the given ID was not found.'})
    } 
    res.send(product);
  })
 
//Create a new product
router.post(`/`, uploadOptions.single('image'), async(req, res) => {

const category = await Category.findById(req.body.category);
if(!category) return res.status(400).send('Invalid Category');

const file = req.file;
if(!file) return res.status(400).send('No image in the request');

const fileName = req.file.filename;
const basePath = `${req.protocol}://${req.get('host')}/public/uploads/`;

    const product = new Product({
        name: req.body.name,
        description: req.body.description,
        richDescription: req.body.richDescription,
        image: `${basePath}${fileName}`,
        images: req.body.images,
        brand: req.body.brand,
        price: req.body.price,
        category: req.body.category,
        countInStock: req.body.countInStock,
        rating: req.body.rating,
        numReviews: req.body.numReviews,
        isFeatured: req.body.isFeatured,
        dateCreated: req.body.dateCreated
        
    })
    
    const prod = await product.save();

    if(!prod){
        return res.status(404).send('the product cannot be created!');
    }
    res.send(prod);
})

//Update a product
router.put('/:id', uploadOptions.single('image'), async(req, res) => {
    if(!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).send('Invalid Product Id')
    }

    const category = await Category.findById(req.body.category);
    if(!category) return res.status(400).send('Invalid Category');

    const product = await Product.findById(req.params.id);
    if(!product) return res.status(400).send('Invalid Product');

    const file = req.file;
    let imagePath;
    if(file) {
        const fileName = req.file.filename;
        const basePath = `${req.protocol}://${req.get('host')}/public/uploads/`;
        imagePath = `${basePath}${fileName}`;
    } else {
        imagePath = product.image;
    }

    const updatedProduct = await Product.findByIdAndUpdate(req.params.id, {
        name: req.body.name,
        description: req.body.description,
        richDescription: req.body.richDescription,
        image: imagePath,
        images: req.body.images,
        brand: req.body.brand,
        price: req.body.price,
        category: req.body.category,
        countInStock: req.body.countInStock,
        rating: req.body.rating,
        numReviews: req.body.numReviews,
        isFeatured: req.body.isFeatured,
        dateCreated: req.body.dateCreated
    }, {new: true}
)

    if(!updatedProduct)
    return res.status(404).send('the product cannot be updated!')
    
    res.send(updatedProduct);
})

//Delete a product
router.delete('/:id', (req, res) => {
    
    Product.findByIdAndDelete(req.params.id).exec().then(product => {  
        if(product) {
            return res.status(200).json({success: true, message: 'the category is deleted!'})
        } else {
            return res.status(404).json({success: false, message: 'category not found!'})
        }
    }).catch(err => { 
        return res.status(400).json({success: false, error: err})
    })
})

//Count the number of products
router.get(`/get/count`, async(req, res) => {
    const productCount= await Product.countDocuments({}); //counting all products

    if(!productCount) {
        res.status(500).json({success: false});
        }
        
        res.send({
            productCount: productCount
        });
    })

    //Get featured products
    router.get(`/get/featured/:count`, async(req, res) => {
    const count = req.params.count ? req.params.count : 0
    const products = await Product.find({isFeatured: true}).limit(+count);//+count converts string to number

    if(!products) {
        res.status(500).json({success: false});
        }
        
        res.send(products);
    })

    //Get products by category
    router.get(`/`, async(req, res) => {
    //http://localhost:3000/api/v1/products?categories=2342342,234234
    let filter = {};
    if(req.query.categories) {
        filter = {category: req.query.categories.split(',')}
    }
    const productList = await Product.find(filter).populate('category');
    
    if(!productList) {
        res.status(500).json({success: false});
        }
        
        res.send(productList);
    })

//images gallery
router.put('/gallery-images/:id', uploadOptions.array('images', 10), async(req, res) => {
    if(!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).send('Invalid Product Id')
    }
    const files = req.files;
    let imagesPaths = [];
    const basePath = `${req.protocol}://${req.get('host')}/public/uploads/`;

    if(files) {
        files.map(file => {
            imagesPaths.push(`${basePath}${file.filename}`);
        })
    }

    const product = await Product.findByIdAndUpdate(req.params.id, {
            images: imagesPaths
    }, 
    {new: true})

    if(!product)
    return res.status(404).send('the product cannot be updated!')
    
    res.send(product);
})



module.exports = router;