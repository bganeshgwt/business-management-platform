const pool = require("../config/database");

// Runs several queries for one answer. On the pool they run side by side; on
// a transaction's client they run one after another, because a pg client
// takes one query at a time (queuing a second one while the first runs is
// what pg warns about: "Calling client.query() when the client is already
// executing a query"). Pass functions, so nothing starts before its turn.
async function queryAll(db, tasks) {
  if (!db || db === pool) return Promise.all(tasks.map((task) => task()));
  const results = [];
  for (const task of tasks) results.push(await task());
  return results;
}

module.exports = queryAll;
