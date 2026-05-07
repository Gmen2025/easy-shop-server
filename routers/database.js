const express = require('express');
const router = express.Router();
const { normalizeDatabaseName, getDbConnection, DEFAULT_DB_NAME } = require('../helpers/db-manager');

const ALLOWED_DB_NAMES = (process.env.ALLOWED_DB_NAMES || DEFAULT_DB_NAME)
  .split(',')
  .map((db) => db.trim())
  .filter(Boolean);

/**
 * GET /api/v1/database/list
 * Returns all available database names for the frontend dropdown.
 */
router.get('/list', (req, res) => {
  res.json({
    success: true,
    databases: ALLOWED_DB_NAMES,
    default: DEFAULT_DB_NAME,
  });
});

/**
 * POST /api/v1/database/switch
 * Body: { database: "E_ShopUSA" }
 * Validates the requested database name and responds with the resolved name.
 * The frontend should store this and send it as x-database-name header on every subsequent request.
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
