const {Category} = require('../models/category');
const express = require('express');
const router = require("express").Router();

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
    let category = new Category({
        name: req.body.name,
        icon: req.body.icon,
        color: req.body.color
    });

    category = await category.save();

    if(!category)
    return res.status(404).send('the category cannot be created!');

    res.send(category);
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
        res.send(category);
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
router.delete('/:id', (req, res) => {
    
  Category.findByIdAndDelete(req.params.id).exec().then(category => {  
      if(category) {
          return res.status(200).json({success: true, message: 'the category is deleted!'})
      } else {
          return res.status(404).json({success: false, message: 'category not found!'})
      }
  }).catch(err => { 
      return res.status(400).json({success: false, error: err})
  })
})

module.exports = router;

