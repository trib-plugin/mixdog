// lib/sqlite-bridge.mjs
//
// Cross-runtime sqlite adapter. Exports DatabaseSync — under Node delegates to
// node:sqlite, under Bun wraps bun:sqlite Database with an option-key shim so
// callers can keep using the node:sqlite constructor signature.
//
// API surface kept compatible with node:sqlite (Node 22+):
//   new DatabaseSync(path, { allowExtension?, readOnly? })
//   db.exec(sql)
//   db.prepare(sql)            // returns Statement with run/get/all/iterate
//   db.close()
//   db.loadExtension(path)     // bun: pass-through; node: requires allowExtension:true
//
// sqlite-vec's load(db) ultimately calls db.loadExtension(path); bun:sqlite
// exposes the same method name, so no extra adapter is needed beyond the
// constructor option mapping below.

const _isBun = typeof globalThis.Bun !== 'undefined' || !!process.versions?.bun

let DatabaseSync

if (_isBun) {
  const { Database } = await import('bun:sqlite')
  DatabaseSync = class extends Database {
    constructor(path, opts = {}) {
      // bun:sqlite defaults to create + readwrite when no options object is
      // passed. Passing `{}` explicitly disables every flag and yields
      // SQLITE_MISUSE — so only forward an options object when readOnly is
      // requested. allowExtension has no bun equivalent and is dropped.
      if (opts.readOnly === true) super(path, { readonly: true })
      else super(path)
    }
  }
} else {
  ;({ DatabaseSync } = await import('node:sqlite'))
}

export { DatabaseSync }
