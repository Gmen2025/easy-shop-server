const mongoose = require("mongoose");
const { fail } = require("./finance");

function stockInput(body) {
  const { price, countInStock, minStock = 0 } = body;
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0 ||
      !Number.isSafeInteger(Math.round(price * 100)) ||
      Math.abs(price * 100 - Math.round(price * 100)) > 1e-7 ||
      !Number.isSafeInteger(countInStock) || countInStock < 0 ||
      !Number.isSafeInteger(minStock) || minStock < 0) {
    throw fail("Enter a nonnegative price (two decimals), whole stock and a whole low-stock threshold.");
  }
  return { price, countInStock, minStock };
}

async function createStoreProduct(models, store, body, actor, managed, options = {}) {
  const stock = stockInput(body);
  if (stock.countInStock > 100000) throw fail("New product stock cannot exceed 100000.");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!name || !description || !mongoose.isValidObjectId(body.category)) throw fail("Name, description and a valid category are required.");
  if (!await models.Category.findById(body.category)) throw fail("Category not found.", 404);
  if (typeof body.image !== "string" || !/^https:\/\/\S+$/i.test(body.image)) throw fail("An HTTPS product image is required.");
  const images = body.images === undefined ? [body.image] : body.images;
  if (!Array.isArray(images) || !images.length || images.some((image) => typeof image !== "string" || !/^https:\/\/\S+$/i.test(image))) throw fail("Product images must be HTTPS URLs.");
  return models.Product.db.transaction(async (session) => {
    const productFields = {
      name, description, brand: typeof body.brand === "string" ? body.brand.trim() : "",
      image: body.image, images, category: body.category,
      store: options.sharedCatalog ? null : store._id,
      richDescription: typeof body.richDescription === "string" ? body.richDescription : "",
      isFeatured: options.allowFeatured === false ? false : body.isFeatured === true,
      ...stock, approvalStatus: "approved", approvedAt: new Date(),
    };
    if (options.createdByStore) productFields.createdByStore = store._id;
    if (options.includeApprovedBy !== false) productFields.approvedBy = actor;
    const [product] = await models.Product.create([productFields], { session });
    if (managed) await models.StoreInventory.create([{
      store: store._id, product: product._id, ...stock,
    }], { session });
    return product;
  });
}

async function addStoreListing(models, storeId, productId, body) {
  const stock = stockInput(body);
  if (!mongoose.isValidObjectId(productId)) throw fail("Invalid product ID.");
  const product = await models.Product.findById(productId);
  if (!product || product.approvalStatus !== "approved") throw fail("Choose an approved catalog product.");
  try {
    return await models.StoreInventory.create({ store: storeId, product: productId, ...stock });
  } catch (error) {
    if (error.code === 11000) throw fail("This product is already listed. Edit its existing inventory instead.", 409);
    throw error;
  }
}

module.exports = { stockInput, createStoreProduct, addStoreListing };
