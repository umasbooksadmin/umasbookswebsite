"use strict";

// Loaded with `node -r` by test/helpers/workflowSim.js when it runs a workflow's export step:
// the export scripts run for real, but
//   - the clock is the simulated time SIM_NOW (so "today in Paris" is the simulated day), and
//   - the database is an empty one (every query returns no rows), so no database is needed.
// Nothing else is changed: file names, --date handling and the key=value outputs are the scripts' own.

const Module = require("node:module");

if (process.env.SIM_NOW) {
  const RealDate = Date;
  const offset = RealDate.parse(process.env.SIM_NOW) - RealDate.now();
  class SimDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }
  global.Date = SimDate;
}

// An empty database: no rows, except that an aggregate without GROUP BY (SELECT COUNT(*) ...)
// returns its one row of zeros, as Postgres does.
function emptyResult(sql) {
  const text = typeof sql === "string" ? sql : (sql && sql.text) || "";
  if (/^\s*SELECT\s+COUNT\(/i.test(text) && !/GROUP BY/i.test(text)) {
    const row = Object.fromEntries([...text.matchAll(/\bAS\s+(\w+)/gi)].map((m) => [m[1], 0]));
    return { rows: [row], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}
const emptyClient = {
  query: async (sql) => emptyResult(sql),
  connect: async () => {},
  release: () => {},
  end: async () => {},
};
const fakePg = {
  Client: class { constructor() { Object.assign(this, emptyClient); } },
  Pool: class { constructor() { Object.assign(this, emptyClient); this.connect = async () => emptyClient; } on() {} },
};

const load = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "pg") return fakePg;
  if (parent && /[\\/]scripts[\\/]/.test(parent.filename || "") && request === "../src/db") {
    return { pool: new fakePg.Pool() };
  }
  return load.call(this, request, parent, ...rest);
};
