const express = require('express');
const router = require("express").Router();
const { notifyStoreMutation } = require("../helpers/store-inventory");

async function categoryStoreIds(models, categoryId) {
    const products = await models.Product.find({ category: categoryId }).select("_id store createdByStore").lean();
    const storeIds = products.flatMap((product) => [product.store, product.createdByStore]).filter(Boolean);
    if (models.StoreInventory && products.length) {
        const rows = await models.StoreInventory.find({ product: { $in: products.map((product) => product._id) } })
            .select("store").lean();
        storeIds.push(...rows.map((row) => row.store));
    }
    return [...new Set(storeIds.map(String))];
}
router.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !req.auth?.isAdmin) {
        return res.status(403).json({ success: false, message: "Only Admin can manage categories." });
    }
    next();
});

/**
 * @swagger
 * /api/v1/categories:
 *   get:
 *     summary: Get all categories
 *     tags: [Categories]
 *     responses:
 *       200:
 *         description: List of all categories
 *       500:
 *         description: Server error
 */
router.get(`/`, async(req, res) => {
    const { Category } = req.dbModels;
    const categoryList = await Category.find();
 
    if(!categoryList) {
       res.status(500).json({success: false});
     }
     
     res.status(200).send(categoryList);
})

/**
 * @swagger
 * /api/v1/categories/{id}:
 *   get:
 *     summary: Get category by ID
 *     tags: [Categories]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Category ID
 *     responses:
 *       200:
 *         description: Category details
 *       500:
 *         description: Category not found
 */
router.get('/:id', async(req, res) => {
    const { Category } = req.dbModels;
    const category = await Category.findById(req.params.id);
 
    if(!category) {
        res.status(500).json({message: 'The category with the given ID was not found.'})
    } 
    res.status(200).send(category);
})

/**
 * @swagger
 * /api/v1/categories:
 *   post:
 *     summary: Create a new category
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 example: Electronics
 *               icon:
 *                 type: string
 *                 example: computer
 *               color:
 *                 type: string
 *                 example: "#FF5733"
 *     responses:
 *       200:
 *         description: Category created successfully
 *       400:
 *         description: Category creation failed
 */
router.post(`/`, async (req, res) => {
    const { Category } = req.dbModels;
    let category = new Category({
        name: req.body.name,
        icon: req.body.icon,
        color: req.body.color
    });

    category = await category.save();

    if(!category)
    return res.status(404).send('the category cannot be created!');

    const notificationWarnings = await notifyStoreMutation({
        models: req.dbModels, title: "Category created by Admin",
        body: `${category.name} was added to the shared catalog.`,
        data: { type: "category_created", categoryId: String(category._id) },
    });
    res.send({ ...category.toObject({ virtuals: true }), notificationWarnings });
})

/**
 * @swagger
 * /api/v1/categories/{id}:
 *   put:
 *     summary: Update a category
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Category ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               icon:
 *                 type: string
 *               color:
 *                 type: string
 *     responses:
 *       200:
 *         description: Category updated successfully
 *       400:
 *         description: Category cannot be updated
 */
//updating category data
router.put('/:id', async(req, res) => {
    const { Category } = req.dbModels;
    const category = await Category.findByIdAndUpdate(req.params.id, {
        name: req.body.name,
        icon: req.body.icon,
        color: req.body.color
    }, 
    {
        new: true
    })
     if(!category) {
         return res.status(400).send('the category cannot be updated!')
     }
        const notificationWarnings = await notifyStoreMutation({
            models: req.dbModels, storeIds: [category.createdByStore, ...await categoryStoreIds(req.dbModels, category._id)].filter(Boolean),
            title: "Category updated by Admin", body: `${category.name} was updated.`,
            data: { type: "category_updated", categoryId: String(category._id) },
        });
        res.send({ ...category.toObject({ virtuals: true }), notificationWarnings });
})

/**
 * @swagger
 * /api/v1/categories/{id}:
 *   delete:
 *     summary: Delete a category
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Category ID
 *     responses:
 *       200:
 *         description: Category deleted successfully
 *       404:
 *         description: Category not found
 *       400:
 *         description: Delete operation failed
 */
router.delete('/:id', async (req, res) => {
    const { Category } = req.dbModels;
    try {
        const category = await Category.findById(req.params.id);
        if (!category) return res.status(404).json({ success: false, message: 'Category not found.' });
        if (await req.dbModels.Product.countDocuments({ category: category._id })) {
            return res.status(409).json({ success: false, message: 'Categories used by products cannot be deleted.' });
        }
        await category.deleteOne();
        const notificationWarnings = await notifyStoreMutation({
            models: req.dbModels, storeIds: [category.createdByStore].filter(Boolean), title: "Category deleted by Admin",
            body: `${category.name} was removed from the shared catalog.`,
            data: { type: "category_deleted", categoryId: String(category._id) },
        });
        return res.status(200).json({ success: true, notificationWarnings });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
})

module.exports = router;
