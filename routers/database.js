const express = require('express');
const router = express.Router();
const { normalizeDatabaseName, getDbConnection, DEFAULT_DB_NAME } = require('../helpers/db-manager');

const ALLOWED_DB_NAMES = (process.env.ALLOWED_DB_NAMES || DEFAULT_DB_NAME)
  .split(',')
  .map((db) => db.trim())
  .filter(Boolean);

/**
 * @swagger
 * /api/v1/database/list:
 *   get:
 *     summary: List available databases
 *     description: Returns all database names available for the frontend dropdown. No authentication required.
 *     tags: [Database]
 *     parameters:
 *       - in: header
 *         name: x-database-name
 *         schema:
 *           type: string
 *         required: false
 *         description: Currently selected database (optional)
 *     responses:
 *       200:
 *         description: List of allowed database names
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DatabaseListResponse'
 *             example:
 *               success: true
 *               databases: ["E_Shopping", "E_ShopUSA"]
 *               default: "E_Shopping"
 */
router.get('/list', (req, res) => {
  res.json({
    success: true,
    databases: ALLOWED_DB_NAMES,
    default: DEFAULT_DB_NAME,
  });
});

/**
 * @swagger
 * /api/v1/database/switch:
 *   post:
 *     summary: Switch active database
 *     description: |
 *       Validates and confirms the requested database name. No authentication required.
 *       After a successful switch, include the header `x-database-name: <database>` on every
 *       subsequent API request to route queries to the selected database.
 *     tags: [Database]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DatabaseSwitchRequest'
 *           example:
 *             database: "E_ShopUSA"
 *     responses:
 *       200:
 *         description: Database switched successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DatabaseSwitchResponse'
 *             example:
 *               success: true
 *               message: "Switched to database \"E_ShopUSA\". Send x-database-name: E_ShopUSA header on all subsequent requests."
 *               database: "E_ShopUSA"
 *               instruction: "Add header to every request: x-database-name: E_ShopUSA"
 *       400:
 *         description: Missing or invalid database name
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               success: false
 *               message: "\"InvalidDB\" is not an allowed database. Allowed: E_Shopping, E_ShopUSA"
 *       503:
 *         description: Could not reach the requested database
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/switch', async (req, res) => {
  const requested = req.body?.database || req.body?.databaseName || req.body?.db;

  if (!requested) {
    return res.status(400).json({
      success: false,
      message: 'Provide a database name in body: { "database": "E_ShopUSA" }',
    });
  }

  const resolved = normalizeDatabaseName(requested);

  if (resolved !== requested.trim()) {
    return res.status(400).json({
      success: false,
      message: `"${requested}" is not an allowed database. Allowed: ${ALLOWED_DB_NAMES.join(', ')}`,
      resolved,
    });
  }

  // Verify connection is reachable for the selected DB
  try {
    const db = getDbConnection(resolved);
    await db.db.admin().ping();
  } catch (err) {
    return res.status(503).json({
      success: false,
      message: `Could not reach database "${resolved}": ${err.message}`,
    });
  }

  console.log(`[DB Switch] Frontend switched to: ${resolved}`);

  res.json({
    success: true,
    message: `Switched to database "${resolved}". Send x-database-name: ${resolved} header on all subsequent requests.`,
    database: resolved,
    instruction: `Add header to every request: x-database-name: ${resolved}`,
  });
});

module.exports = router;
