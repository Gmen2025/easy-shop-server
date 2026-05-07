const { DEFAULT_DB_NAME, normalizeDatabaseName, getModelsForDb } = require('./db-manager');

function dbSelector(req, res, next) {
  const requestedDbName =
    req.headers['x-database-name'] ||
    req.headers['x-database'] ||
    req.headers['database-name'] ||
    req.query.db ||
    req.query.database ||
    req.query.databaseName ||
    req.body?.databaseName ||
    req.body?.database;
  const dbName = normalizeDatabaseName(requestedDbName);

  req.dbName = dbName || DEFAULT_DB_NAME;
  req.dbModels = getModelsForDb(req.dbName);
  res.setHeader('x-selected-database', req.dbName);

  const source =
    req.headers['x-database-name'] ? 'header:x-database-name' :
    req.headers['x-database'] ? 'header:x-database' :
    req.headers['database-name'] ? 'header:database-name' :
    req.query.db ? 'query:db' :
    req.query.database ? 'query:database' :
    req.query.databaseName ? 'query:databaseName' :
    req.body?.databaseName ? 'body:databaseName' :
    req.body?.database ? 'body:database' :
    'default';

  console.log(`[DB Selector] ${req.method} ${req.path} source=${source} requested=${requestedDbName || 'none'} selected=${req.dbName}`);

  next();
}

module.exports = dbSelector;
