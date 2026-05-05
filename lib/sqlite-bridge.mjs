// Bun-only sqlite adapter. Wraps `bun:sqlite` Database with the
// constructor signature used by node:sqlite callers (path + { readOnly? }).
// Used by src/agent/orchestrator/trajectory.mjs only.

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
