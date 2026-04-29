// lib/sqlite-bridge.cjs
//
// CJS twin of sqlite-bridge.mjs. Required from .cjs hooks (session-start,
// post-tool-use) which cannot use top-level await. Same runtime split:
// node:sqlite under Node, bun:sqlite Database wrapped under Bun.

'use strict';

const _isBun = typeof globalThis.Bun !== 'undefined' || !!process.versions?.bun;

let DatabaseSync;

if (_isBun) {
  const { Database } = require('bun:sqlite');
  DatabaseSync = class extends Database {
    constructor(path, opts = {}) {
      // bun:sqlite defaults to create + readwrite when no options object is
      // passed. Passing `{}` explicitly disables every flag and yields
      // SQLITE_MISUSE — so only forward an options object when readOnly is
      // requested. allowExtension has no bun equivalent and is dropped.
      if (opts.readOnly === true) super(path, { readonly: true });
      else super(path);
    }
  };
} else {
  ({ DatabaseSync } = require('node:sqlite'));
}

module.exports = { DatabaseSync };
