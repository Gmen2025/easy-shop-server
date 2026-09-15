const express = require('express');
const router = require("express").Router();
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { sendPushToUser } = require('../helpers/push-notify');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'eshop/products',
        allowed_formats: ['jpg', 'jpeg', 'png'],
        transformation: [{ width: 1200, height: 1200, crop: 'limit' }]
    }
});

const uploadOptions = multer({ storage: storage });

const getUploadedFileUrl = (file) => {
    if (!file) return '';

    if (typeof file.secure_url === 'string' && file.secure_url.trim()) {
        return file.secure_url.trim();
    }

    if (typeof file.path === 'string' && file.path.trim()) {
        const uploadedPath = file.path.trim();
        if (uploadedPath.includes('res.cloudinary.com')) {
            return uploadedPath.replace(/^http:\/\//i, 'https://');
        }
        return uploadedPath;
    }

    if (typeof file.filename === 'string' && file.filename.trim()) {
        return cloudinary.url(file.filename.trim(), {
            secure: true,
            resource_type: 'image'
        });
    }

    return '';
};

const normalizeImageInput = (value) => {
    if (typeof value !== 'string') return '';
    const normalized = value.trim();
    if (normalized.includes('res.cloudinary.com')) {
        return normalized.replace(/^http:\/\//i, 'https://');
    }
    return normalized;
};

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
    const { Product } = req.dbModels;
    try {
        let filter = {};
        
        // Handle isFeatured query parameter
        if (req.query.isFeatured === 'true') {
            filter.isFeatured = true;
        } else if (req.query.isFeatured === 'false') {
            filter.isFeatured = false;
        }

        // Hide products still awaiting/denied admin review from the public storefront.
        // Legacy products created before this field existed are treated as approved.
        if (!req.auth?.isAdmin) {
            filter.$or = [{ approvalStatus: 'approved' }, { approvalStatus: { $exists: false } }];
        }
        
        console.log('Products filter:', filter);
        
        const productList = await Product.find(filter)
            .populate('category')
            .populate('store', 'name address location');
        
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
     const { Product } = req.dbModels;
        const product = await Product.findById(req.params.id)
            .populate('category')
            .populate('store', 'name address location owner');
 
    if(!product) {
        res.status(500).json({message: 'The product with the given ID was not found.'})
    }

    // Non-approved listings are only visible to admins and the submitting store's owner.
    const isApprovedOrLegacy = !product.approvalStatus || product.approvalStatus === 'approved';
    const isOwner = product.store?.owner && String(product.store.owner) === String(req.auth?.userId);
    if (!isApprovedOrLegacy && !req.auth?.isAdmin && !isOwner) {
        return res.status(404).json({ message: 'The product with the given ID was not found.' });
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
 *                 oneOf:
 *                   - type: string
 *                     format: binary
 *                   - type: string
 *                     format: uri
 *                 description: Upload a file or send a Cloudinary secure_url
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
const { Product, Category, Store } = req.dbModels;

const category = await Category.findById(req.body.category);
if(!category) return res.status(400).send('Invalid Category');

const file = req.file;
const bodyImage = normalizeImageInput(req.body.image);
const imagePath = getUploadedFileUrl(file) || bodyImage;

if(!imagePath) return res.status(400).send('No image in the request');

if (req.body.store) {
    if (!mongoose.isValidObjectId(req.body.store)) {
        return res.status(400).send('Invalid Store');
    }

    const store = await Store.findById(req.body.store);
    if (!store) {
        return res.status(400).send('Store not found');
    }
}

    const product = new Product({
        name: req.body.name,
        description: req.body.description,
        richDescription: req.body.richDescription,
        image: imagePath,
        images: req.body.images,
        brand: req.body.brand,
        price: req.body.price,
        category: req.body.category,
        store: req.body.store || null,
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
 *                 oneOf:
 *                   - type: string
 *                     format: binary
 *                   - type: string
 *                     format: uri
 *                 description: Upload a file or send a Cloudinary secure_url
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
    const { Product, Category, Store } = req.dbModels;
    if(!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).send('Invalid Product Id')
    }

    const category = await Category.findById(req.body.category);
    if(!category) return res.status(400).send('Invalid Category');

    const product = await Product.findById(req.params.id);
    if(!product) return res.status(400).send('Invalid Product');

    const file = req.file;
    const bodyImage = normalizeImageInput(req.body.image);
    const imagePath = getUploadedFileUrl(file) || bodyImage || product.image;

    if (req.body.store !== undefined && req.body.store !== null && req.body.store !== '') {
        if (!mongoose.isValidObjectId(req.body.store)) {
            return res.status(400).send('Invalid Store');
        }

        const store = await Store.findById(req.body.store);
        if (!store) {
            return res.status(400).send('Store not found');
        }
    }

    const resolvedStore = req.body.store === '' ? null : (req.body.store !== undefined ? req.body.store : product.store);

    const updatedProduct = await Product.findByIdAndUpdate(req.params.id, {
        name: req.body.name,
        description: req.body.description,
        richDescription: req.body.richDescription,
        image: imagePath,
        images: req.body.images,
        brand: req.body.brand,
        price: req.body.price,
        category: req.body.category,
        store: resolvedStore,
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
    const { Product } = req.dbModels;
    
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
    const { Product } = req.dbModels;
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
    const { Product } = req.dbModels;
    const count = req.params.count ? req.params.count : 0
    const products = await Product.find({isFeatured: true}).limit(+count);//+count converts string to number

    if(!products) {
        res.status(500).json({success: false});
        }
        
        res.send(products);
    })

    //Get products by category
    router.get(`/`, async(req, res) => {
    const { Product } = req.dbModels;
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
    const { Product } = req.dbModels;
    if(!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).send('Invalid Product Id')
    }
    const files = req.files;
    let imagesPaths = [];

    if(files) {
        files.map(file => {
            imagesPaths.push(file.path);
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

// ---------------------------------------------------------------------------
// Admin review queue for store-owner product submissions.
// ---------------------------------------------------------------------------

const requireAdmin = (req, res, next) => {
    if (!req.auth?.isAdmin) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    next();
};

router.get('/admin/pending', requireAdmin, async (req, res) => {
    const { Product } = req.dbModels;
    const status = ['pending', 'approved', 'denied'].includes(req.query.status) ? req.query.status : 'pending';

    const products = await Product.find({ approvalStatus: status })
        .populate('category', 'name')
        .populate('store', 'name address owner')
        .populate('submittedBy', 'name email')
        .sort({ dateCreated: -1 });

    return res.status(200).json({ success: true, products });
});

router.put('/:id/approve', requireAdmin, async (req, res) => {
    const { Product, Store, User } = req.dbModels;
    if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'Invalid product id.' });
    }

    const product = await Product.findById(req.params.id).populate('store', 'name owner');
    if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    // Avoid listing the same item twice for a store that already has it live.
    const duplicate = await Product.findOne({
        _id: { $ne: product._id },
        store: product.store?._id || product.store,
        approvalStatus: 'approved',
        name: new RegExp(`^${String(product.name).trim()}$`, 'i'),
    });
    if (duplicate) {
        return res.status(409).json({
            success: false,
            message: 'This store already has an approved product with the same name.',
            duplicateProductId: String(duplicate._id),
        });
    }

    product.approvalStatus = 'approved';
    product.approvedAt = new Date();
    product.approvedBy = req.auth.userId;
    product.rejectionReason = '';
    await product.save();

    const ownerId = product.store?.owner;
    if (ownerId) {
        await Promise.allSettled([
            sendPushToUser({
                User,
                userId: ownerId,
                title: 'Product approved',
                body: `"${product.name}" is now live on Easy Shop.`,
                data: { type: 'product_approved', productId: String(product._id) },
            }),
        ]);
    }

    return res.status(200).json({ success: true, product });
});

router.put('/:id/deny', requireAdmin, async (req, res) => {
    const { Product, User } = req.dbModels;
    if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'Invalid product id.' });
    }

    const product = await Product.findById(req.params.id).populate('store', 'owner');
    if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    product.approvalStatus = 'denied';
    product.rejectionReason = String(req.body?.reason || 'Does not meet listing requirements.');
    product.approvedAt = null;
    product.approvedBy = null;
    await product.save();

    const ownerId = product.store?.owner;
    if (ownerId) {
        await sendPushToUser({
            User,
            userId: ownerId,
            title: 'Product submission denied',
            body: `"${product.name}" was not approved: ${product.rejectionReason}`,
            data: { type: 'product_denied', productId: String(product._id) },
        });
    }

    return res.status(200).json({ success: true, product });
});

module.exports = router;