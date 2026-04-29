// lib/sqlite-bridge.cjs
//
// CJS twin of sqlite-bridge.mjs — bun-only. Required from .cjs hooks
// (session-start, post-tool-use) which cannot use top-level await.

'use strict';

const { Database } = require('bun:sqlite');

class DatabaseSync extends Database {
  constructor(path, opts = {}) {
    if (opts.readOnly === true) super(path, { readonly: true });
    else super(path);
  }
}

module.exports = { DatabaseSync };
