// lib/sqlite-bridge.mjs
//
// Bun-only sqlite adapter. Wraps `bun:sqlite` Database and exposes a
// DatabaseSync shim with the constructor signature historically used by
// node:sqlite callers (path + { readOnly?: boolean }).
//
// API surface:
//   new DatabaseSync(path, { readOnly? })
//   db.exec(sql)
//   db.prepare(sql)            // bun:sqlite Statement (.run/.get/.all/.iterate)
//   db.close()
//   db.loadExtension(path)     // sqlite-vec relies on this — bun:sqlite supports it natively
//
// Caller-side options like `allowExtension` (node:sqlite-only) are dropped;
// `bun:sqlite` always allows loadExtension.

import { Database } from 'bun:sqlite'

class DatabaseSync extends Database {
  constructor(path, opts = {}) {
    // bun:sqlite defaults to create + readwrite when no options object is
    // passed. Passing `{}` explicitly disables every flag and yields
    // SQLITE_MISUSE — so only forward an options object when readOnly is
    // requested.
    if (opts.readOnly === true) super(path, { readonly: true })
    else super(path)
  }
}

export { DatabaseSync }
