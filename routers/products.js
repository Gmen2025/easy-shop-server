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

/**
 * @swagger
 * /api/v1/products:
 *   get:
 *     summary: Get all products
 *     tags: [Products]
 *     parameters:
 *       - in: query
 *         name: isFeatured
 *         schema:
 *           type: string
 *           enum: [true, false]
 *         description: Filter by featured products
 *     responses:
 *       200:
 *         description: List of products
 *       500:
 *         description: Server error
 */
//Get all products
router.get(`/`, async(req, res) => {
    try {
        let filter = {};
        
        // Handle isFeatured query parameter
        if (req.query.isFeatured === 'true') {
            filter.isFeatured = true;
        } else if (req.query.isFeatured === 'false') {
            filter.isFeatured = false;
        }
        
        console.log('Products filter:', filter);
        
        const productList = await Product.find(filter).populate('category');
        
        if (!productList) {
            res.status(500).json({ success: false });
        }
        
        res.send(productList);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
 })

/**
 * @swagger
 * /api/v1/products/{id}:
 *   get:
 *     summary: Get product by ID
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Product ID
 *     responses:
 *       200:
 *         description: Product details
 *       500:
 *         description: Product not found
 */
 router.get('/:id', async(req, res) => {
    const product = await Product.findById(req.params.id).populate('category');
 
    if(!product) {
        res.status(500).json({message: 'The product with the given ID was not found.'})
    } 
    res.send(product);
  })
 
/**
 * @swagger
 * /api/v1/products:
 *   post:
 *     summary: Create a new product
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - description
 *               - price
 *               - category
 *               - countInStock
 *               - image
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               richDescription:
 *                 type: string
 *               image:
 *                 type: string
 *                 format: binary
 *               brand:
 *                 type: string
 *               price:
 *                 type: number
 *               category:
 *                 type: string
 *               countInStock:
 *                 type: number
 *               rating:
 *                 type: number
 *               numReviews:
 *                 type: number
 *               isFeatured:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Product created successfully
 *       400:
 *         description: Invalid category or missing image
 */
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

/**
 * @swagger
 * /api/v1/products/{id}:
 *   put:
 *     summary: Update a product
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Product ID
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               richDescription:
 *                 type: string
 *               image:
 *                 type: string
 *                 format: binary
 *               brand:
 *                 type: string
 *               price:
 *                 type: number
 *               category:
 *                 type: string
 *               countInStock:
 *                 type: number
 *               rating:
 *                 type: number
 *               numReviews:
 *                 type: number
 *               isFeatured:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Product updated successfully
 *       400:
 *         description: Invalid product ID or category
 *       404:
 *         description: Product not found
 */
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

/**
 * @swagger
 * /api/v1/products/{id}:
 *   delete:
 *     summary: Delete a product
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Product ID
 *     responses:
 *       200:
 *         description: Product deleted successfully
 *       404:
 *         description: Product not found
 *       400:
 *         description: Delete operation failed
 */
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

/**
 * @swagger
 * /api/v1/products/get/count:
 *   get:
 *     summary: Get total product count
 *     tags: [Products]
 *     responses:
 *       200:
 *         description: Product count retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 productCount:
 *                   type: number
 *       500:
 *         description: Failed to retrieve count
 */
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

/**
 * @swagger
 * /api/v1/products/get/featured/{count}:
 *   get:
 *     summary: Get featured products
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: count
 *         required: true
 *         schema:
 *           type: number
 *         description: Number of featured products to retrieve (0 for all)
 *     responses:
 *       200:
 *         description: List of featured products
 *       500:
 *         description: Failed to retrieve products
 */
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

/**
 * @swagger
 * /api/v1/products/gallery-images/{id}:
 *   put:
 *     summary: Update product gallery images
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Product ID
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 maxItems: 10
 *     responses:
 *       200:
 *         description: Gallery images updated successfully
 *       400:
 *         description: Invalid product ID
 *       404:
 *         description: Product not found
 */
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