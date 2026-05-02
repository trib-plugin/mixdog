import { createHash } from 'node:crypto';
import { resolve as pathResolve, extname, isAbsolute, dirname, relative as pathRelative, join } from 'node:path';
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import {
  normalizeInputPath,
  normalizeOutputPath,
  toDisplayPath,
} from './builtin.mjs';
import { getPluginData } from '../config.mjs';
import { getCapabilities } from '../../../shared/config.mjs';

const CODE_GRAPH_TTL_MS = 30_000;
const CODE_GRAPH_MAX_FILES = 10_000;
const CODE_GRAPH_DISK_FILE = 'code-graph-cache.json';
const CODE_GRAPH_DISK_MAX_ENTRIES = 24;
const CODE_GRAPH_EXT_LANG = Object.freeze({
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
});
const _codeGraphCache = new Map();
const _diskCodeGraphCache = new Map();
const _codeGraphDirtyPaths = new Map();
let _diskCodeGraphCacheLoaded = false;
let _diskCodeGraphCacheFlushTimer = null;
const _codeGraphCacheStats = {
  memoryHits: 0,
  memoryMisses: 0,
  diskHits: 0,
  diskMisses: 0,
  reusedNodes: 0,
  rebuiltNodes: 0,
  referenceQueryHits: 0,
  referenceQueryMisses: 0,
  maskedLineCacheHits: 0,
  maskedLineCacheMisses: 0,
  sourceTextCacheHits: 0,
  sourceTextCacheMisses: 0,
  symbolIndexHits: 0,
  symbolIndexMisses: 0,
  symbolIndexFullBuilds: 0,
  symbolIndexIncrementalBuilds: 0,
  dirtyPathRebuilds: 0,
  fullWalkBuilds: 0,
};

function _isCommentOnlyLine(line) {
  return /^\s*(?:\/\/|\*\s|\*$|\/\*|\*\/|#)/.test(line);
}

function _graphLanguage(absPath) {
  return CODE_GRAPH_EXT_LANG[extname(absPath).toLowerCase()] || null;
}

function _isGraphFile(absPath) {
  return Boolean(_graphLanguage(absPath));
}

function _walkGraphFiles(root, acc) {
  if (acc.length >= CODE_GRAPH_MAX_FILES) return;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (acc.length >= CODE_GRAPH_MAX_FILES) return;
    if (entry.name === 'node_modules'
      || entry.name === '.git'
      || entry.name === 'dist'
      || entry.name === 'build'
      || entry.name === 'target'
      || entry.name === 'vendor'
      || entry.name === '__pycache__'
      || entry.name === 'coverage'
      || entry.name === '.next'
      || entry.name === '.nuxt'
      || entry.name === 'testdata') continue;
    const full = pathResolve(root, entry.name);
    if (entry.isDirectory()) {
      _walkGraphFiles(full, acc);
      continue;
    }
    if (_isGraphFile(full)) acc.push(full);
  }
}

function _normalizeImportSpec(spec) {
  return String(spec || '').trim().replace(/\\/g, '/');
}

function _codeGraphDiskPath() {
  return join(getPluginData(), CODE_GRAPH_DISK_FILE);
}

function _canonicalGraphCwd(cwd) {
  if (!cwd) throw new Error('code_graph requires cwd — caller did not provide a working directory');
  return pathResolve(cwd);
}

function _canonicalGraphPath(p) {
  const full = pathResolve(String(p || ''));
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function _fileFingerprint(rel, stat) {
  return `${rel}|${Number(stat?.mtimeMs || 0)}|${Number(stat?.size || 0)}`;
}

function _collectGraphFileMetas(absRoot, cwd) {
  const files = [];
  _walkGraphFiles(absRoot, files);
  const fileMetas = [];
  for (const abs of files) {
    const lang = _graphLanguage(abs);
    if (!lang) continue;
    let stat = null;
    try { stat = statSync(abs); } catch { continue; }
    const rel = _graphRel(abs, cwd);
    fileMetas.push({ abs, rel, lang, stat, fp: _fileFingerprint(rel, stat) });
  }
  fileMetas.sort((a, b) => a.rel.localeCompare(b.rel));
  return fileMetas;
}

function _computeGraphSignature(fileMetas) {
  const hash = createHash('sha1');
  for (const meta of fileMetas) hash.update(`${meta.fp}\n`);
  return hash.digest('hex');
}

function _serializeGraph(graph) {
  return {
    builtAt: Number(graph?.builtAt || Date.now()),
    signature: String(graph?.signature || ''),
    nodes: [...(graph?.nodes?.values?.() || [])].map((node) => ({
      rel: node.rel,
      lang: node.lang,
      fingerprint: node.fingerprint || '',
      rawImports: Array.isArray(node.rawImports) ? node.rawImports : [],
      resolvedImports: Array.isArray(node.resolvedImportsRel) ? node.resolvedImportsRel : [],
      packageName: node.packageName || '',
      namespaceName: node.namespaceName || '',
      goPackageName: node.goPackageName || '',
      goImportPath: node.goImportPath || '',
      topLevelTypes: Array.isArray(node.topLevelTypes) ? node.topLevelTypes : [],
      tokenSymbols: Array.isArray(node.tokenSymbols) ? node.tokenSymbols : null,
    })),
  };
}

function _deserializeGraph(cwd, payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.nodes)) return null;
  const nodes = new Map();
  const reverse = new Map();
  for (const item of payload.nodes) {
    if (!item || typeof item.rel !== 'string' || typeof item.lang !== 'string') continue;
    const resolvedImportsRel = Array.isArray(item.resolvedImports) ? item.resolvedImports.filter((v) => typeof v === 'string') : [];
    const node = {
      abs: pathResolve(cwd, item.rel),
      rel: item.rel,
      lang: item.lang,
      fingerprint: item.fingerprint || '',
      rawImports: Array.isArray(item.rawImports) ? item.rawImports : [],
      resolvedImportsRel,
      resolvedImports: resolvedImportsRel.map((rel) => pathResolve(cwd, rel)),
      packageName: item.packageName || '',
      namespaceName: item.namespaceName || '',
      goPackageName: item.goPackageName || '',
      goImportPath: item.goImportPath || '',
      topLevelTypes: Array.isArray(item.topLevelTypes) ? item.topLevelTypes : [],
      tokenSymbols: Array.isArray(item.tokenSymbols) ? item.tokenSymbols : null,
    };
    nodes.set(node.rel, node);
    for (const depRel of resolvedImportsRel) {
      if (!reverse.has(depRel)) reverse.set(depRel, new Set());
      reverse.get(depRel).add(node.rel);
    }
  }
  return _attachGraphRuntimeCaches({
    cwd,
    nodes,
    reverse,
    builtAt: Number(payload.builtAt || Date.now()),
    signature: String(payload.signature || ''),
  });
}

function _attachGraphRuntimeCaches(graph) {
  if (!graph || typeof graph !== 'object') return graph;
  if (!graph._referenceSearchCache) graph._referenceSearchCache = new Map();
  if (!graph._maskedLinesCache) graph._maskedLinesCache = new Map();
  if (!graph._sourceTextCache) graph._sourceTextCache = new Map();
  if (!graph._symbolTokenIndex) graph._symbolTokenIndex = new Map();
  if (typeof graph._symbolTokenIndexDirty !== 'boolean') graph._symbolTokenIndexDirty = true;
  return graph;
}

function _pruneDiskCodeGraphEntries(now = Date.now()) {
  for (const [cwd, entry] of _diskCodeGraphCache) {
    if (!entry || typeof entry !== 'object') {
      _diskCodeGraphCache.delete(cwd);
      continue;
    }
    if (now - Number(entry.builtAt || 0) > CODE_GRAPH_TTL_MS) _diskCodeGraphCache.delete(cwd);
  }
  while (_diskCodeGraphCache.size > CODE_GRAPH_DISK_MAX_ENTRIES) {
    const oldest = _diskCodeGraphCache.keys().next().value;
    if (!oldest) break;
    _diskCodeGraphCache.delete(oldest);
  }
}

function _loadDiskCodeGraphCache(now = Date.now()) {
  if (_diskCodeGraphCacheLoaded) return;
  _diskCodeGraphCacheLoaded = true;
  try {
    const path = _codeGraphDiskPath();
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return;
    for (const [cwd, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object') continue;
      _diskCodeGraphCache.set(_canonicalGraphCwd(cwd), entry);
    }
    _pruneDiskCodeGraphEntries(now);
  } catch {
    // Best-effort only.
  }
}

function _persistDiskCodeGraphCacheNow() {
  try {
    _loadDiskCodeGraphCache();
    _pruneDiskCodeGraphEntries();
    const path = _codeGraphDiskPath();
    mkdirSync(getPluginData(), { recursive: true });
    const payload = Object.fromEntries(_diskCodeGraphCache.entries());
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, path);
  } catch {
    // Best-effort only.
  }
}

function _scheduleDiskCodeGraphCacheFlush() {
  if (_diskCodeGraphCacheFlushTimer) return;
  _diskCodeGraphCacheFlushTimer = setTimeout(() => {
    _diskCodeGraphCacheFlushTimer = null;
    _persistDiskCodeGraphCacheNow();
  }, 250);
  if (typeof _diskCodeGraphCacheFlushTimer.unref === 'function') _diskCodeGraphCacheFlushTimer.unref();
}

function _setDiskCodeGraphEntry(cwd, graph) {
  _loadDiskCodeGraphCache();
  _diskCodeGraphCache.set(_canonicalGraphCwd(cwd), _serializeGraph(graph));
  _pruneDiskCodeGraphEntries();
  _scheduleDiskCodeGraphCacheFlush();
}

function resetCodeGraphCachesForTesting() {
  _codeGraphCache.clear();
  _diskCodeGraphCache.clear();
  _codeGraphDirtyPaths.clear();
  _diskCodeGraphCacheLoaded = false;
  _codeGraphCacheStats.memoryHits = 0;
  _codeGraphCacheStats.memoryMisses = 0;
  _codeGraphCacheStats.diskHits = 0;
  _codeGraphCacheStats.diskMisses = 0;
  _codeGraphCacheStats.reusedNodes = 0;
  _codeGraphCacheStats.rebuiltNodes = 0;
  _codeGraphCacheStats.referenceQueryHits = 0;
  _codeGraphCacheStats.referenceQueryMisses = 0;
  _codeGraphCacheStats.maskedLineCacheHits = 0;
  _codeGraphCacheStats.maskedLineCacheMisses = 0;
  _codeGraphCacheStats.sourceTextCacheHits = 0;
  _codeGraphCacheStats.sourceTextCacheMisses = 0;
  _codeGraphCacheStats.symbolIndexHits = 0;
  _codeGraphCacheStats.symbolIndexMisses = 0;
  _codeGraphCacheStats.symbolIndexFullBuilds = 0;
  _codeGraphCacheStats.symbolIndexIncrementalBuilds = 0;
  _codeGraphCacheStats.dirtyPathRebuilds = 0;
  _codeGraphCacheStats.fullWalkBuilds = 0;
  if (_diskCodeGraphCacheFlushTimer) {
    clearTimeout(_diskCodeGraphCacheFlushTimer);
    _diskCodeGraphCacheFlushTimer = null;
  }
}

export function markCodeGraphDirtyPaths(cwd, paths) {
  const key = _canonicalGraphCwd(cwd);
  const values = Array.isArray(paths) ? paths : [paths];
  const cleaned = values
    .filter(Boolean)
    .map((p) => _canonicalGraphPath(p));
  if (cleaned.length === 0) return;
  if (!_codeGraphDirtyPaths.has(key)) _codeGraphDirtyPaths.set(key, new Set());
  const set = _codeGraphDirtyPaths.get(key);
  for (const p of cleaned) set.add(p);
}

function _consumeCodeGraphDirtyPaths(cwd) {
  const key = _canonicalGraphCwd(cwd);
  const set = _codeGraphDirtyPaths.get(key);
  if (!set || set.size === 0) return [];
  _codeGraphDirtyPaths.delete(key);
  return [...set];
}

function _pushIndexSet(map, key, value) {
  if (!key || !value) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function _resolveJsLikeImport(absPath, spec) {
  if (!spec.startsWith('.')) return null;
  const base = pathResolve(dirname(absPath), spec);
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    pathResolve(base, 'index.ts'),
    pathResolve(base, 'index.tsx'),
    pathResolve(base, 'index.js'),
    pathResolve(base, 'index.jsx'),
    pathResolve(base, 'index.mjs'),
    pathResolve(base, 'index.cjs'),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

function _resolvePyImport(absPath, spec, rootDir) {
  if (!spec) return null;
  if (spec.startsWith('.')) {
    const levels = spec.match(/^\.+/)?.[0]?.length || 0;
    const moduleTail = spec.slice(levels).replace(/\./g, '/');
    let base = dirname(absPath);
    for (let i = 1; i < levels; i++) base = dirname(base);
    const target = moduleTail ? pathResolve(base, moduleTail) : base;
    return [`${target}.py`, pathResolve(target, '__init__.py')].find((p) => existsSync(p)) || null;
  }
  const target = pathResolve(rootDir, spec.replace(/\./g, '/'));
  return [`${target}.py`, pathResolve(target, '__init__.py')].find((p) => existsSync(p)) || null;
}

function _resolveInclude(absPath, spec, rootDir) {
  const norm = _normalizeImportSpec(spec);
  const rel = pathResolve(dirname(absPath), norm);
  if (existsSync(rel)) return rel;
  const root = pathResolve(rootDir, norm);
  if (existsSync(root)) return root;
  return null;
}

function _resolveRubyImport(absPath, spec, rootDir) {
  const norm = _normalizeImportSpec(spec);
  const relBase = pathResolve(dirname(absPath), norm);
  const rootBase = pathResolve(rootDir, norm);
  const candidates = [
    `${relBase}.rb`,
    pathResolve(relBase, 'index.rb'),
    `${rootBase}.rb`,
    pathResolve(rootBase, 'index.rb'),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

function _extractPackageName(text, lang) {
  if (lang === 'java' || lang === 'kotlin') {
    return /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;?\s*$/m.exec(String(text || ''))?.[1] || '';
  }
  return '';
}

function _extractNamespaceName(text, lang) {
  if (lang === 'csharp') {
    return /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*[;{]/m.exec(String(text || ''))?.[1] || '';
  }
  return '';
}

function _extractGoPackageName(text) {
  return /^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/m.exec(String(text || ''))?.[1] || '';
}

function _extractTopLevelTypeNames(text, lang) {
  const out = new Set();
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    let match = null;
    if (lang === 'java' || lang === 'kotlin' || lang === 'csharp') {
      match = /\b(?:class|interface|enum|record|object|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    } else if (lang === 'go') {
      match = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
    }
    if (match?.[1]) out.add(match[1]);
  }
  return [...out];
}

function _extractIdentifierTokens(text) {
  const out = new Set();
  const re = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  let match = null;
  const src = String(text || '');
  while ((match = re.exec(src))) {
    out.add(match[0]);
  }
  return [...out];
}

function _getTokenSymbolsForNode(graph, node) {
  if (Array.isArray(node?.tokenSymbols)) return node.tokenSymbols;
  const text = _getSourceTextForNode(graph, node);
  const tokens = _extractIdentifierTokens(text);
  node.tokenSymbols = tokens;
  return tokens;
}

function _cloneSymbolTokenIndex(index) {
  const out = new Map();
  for (const [key, rels] of index || []) {
    out.set(key, Array.isArray(rels) ? [...rels] : []);
  }
  return out;
}

function _ensureSymbolTokenIndex(graph) {
  if (!graph?._symbolTokenIndex) return;
  if (!graph._symbolTokenIndexDirty && graph._symbolTokenIndex.size > 0) return;
  graph._symbolTokenIndex.clear();
  _codeGraphCacheStats.symbolIndexFullBuilds++;
  for (const node of graph.nodes.values()) {
    for (const symbol of _getTokenSymbolsForNode(graph, node)) {
      const key = `${node.lang}|${symbol}`;
      if (!graph._symbolTokenIndex.has(key)) graph._symbolTokenIndex.set(key, []);
      graph._symbolTokenIndex.get(key).push(node.rel);
    }
  }
  graph._symbolTokenIndexDirty = false;
}

function _buildFileInfosFromPreviousGraph(previousGraph, absRoot) {
  const out = new Map();
  for (const node of previousGraph?.nodes?.values?.() || []) {
    out.set(node.rel, {
      abs: node.abs,
      rel: node.rel,
      lang: node.lang,
      fingerprint: node.fingerprint || '',
      sourceText: previousGraph?._sourceTextCache?.get(node.rel)?.fingerprint === (node.fingerprint || '')
        ? previousGraph._sourceTextCache.get(node.rel).text
        : null,
      rawImports: Array.isArray(node.rawImports) ? node.rawImports : [],
      packageName: node.packageName || '',
      namespaceName: node.namespaceName || '',
      goPackageName: node.goPackageName || '',
      goImportPath: node.goImportPath || '',
      topLevelTypes: Array.isArray(node.topLevelTypes) ? node.topLevelTypes : [],
      tokenSymbols: Array.isArray(node.tokenSymbols) ? node.tokenSymbols : null,
    });
  }
  return out;
}

function _recomputeFileInfo(absPath, rel, lang, fingerprint, absRoot, goModuleCache) {
  let text = '';
  try { text = readFileSync(absPath, 'utf8'); } catch { return null; }
  const goModule = lang === 'go' ? _findNearestGoModule(absPath, absRoot, goModuleCache) : null;
  const goImportPath = goModule
    ? [goModule.modulePath, normalizeInputPath(pathRelative(goModule.moduleRoot, dirname(absPath))).replace(/\\/g, '/')].filter(Boolean).join('/').replace(/\/$/, '')
    : '';
  return {
    abs: absPath,
    rel,
    lang,
    fingerprint,
    sourceText: text,
    rawImports: _extractRawImports(text, lang),
    packageName: _extractPackageName(text, lang),
    namespaceName: _extractNamespaceName(text, lang),
    goPackageName: lang === 'go' ? _extractGoPackageName(text) : '',
    goImportPath,
    topLevelTypes: _extractTopLevelTypeNames(text, lang),
    tokenSymbols: null,
  };
}

function _tryFastDirtyPathFileInfos(previousGraph, cwd, dirtyPaths, absRoot) {
  if (!previousGraph || dirtyPaths.length === 0) return null;
  const fileInfoMap = _buildFileInfosFromPreviousGraph(previousGraph, absRoot);
  const goModuleCache = new Map();
  for (const dirtyPath of dirtyPaths) {
    let stat = null;
    try { stat = statSync(dirtyPath); } catch {}
    if (stat?.isDirectory?.()) return null;
    const rel = normalizeInputPath(pathRelative(absRoot, dirtyPath)).replace(/\\/g, '/');
    if (rel.startsWith('..')) return null;
    const lang = _graphLanguage(dirtyPath);
    if (!stat) {
      fileInfoMap.delete(rel);
      continue;
    }
    if (!lang) {
      fileInfoMap.delete(rel);
      continue;
    }
    const fingerprint = _fileFingerprint(rel, stat);
    const next = _recomputeFileInfo(dirtyPath, rel, lang, fingerprint, absRoot, goModuleCache);
    if (next) fileInfoMap.set(rel, next);
  }
  return [...fileInfoMap.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

function _parseGoModulePath(text) {
  return /^\s*module\s+(\S+)\s*$/m.exec(String(text || ''))?.[1] || '';
}

function _findNearestGoModule(absPath, rootDir, cache) {
  const rootAbs = pathResolve(rootDir);
  let dir = dirname(absPath);
  while (dir.startsWith(rootAbs)) {
    if (cache.has(dir)) return cache.get(dir);
    const goModAbs = pathResolve(dir, 'go.mod');
    if (existsSync(goModAbs)) {
      let modulePath = '';
      try { modulePath = _parseGoModulePath(readFileSync(goModAbs, 'utf8')); } catch { /* ignore */ }
      const info = modulePath ? { moduleRoot: dir, modulePath } : null;
      cache.set(dir, info);
      return info;
    }
    if (dir === rootAbs) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function _extractRawImports(text, lang) {
  const imports = [];
  const push = (v) => { if (v) imports.push(_normalizeImportSpec(v)); };
  if (lang === 'typescript' || lang === 'javascript') {
    const re = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(text))) push(m[1] || m[2] || m[3]);
  } else if (lang === 'python') {
    let m;
    const fromRe = /^\s*from\s+([.\w]+)\s+import\s+/gm;
    while ((m = fromRe.exec(text))) push(m[1]);
    const importRe = /^\s*import\s+([A-Za-z0-9_., ]+)/gm;
    while ((m = importRe.exec(text))) {
      for (const part of m[1].split(',')) push(part.trim().split(/\s+as\s+/i)[0]);
    }
  } else if (lang === 'go') {
    const re = /import\s*(?:\(([\s\S]*?)\)|"([^"]+)")/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[2]) { push(m[2]); continue; }
      const block = m[1] || '';
      const strRe = /"([^"]+)"/g;
      let sm;
      while ((sm = strRe.exec(block))) push(sm[1]);
    }
  } else if (lang === 'rust') {
    let m;
    const re = /^\s*use\s+([^;]+);/gm;
    while ((m = re.exec(text))) push(m[1]);
  } else if (lang === 'java' || lang === 'kotlin') {
    let m;
    const re = /^\s*import\s+([^\n;]+);?$/gm;
    while ((m = re.exec(text))) push(m[1]);
  } else if (lang === 'csharp') {
    let m;
    const re = /^\s*using\s+([^;]+);$/gm;
    while ((m = re.exec(text))) push(m[1]);
  } else if (lang === 'c' || lang === 'cpp') {
    let m;
    const re = /^\s*#include\s+"([^"]+)"/gm;
    while ((m = re.exec(text))) push(m[1]);
  } else if (lang === 'ruby') {
    let m;
    const re = /^\s*require(?:_relative)?\s+["']([^"']+)["']/gm;
    while ((m = re.exec(text))) push(m[1]);
  } else if (lang === 'php') {
    let m;
    const re = /^\s*use\s+([^;]+);$/gm;
    while ((m = re.exec(text))) push(m[1]);
  }
  return Array.from(new Set(imports));
}

function _resolveGraphImport(absPath, spec, lang, rootDir) {
  if (lang === 'typescript' || lang === 'javascript') return _resolveJsLikeImport(absPath, spec);
  if (lang === 'python') return _resolvePyImport(absPath, spec, rootDir);
  if (lang === 'c' || lang === 'cpp') return _resolveInclude(absPath, spec, rootDir);
  if (lang === 'ruby') return _resolveRubyImport(absPath, spec, rootDir);
  return null;
}

function _buildGraphIndex(fileInfos) {
  const index = {
    packageMembers: new Map(),
    typeByFqcn: new Map(),
    csharpNamespaces: new Map(),
    goImportPaths: new Map(),
  };
  for (const info of fileInfos) {
    if (info.lang === 'java' || info.lang === 'kotlin') {
      if (info.packageName) _pushIndexSet(index.packageMembers, info.packageName, info.abs);
      for (const typeName of info.topLevelTypes) {
        const fqcn = info.packageName ? `${info.packageName}.${typeName}` : typeName;
        _pushIndexSet(index.typeByFqcn, fqcn, info.abs);
      }
      continue;
    }
    if (info.lang === 'csharp') {
      if (info.namespaceName) _pushIndexSet(index.csharpNamespaces, info.namespaceName, info.abs);
      continue;
    }
    if (info.lang === 'go') {
      if (info.goImportPath) _pushIndexSet(index.goImportPaths, info.goImportPath, info.abs);
    }
  }
  return index;
}

function _normalizeJavaLikeImport(spec) {
  let cleaned = _normalizeImportSpec(spec).replace(/^static\s+/i, '');
  while (cleaned.split('.').length > 1) {
    if (cleaned.endsWith('.*')) return cleaned;
    return cleaned;
  }
  return cleaned;
}

function _resolveIndexedGraphImport(info, spec, rootDir, index) {
  const normalized = _normalizeImportSpec(spec);
  if (!normalized) return [];
  const direct = _resolveGraphImport(info.abs, normalized, info.lang, rootDir);
  if (direct) return [direct];

  if (info.lang === 'go') {
    return [...(index.goImportPaths.get(normalized) || [])];
  }

  if (info.lang === 'java' || info.lang === 'kotlin') {
    let cleaned = _normalizeJavaLikeImport(normalized);
    if (cleaned.endsWith('.*')) {
      return [...(index.packageMembers.get(cleaned.slice(0, -2)) || [])];
    }
    if (index.typeByFqcn.has(cleaned)) return [...index.typeByFqcn.get(cleaned)];
    while (cleaned.split('.').length > 1) {
      cleaned = cleaned.slice(0, cleaned.lastIndexOf('.'));
      if (index.typeByFqcn.has(cleaned)) return [...index.typeByFqcn.get(cleaned)];
    }
    return [];
  }

  if (info.lang === 'csharp') {
    let cleaned = normalized.replace(/^static\s+/i, '').trim();
    const alias = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/.exec(cleaned);
    if (alias?.[1]) cleaned = alias[1].trim();
    if (index.csharpNamespaces.has(cleaned)) return [...index.csharpNamespaces.get(cleaned)];
    while (cleaned.includes('.')) {
      cleaned = cleaned.slice(0, cleaned.lastIndexOf('.'));
      if (index.csharpNamespaces.has(cleaned)) return [...index.csharpNamespaces.get(cleaned)];
    }
    return [];
  }

  return [];
}

function _extractSymbolsCheap(text, lang) {
  const out = _collectCheapSymbols(text, lang).map((item) => `${item.kind} ${item.name} (L${item.line})`);
  return out.length ? out.join('\n') : '(no symbols)';
}

function _collectCheapSymbols(text, lang) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const push = (kind, name, idx) => {
    if (!name) return;
    out.push({ kind, name, line: idx + 1 });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = null;
    if (lang === 'typescript' || lang === 'javascript') {
      if ((m = /\b(class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push(m[1], m[2], i);
      else if ((m = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line))) push('function', m[1], i);
      else if ((m = /\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line))) push('binding', m[1], i);
      else if ((m = /^\s*(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/.exec(line))) push('method', m[1], i);
    } else if (lang === 'python') {
      if ((m = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push('class', m[1], i);
      else if ((m = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push('function', m[1], i);
    } else if (lang === 'go') {
      if ((m = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/.exec(line))) push('struct', m[1], i);
      else if ((m = /^\s*func(?:\s*\([^)]*\))?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line))) push('function', m[1], i);
    } else if (lang === 'rust') {
      if ((m = /^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push('struct', m[1], i);
      else if ((m = /^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line))) push('function', m[1], i);
    } else if (lang === 'java' || lang === 'kotlin' || lang === 'csharp') {
      if ((m = /\b(class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push(m[1], m[2], i);
      else if ((m = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/.exec(line))) push('function', m[1], i);
    } else if (lang === 'c' || lang === 'cpp') {
      if ((m = /\b(class|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) push(m[1], m[2], i);
      else if ((m = /^\s*[A-Za-z_][\w\s:*<>~]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/.exec(line))) push('function', m[1], i);
    } else if (lang === 'ruby' || lang === 'php') {
      if ((m = /^\s*class\s+([A-Za-z_][A-Za-z0-9_:]*)/.exec(line))) push('class', m[1], i);
      else if ((m = /^\s*def\s+([A-Za-z_][A-Za-z0-9_!?=]*)/.exec(line))) push('function', m[1], i);
    }
  }
  return out;
}

function _extractExplainerAnchorLines(node, graph, { limit = 6, maxLineChars = 180 } = {}) {
  const sourceLines = _getSourceTextForNode(graph, node).split(/\r?\n/);
  const symbols = _collectCheapSymbols(sourceLines.join('\n'), node.lang);
  const out = [];
  const seen = new Set();
  for (const item of symbols) {
    if (out.length >= limit) break;
    const idx = item.line - 1;
    const line = String(sourceLines[idx] || '').trim();
    if (!line) continue;
    const key = `${item.name}:${item.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${item.kind} ${item.name} (L${item.line}): ${line.slice(0, maxLineChars)}`);
  }
  return out;
}

function _graphRel(absPath, cwd) {
  return toDisplayPath(absPath, cwd);
}


function _supportsHashComments(lang) {
  return lang === 'python' || lang === 'ruby' || lang === 'php';
}

function _supportsSlashComments(lang) {
  return lang !== 'python' && lang !== 'ruby';
}

function _supportsSingleQuoteStrings(lang) {
  return lang === 'typescript'
    || lang === 'javascript'
    || lang === 'python'
    || lang === 'ruby'
    || lang === 'php';
}

function _supportsBacktickStrings(lang) {
  return lang === 'typescript' || lang === 'javascript' || lang === 'go';
}

function _supportsTripleQuoteStrings(lang) {
  return lang === 'python' || lang === 'kotlin';
}

function _maskNonCodeText(text, lang) {
  const src = String(text || '');
  const out = src.split('');
  let i = 0;
  let blockComment = false;
  let stringDelim = null;
  while (i < src.length) {
    if (blockComment) {
      if (src.startsWith('*/', i)) {
        out[i] = ' ';
        if (i + 1 < out.length) out[i + 1] = ' ';
        i += 2;
        blockComment = false;
        continue;
      }
      if (src[i] !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (stringDelim) {
      if ((stringDelim === "'''" || stringDelim === '"""') && src.startsWith(stringDelim, i)) {
        for (let j = 0; j < stringDelim.length; j++) {
          if (src[i + j] !== '\n') out[i + j] = ' ';
        }
        i += stringDelim.length;
        stringDelim = null;
        continue;
      }
      if ((stringDelim === '\'' || stringDelim === '"' || stringDelim === '`') && src[i] === '\\') {
        if (src[i] !== '\n') out[i] = ' ';
        if (i + 1 < src.length && src[i + 1] !== '\n') out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if ((stringDelim === '\'' || stringDelim === '"' || stringDelim === '`') && src[i] === stringDelim) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
        stringDelim = null;
        continue;
      }
      if (src[i] !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (_supportsSlashComments(lang) && src.startsWith('/*', i)) {
      out[i] = ' ';
      if (i + 1 < out.length) out[i + 1] = ' ';
      i += 2;
      blockComment = true;
      continue;
    }
    if (_supportsSlashComments(lang) && src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (_supportsHashComments(lang) && src[i] === '#') {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (_supportsTripleQuoteStrings(lang) && src.startsWith("'''", i)) {
      out[i] = ' ';
      if (i + 1 < out.length) out[i + 1] = ' ';
      if (i + 2 < out.length) out[i + 2] = ' ';
      i += 3;
      stringDelim = "'''";
      continue;
    }
    if (_supportsTripleQuoteStrings(lang) && src.startsWith('"""', i)) {
      out[i] = ' ';
      if (i + 1 < out.length) out[i + 1] = ' ';
      if (i + 2 < out.length) out[i + 2] = ' ';
      i += 3;
      stringDelim = '"""';
      continue;
    }
    if (src[i] === '"' || (_supportsSingleQuoteStrings(lang) && src[i] === '\'') || (_supportsBacktickStrings(lang) && src[i] === '`')) {
      if (src[i] !== '\n') out[i] = ' ';
      stringDelim = src[i];
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

function _symbolMatchIndices(text, symbol, lang) {
  const escaped = String(symbol || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return [];
  const masked = _maskNonCodeText(text, lang);
  const re = new RegExp(`\\b${escaped}\\b`, 'g');
  const indices = [];
  let match = null;
  while ((match = re.exec(masked))) {
    indices.push(match.index);
  }
  return indices;
}

function _getSourceTextForNode(graph, node, fallbackText = null) {
  const cached = graph?._sourceTextCache?.get(node.rel);
  if (cached && cached.fingerprint === (node.fingerprint || '')) {
    _codeGraphCacheStats.sourceTextCacheHits++;
    return cached.text;
  }
  if (typeof fallbackText === 'string') {
    _codeGraphCacheStats.sourceTextCacheHits++;
    graph?._sourceTextCache?.set(node.rel, {
      fingerprint: node.fingerprint || '',
      text: fallbackText,
    });
    return fallbackText;
  }
  _codeGraphCacheStats.sourceTextCacheMisses++;
  let text = '';
  try { text = readFileSync(node.abs, 'utf8'); } catch { text = ''; }
  graph?._sourceTextCache?.set(node.rel, {
    fingerprint: node.fingerprint || '',
    text,
  });
  return text;
}

function _buildExplainerFileSummary(node, graph, cwd) {
  const topTypes = Array.isArray(node?.topLevelTypes) ? node.topLevelTypes.slice(0, 8) : [];
  const imports = Array.isArray(node?.resolvedImports) ? node.resolvedImports.map((p) => _graphRel(p, cwd)).slice(0, 8) : [];
  const tokens = _getTokenSymbolsForNode(graph, node).slice(0, 20);
  const anchors = _extractExplainerAnchorLines(node, graph);
  const sourceHead = _getSourceTextForNode(graph, node)
    .split(/\r?\n/)
    .slice(0, 6)
    .join('\n')
    .trim()
    .slice(0, 420);
  const parts = [
    `file: ${node.rel}`,
    `language: ${node.lang}`,
  ];
  if (topTypes.length) parts.push(`top-level: ${topTypes.join(', ')}`);
  if (tokens.length) parts.push(`symbols: ${tokens.join(', ')}`);
  if (imports.length) parts.push(`imports: ${imports.join(', ')}`);
  if (anchors.length) parts.push(`anchors:\n${anchors.join('\n')}`);
  if (sourceHead) parts.push(`head:\n${sourceHead}`);
  return parts.join('\n');
}

function _getMaskedLinesForNode(graph, node) {
  const cached = graph?._maskedLinesCache?.get(node.rel);
  if (cached && cached.fingerprint === (node.fingerprint || '')) {
    _codeGraphCacheStats.maskedLineCacheHits++;
    return cached.lines;
  }
  _codeGraphCacheStats.maskedLineCacheMisses++;
  const text = _getSourceTextForNode(graph, node);
  const lines = _maskNonCodeText(text, node.lang).split(/\r?\n/);
  graph?._maskedLinesCache?.set(node.rel, {
    fingerprint: node.fingerprint || '',
    lines,
  });
  return lines;
}

function _cheapReferenceSearch(graph, symbol, cwd, { language = null } = {}) {
  const escaped = String(symbol || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return '(no references)';
  const cacheKey = `${language || '*'}|${symbol}`;
  const cached = graph?._referenceSearchCache?.get(cacheKey);
  if (typeof cached === 'string') {
    _codeGraphCacheStats.referenceQueryHits++;
    return cached;
  }
  _codeGraphCacheStats.referenceQueryMisses++;
  const re = new RegExp(`\\b${escaped}\\b`, 'g');
  const lines = [];
  _ensureSymbolTokenIndex(graph);
  const indexKey = `${language || '*'}|${symbol}`;
  const indexedFiles = graph?._symbolTokenIndex?.get(indexKey);
  const candidateNodes = indexedFiles
    ? indexedFiles.map((rel) => graph.nodes.get(rel)).filter(Boolean)
    : [...graph.nodes.values()].filter((node) => !language || node.lang === language);
  if (indexedFiles) _codeGraphCacheStats.symbolIndexHits++;
  else _codeGraphCacheStats.symbolIndexMisses++;
  // Output cap. Default 40 hits / 80 chars per lineText — enough to spot the
  // declaration plus the major usage clusters, while preventing a 2k+ token
  // dump on commonly-referenced helpers (`logger`, `cfg`, `db`). Hit overflow
  // appends a single `... +N more references` footer so the caller knows the
  // result was clipped. Override via REFERENCE_HIT_CAP / REFERENCE_LINE_CAP
  // env when a one-off audit needs the full surface.
  const REFERENCE_HIT_CAP = Math.max(1, Number(process.env.REFERENCE_HIT_CAP) || 40);
  const REFERENCE_LINE_CAP = Math.max(20, Number(process.env.REFERENCE_LINE_CAP) || 80);
  let totalHits = 0;
  outer: for (const node of candidateNodes) {
    const sourceText = _getSourceTextForNode(graph, node);
    if (!sourceText.includes(symbol)) continue;
    const fileLines = _getMaskedLinesForNode(graph, node);
    for (let i = 0; i < fileLines.length; i++) {
      const line = fileLines[i];
      if (!line.trim()) continue;
      re.lastIndex = 0;
      let match = null;
      while ((match = re.exec(line))) {
        totalHits += 1;
        if (lines.length < REFERENCE_HIT_CAP) {
          const trimmed = line.trim().slice(0, REFERENCE_LINE_CAP);
          lines.push(`${node.rel}:${i + 1}:${match.index + 1}    ${trimmed}`);
        } else if (totalHits > REFERENCE_HIT_CAP * 4) {
          break outer;
        }
      }
    }
  }
  if (totalHits > lines.length) {
    lines.push(`... +${totalHits - lines.length} more references (raise REFERENCE_HIT_CAP to widen)`);
  }
  const result = lines.length ? lines.join('\n') : '(no references)';
  graph?._referenceSearchCache?.set(cacheKey, result);
  return result;
}

function _findSymbolHits(graph, symbol, { language = null } = {}) {
  const cleanSymbol = String(symbol || '').trim();
  if (!cleanSymbol) return [];
  _ensureSymbolTokenIndex(graph);

  const indexKey = `${language || '*'}|${cleanSymbol}`;
  const indexedFiles = graph?._symbolTokenIndex?.get(indexKey);
  const candidateNodes = indexedFiles
    ? indexedFiles.map((rel) => graph.nodes.get(rel)).filter(Boolean)
    : [...graph.nodes.values()].filter((node) => !language || node.lang === language);

  const escaped = cleanSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'g');
  // Declaration regex must anchor the symbol immediately after a
  // declaration keyword. The previous pattern (`\bkeyword\b[^\n]*\bX\b`)
  // matched ordinary callsites like `const result = doFoo(X)` as a
  // declaration of X, producing a wrong "best declaration candidate".
  // Allow optional `export [default]` / `async` modifiers and `function*`.
  const declRe = new RegExp(
    `(?:^|[\\s;{(,])(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:const|let|var|function\\*?|class|interface|type|enum|def)\\s+${escaped}\\b`
  );
  const hits = [];

  for (const node of candidateNodes) {
    const sourceText = _getSourceTextForNode(graph, node);
    if (!sourceText.includes(cleanSymbol)) continue;
    const sourceLines = sourceText.split(/\r?\n/);
    const lines = _getMaskedLinesForNode(graph, node);
    let firstLine = null;
    let firstCol = null;
    let matchCount = 0;
    let firstContent = '';
    let contextLines = [];
    let declarationLike = Array.isArray(node.topLevelTypes) && node.topLevelTypes.includes(cleanSymbol);
    let declLine = null;
    let declCol = null;
    let declContent = '';
    let declContext = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      re.lastIndex = 0;
      let localHit = false;
      let match = null;
      while ((match = re.exec(line))) {
        matchCount += 1;
        localHit = true;
        if (firstLine == null) {
          firstLine = i + 1;
          firstCol = match.index + 1;
          firstContent = String(sourceLines[i] || '').trim();
          contextLines = sourceLines.slice(i, i + 3).map((line) => String(line || '').trim()).filter(Boolean);
        }
        if (declLine == null && declRe.test(line)) {
          declLine = i + 1;
          declCol = match.index + 1;
          declContent = String(sourceLines[i] || '').trim();
          declContext = sourceLines.slice(i, i + 3).map((l) => String(l || '').trim()).filter(Boolean);
        }
      }
      if (localHit && declRe.test(line)) declarationLike = true;
    }
    if (firstLine == null) continue;
    const hasDeclPos = declLine != null;
    hits.push({
      rel: node.rel,
      lang: node.lang,
      line: hasDeclPos ? declLine : firstLine,
      col: hasDeclPos ? declCol : (firstCol || 1),
      declarationLike,
      matchCount,
      content: hasDeclPos ? declContent : firstContent,
      context: hasDeclPos ? declContext : contextLines,
      firstLine,
      firstCol: firstCol || 1,
      firstContent,
      firstContext: contextLines,
    });
  }

  if (!hits.length) return [];

  hits.sort((a, b) =>
    Number(b.declarationLike) - Number(a.declarationLike)
    || a.rel.localeCompare(b.rel)
    || a.line - b.line
  );
  return hits;
}

function _findSymbolAcrossGraph(graph, symbol, cwd, { language = null, limit = 5 } = {}) {
  // Caller-supplied `language` is a hard scope: never widen to other
  // languages on miss. Returning a different-language hit was producing
  // misleading results when callers wanted strict language-narrowed
  // analysis.
  const hits = _findSymbolHits(graph, symbol, { language });

  if (!hits.length) return '(no symbol matches)';

  const topHits = hits.slice(0, Math.max(1, limit));
  const primary = topHits[0];
  const declHits = hits.filter((h) => h.declarationLike);
  const declCount = declHits.length;
  const lines = [];
  if (primary?.declarationLike) {
    lines.push('# best declaration candidate');
    const multi = declCount > 1 ? `, declarations=${declCount}` : '';
    lines.push(`${primary.rel}:${primary.line}:${primary.col} (${primary.lang}, matches=${primary.matchCount}${multi})`);
    if (primary.content) lines.push(primary.content.slice(0, 100));
    if (Array.isArray(primary.context) && primary.context.length > 1) {
      lines.push(`context: ${primary.context.slice(0, 2).join(' | ').slice(0, 120)}`);
    }
    if (declCount > 1) {
      const others = declHits.slice(1, 3).map((h) => `${h.rel}:${h.line}:${h.col} [${h.lang}]`);
      if (others.length) lines.push(`other declarations: ${others.join(', ')}`);
    }
    lines.push('');
  }
  lines.push('# candidates');
  lines.push(...topHits.map((hit, idx) => {
    const kind = hit.declarationLike ? 'decl' : 'ref';
    const suffix = hit.content ? ` — ${hit.content.slice(0, 100)}` : '';
    return `${idx + 1}. ${hit.rel}:${hit.line}:${hit.col} [${kind}, ${hit.lang}, matches=${hit.matchCount}]${suffix}`;
  }));
  return lines.join('\n');
}

function _resolveReferenceLanguageNode(graph, symbol, rel, cwd, language = null) {
  if (rel) {
    const node = graph.nodes.get(rel);
    if (node) return node;
  }
  const hits = _findSymbolHits(graph, symbol, { language });
  // Caller-specified language is a hard filter — refuse to widen on miss so
  // a `language: 'python'` query never bleeds into TS/JS results.
  if (!hits.length) return null;
  const primary = hits.find((hit) => hit.declarationLike) || hits[0];
  return primary?.rel ? graph.nodes.get(primary.rel) || null : null;
}

function _collapseReferenceLinesToCallers(referenceText) {
  if (typeof referenceText !== 'string' || !referenceText.trim() || referenceText === '(no references)') {
    return '(no callers)';
  }
  const files = new Set();
  for (const line of referenceText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(.+?):\d+:\d+(?:[\s\t]+.*)?$/.exec(trimmed);
    if (m) files.add(m[1]);
  }
  if (files.size === 0) return '(no callers)';
  return [...files].sort().join('\n');
}

function _referenceKind(line, symbol) {
  const escaped = String(symbol || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return 'reference';
  const text = String(line || '');
  if (new RegExp(`\\b(?:function|class|interface|type|enum)\\s+${escaped}\\b`).test(text)) return 'declaration';
  if (new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`).test(text)) return 'declaration';
  if (new RegExp(`\\bimport\\b[\\s\\S]*\\b${escaped}\\b`).test(text)) return 'import';
  if (new RegExp(`\\b${escaped}\\s*\\(`).test(text)) return 'call';
  return 'reference';
}

function _nearestEnclosingSymbol(sourceText, lang, lineNumber) {
  const symbols = _collectCheapSymbols(sourceText, lang)
    .filter((item) => item.line <= lineNumber)
    .sort((a, b) => b.line - a.line);
  return symbols[0] || null;
}

function _formatCallerReferences(graph, symbol, referenceText, { limit = 40 } = {}) {
  const entries = _parseReferenceEntries(referenceText);
  if (!entries.length) return '(no callers)';
  const detailed = [];
  for (const entry of entries) {
    const node = graph.nodes.get(entry.file);
    if (!node) continue;
    const sourceText = _getSourceTextForNode(graph, node);
    const sourceLines = sourceText.split(/\r?\n/);
    const line = String(sourceLines[entry.line - 1] || '').trim();
    if (!line) continue;
    const kind = _referenceKind(line, symbol);
    const enclosing = _nearestEnclosingSymbol(sourceText, node.lang, entry.line);
    detailed.push({
      ...entry,
      kind,
      caller: kind === 'call' ? (enclosing?.name || '') : '',
      lineText: line,
    });
  }
  if (!detailed.length) return '(no callers)';

  const callSites = detailed.filter((entry) => entry.kind === 'call');
  const format = (entry) => {
    const caller = entry.caller ? `\tcaller=${entry.caller}` : '';
    return `${entry.file}:${entry.line}:${entry.col}\t${entry.kind}${caller}\t${entry.lineText.slice(0, 80)}`;
  };
  if (callSites.length) {
    const total = callSites.length;
    const head = callSites.slice(0, limit).map(format);
    const overflow = total > limit ? [`... +${total - limit} more call sites`] : [];
    return ['# call sites', ...head, ...overflow].join('\n');
  }

  const NON_CALL_CAP = 40;
  const nonCallEntries = detailed.slice(0, NON_CALL_CAP);
  const overflow = detailed.length > NON_CALL_CAP
    ? `\n... +${detailed.length - NON_CALL_CAP} more non-call references`
    : '';
  return [
    '(no call sites)',
    nonCallEntries.length ? `# non-call references\n${nonCallEntries.map(format).join('\n')}${overflow}` : '',
  ].filter(Boolean).join('\n');
}

function _referenceFiles(referenceText) {
  if (typeof referenceText !== 'string' || !referenceText.trim() || referenceText === '(no references)') {
    return [];
  }
  const files = new Set();
  for (const line of referenceText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(.+?):\d+:\d+(?:[\s\t]+.*)?$/.exec(trimmed);
    if (m) files.add(m[1]);
  }
  return [...files].sort();
}

function _parseReferenceEntries(referenceText) {
  if (typeof referenceText !== 'string' || !referenceText.trim() || referenceText === '(no references)') {
    return [];
  }
  const out = [];
  for (const line of referenceText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(.+?):(\d+):(\d+)(?:[\s\t]+(.*))?$/.exec(trimmed);
    if (!m) continue;
    out.push({
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
      text: m[4] ? m[4].trim() : '',
    });
  }
  return out;
}

function _formatSymbolImpactLine(item) {
  const callerSuffix = item.callers.length ? ` -> ${item.callers.join(', ')}` : '';
  return `${item.symbol}\trefs=${item.references}\tcallers=${item.callers.length}${callerSuffix}`;
}

function _collectImpactSymbols(node, graph) {
  const names = new Set();
  for (const typeName of Array.isArray(node?.topLevelTypes) ? node.topLevelTypes : []) names.add(typeName);
  const text = _getSourceTextForNode(graph, node);
  for (const item of _collectCheapSymbols(text, node.lang)) names.add(item.name);
  return [...names];
}

function _buildImpactSummary(node, graph, cwd, targetSymbol = '') {
  const imports = node.resolvedImports.map((p) => _graphRel(p, cwd));
  const dependents = [...(graph.reverse.get(node.rel) || [])].sort();
  const related = [...new Set([...imports, ...dependents])].sort();
  const symbols = targetSymbol ? [targetSymbol] : _collectImpactSymbols(node, graph).slice(0, 8);
  const symbolImpact = [];
  const externalCallers = new Set();
  let externalReferences = 0;
  for (const symbol of symbols) {
    const refs = _parseReferenceEntries(_cheapReferenceSearch(graph, symbol, cwd, { language: node.lang }))
      .filter((entry) => entry.file !== node.rel);
    if (refs.length === 0) continue;
    const callers = [...new Set(refs.map((entry) => entry.file))].sort();
    for (const caller of callers) externalCallers.add(caller);
    externalReferences += refs.length;
    symbolImpact.push({
      symbol,
      references: refs.length,
      callers,
    });
  }
  symbolImpact.sort((a, b) => (b.references - a.references) || a.symbol.localeCompare(b.symbol));
  return {
    imports,
    dependents,
    related,
    symbolImpact,
    externalCallers: [...externalCallers].sort(),
    externalReferences,
    scannedSymbols: symbols.length,
  };
}

function _formatRelated(node, graph, cwd) {
  const imports = node.resolvedImports.map((p) => _graphRel(p, cwd));
  const dependents = [...(graph.reverse.get(node.rel) || [])].sort();
  const parts = [];
  parts.push(`# imports\n${imports.length ? imports.join('\n') : '(none)'}`);
  parts.push(`# dependents\n${dependents.length ? dependents.join('\n') : '(none)'}`);
  return parts.join('\n\n');
}

function _formatImpact(node, graph, cwd, targetSymbol = '') {
  const summary = _buildImpactSummary(node, graph, cwd, targetSymbol);
  const lines = [
    `file\t${node.rel}`,
    `language\t${node.lang}`,
    `imports\t${summary.imports.length}`,
    `dependents\t${summary.dependents.length}`,
    `related\t${summary.related.length}`,
    `scanned_symbols\t${summary.scannedSymbols}`,
    `external_references\t${summary.externalReferences}`,
    `external_callers\t${summary.externalCallers.length}`,
  ];
  if (targetSymbol) lines.push(`symbol\t${targetSymbol}`);
  if (summary.related.length) {
    lines.push('');
    lines.push('# structural');
    lines.push(...summary.related);
  }
  if (summary.symbolImpact.length) {
    lines.push('');
    lines.push(targetSymbol ? '# symbol impact' : '# top symbol impact');
    lines.push(...summary.symbolImpact.slice(0, 5).map(_formatSymbolImpactLine));
  }
  if (summary.externalCallers.length) {
    lines.push('');
    lines.push('# external callers');
    lines.push(...summary.externalCallers);
  }
  return lines.join('\n');
}

function _buildCodeGraph(cwd) {
  const now = Date.now();
  const graphCwd = _canonicalGraphCwd(cwd);
  const absRoot = graphCwd;
  const cached = _codeGraphCache.get(graphCwd);
  let previousGraph = cached?.graph || null;
  const dirtyPaths = _consumeCodeGraphDirtyPaths(graphCwd);
  let fileInfos = null;
  let fileMetas = null;
  let signature = null;
  if (dirtyPaths.length > 0 && previousGraph) {
    const fast = _tryFastDirtyPathFileInfos(previousGraph, graphCwd, dirtyPaths, absRoot);
    if (fast) {
      fileMetas = _collectGraphFileMetas(absRoot, graphCwd);
      signature = _computeGraphSignature(fileMetas);
      const fastSignature = _computeGraphSignature(fast.map((info) => ({ fp: info.fingerprint })));
      if (signature === fastSignature) {
        fileInfos = fast;
        _codeGraphCacheStats.dirtyPathRebuilds++;
        _codeGraphCacheStats.memoryMisses++;
      }
    }
  }
  if (!fileInfos) {
    if (!fileMetas) fileMetas = _collectGraphFileMetas(absRoot, graphCwd);
    signature = _computeGraphSignature(fileMetas);
    if (cached && cached.signature === signature && now - cached.ts < CODE_GRAPH_TTL_MS) {
      _codeGraphCacheStats.memoryHits++;
      return cached.graph;
    }
    _codeGraphCacheStats.memoryMisses++;
    _loadDiskCodeGraphCache(now);
    const diskEntry = _diskCodeGraphCache.get(graphCwd);
    if (diskEntry?.signature === signature) {
      const graph = _deserializeGraph(graphCwd, diskEntry);
      if (graph) {
        _codeGraphCacheStats.diskHits++;
        _codeGraphCache.set(graphCwd, { ts: now, signature, graph });
        return graph;
      }
    }
    _codeGraphCacheStats.diskMisses++;
    if (!previousGraph && diskEntry) previousGraph = _deserializeGraph(graphCwd, diskEntry);
    _codeGraphCacheStats.fullWalkBuilds++;
    const goModuleCache = new Map();
    fileInfos = [];
    for (const meta of fileMetas) {
      const goModule = meta.lang === 'go' ? _findNearestGoModule(meta.abs, absRoot, goModuleCache) : null;
      const goImportPath = goModule
        ? [goModule.modulePath, normalizeInputPath(pathRelative(goModule.moduleRoot, dirname(meta.abs))).replace(/\\/g, '/')].filter(Boolean).join('/').replace(/\/$/, '')
        : '';
      const previousNode = previousGraph?.nodes?.get(meta.rel) || null;
      if (previousNode
        && previousNode.fingerprint === meta.fp
        && (meta.lang !== 'go' || previousNode.goImportPath === goImportPath)) {
        fileInfos.push({
          abs: meta.abs,
          rel: meta.rel,
          lang: meta.lang,
          fingerprint: meta.fp,
          sourceText: previousGraph?._sourceTextCache?.get(meta.rel)?.fingerprint === meta.fp
            ? previousGraph._sourceTextCache.get(meta.rel).text
            : null,
          rawImports: Array.isArray(previousNode.rawImports) ? previousNode.rawImports : [],
          packageName: previousNode.packageName || '',
          namespaceName: previousNode.namespaceName || '',
          goPackageName: previousNode.goPackageName || '',
          goImportPath: previousNode.goImportPath || goImportPath,
          topLevelTypes: Array.isArray(previousNode.topLevelTypes) ? previousNode.topLevelTypes : [],
          tokenSymbols: Array.isArray(previousNode.tokenSymbols) ? previousNode.tokenSymbols : null,
        });
        _codeGraphCacheStats.reusedNodes++;
        continue;
      }
      const next = _recomputeFileInfo(meta.abs, meta.rel, meta.lang, meta.fp, absRoot, goModuleCache);
      if (!next) continue;
      fileInfos.push(next);
      _codeGraphCacheStats.rebuiltNodes++;
    }
  }
  const index = _buildGraphIndex(fileInfos);
  const nodes = new Map();
  const reverse = new Map();
  for (const info of fileInfos) {
    const resolvedImports = Array.from(new Set(
      info.rawImports
        .flatMap((spec) => _resolveIndexedGraphImport(info, spec, absRoot, index))
        .filter(Boolean),
    ));
    const node = {
      abs: info.abs,
      rel: info.rel,
      lang: info.lang,
      fingerprint: info.fingerprint,
      rawImports: info.rawImports,
      resolvedImportsRel: resolvedImports.map((depAbs) => _graphRel(depAbs, graphCwd)),
      resolvedImports,
      packageName: info.packageName,
      namespaceName: info.namespaceName,
      goPackageName: info.goPackageName,
      goImportPath: info.goImportPath,
      topLevelTypes: info.topLevelTypes,
      tokenSymbols: info.tokenSymbols,
    };
    nodes.set(info.rel, node);
    for (const depAbs of resolvedImports) {
      const depRel = _graphRel(depAbs, graphCwd);
      if (!reverse.has(depRel)) reverse.set(depRel, new Set());
      reverse.get(depRel).add(info.rel);
    }
  }
  const graph = _attachGraphRuntimeCaches({ cwd: graphCwd, nodes, reverse, builtAt: now, signature });
  for (const info of fileInfos) {
    if (typeof info.sourceText === 'string') {
      graph._sourceTextCache.set(info.rel, {
        fingerprint: info.fingerprint || '',
        text: info.sourceText,
      });
    }
  }
  graph._symbolTokenIndexDirty = true;
  _codeGraphCache.set(graphCwd, { ts: now, signature, graph });
  _setDiskCodeGraphEntry(graphCwd, graph);
  return graph;
}

async function codeGraph(args, cwd) {
  const mode = String(args?.mode || '').trim();
  if (!mode) throw new Error('code_graph: "mode" is required');
  const graph = _buildCodeGraph(cwd);
  if (mode === 'overview') {
    const byLang = new Map();
    for (const node of graph.nodes.values()) {
      byLang.set(node.lang, (byLang.get(node.lang) || 0) + 1);
    }
    const lines = [
      `files\t${graph.nodes.size}`,
      `edges\t${Array.from(graph.nodes.values()).reduce((sum, n) => sum + n.resolvedImports.length, 0)}`,
    ];
    for (const [lang, count] of [...byLang.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`${lang}\t${count}`);
    }
    return lines.join('\n');
  }

  const normFile = normalizeInputPath(args?.file);
  const abs = normFile ? (isAbsolute(normFile) ? pathResolve(normFile) : pathResolve(cwd, normFile)) : null;
  const rel = abs ? _graphRel(abs, cwd) : null;
  const node = rel ? graph.nodes.get(rel) : null;

  if (mode === 'imports') {
    if (!node) return `Error: code_graph imports: file not found in graph: ${normFile || '(missing file)'}`;
    const resolved = node.resolvedImports.map((p) => _graphRel(p, cwd));
    const parts = [];
    if (resolved.length) parts.push(resolved.join('\n'));
    if (node.rawImports.length) parts.push(`# raw\n${node.rawImports.join('\n')}`);
    return parts.join('\n\n') || '(no imports)';
  }

  if (mode === 'dependents') {
    if (!rel) throw new Error('code_graph dependents: "file" is required');
    // Validate the path is actually indexed before answering. Without
    // this check, a typo or unsupported extension silently returns
    // "(no dependents)" — indistinguishable from a real zero-dependent
    // file and a frequent source of "graph says nothing depends on X"
    // false negatives.
    if (!node) return `Error: code_graph dependents: file not found in graph: ${normFile || '(missing file)'}`;
    const deps = [...(graph.reverse.get(rel) || [])].sort();
    return deps.length ? deps.join('\n') : '(no dependents)';
  }

  if (mode === 'related') {
    if (!node) return `Error: code_graph related: file not found in graph: ${normFile || '(missing file)'}`;
    return _formatRelated(node, graph, cwd);
  }

  if (mode === 'impact') {
    if (!node) return `Error: code_graph impact: file not found in graph: ${normFile || '(missing file)'}`;
    const targetSymbol = String(args?.symbol || '').trim();
    return _formatImpact(node, graph, cwd, targetSymbol);
  }

  if (mode === 'symbols') {
    if (!node) return `Error: code_graph symbols: file not found in graph: ${normFile || '(missing file)'}`;
    let text = '';
    try { text = readFileSync(node.abs, 'utf8'); } catch { return '(no symbols)'; }
    return _extractSymbolsCheap(text, node.lang);
  }

  if (mode === 'find_symbol') {
    const symbol = String(args?.symbol || '').trim();
    if (!symbol) throw new Error('code_graph find_symbol: "symbol" is required');
    const language = String(args?.language || '').trim() || null;
    const limit = Math.max(1, Math.min(50, Number(args?.limit || 20)));
    return _findSymbolAcrossGraph(graph, symbol, cwd, { language, limit });
  }

  if (mode === 'references') {
    const symbol = String(args?.symbol || '').trim();
    if (!symbol) throw new Error('code_graph references: "symbol" is required');
    const explicitLanguage = String(args?.language || '').trim() || null;
    const narrowedByCaller = Boolean(rel || explicitLanguage);
    const resolvedNode = _resolveReferenceLanguageNode(graph, symbol, rel, cwd, explicitLanguage);
    // Only bail with "file not found" when the caller actually specified a file
    // and that file isn't in the graph. When rel is falsy (no file narrowing),
    // resolvedNode=null just means the symbol has no declaration hit — proceed
    // with a broad language-agnostic search instead of failing.
    if (!resolvedNode && rel) return `Error: code_graph references: file not found in graph: ${normFile || '(missing file)'}`;
    // Bare references (no file/language narrow) → search every language so
    // a symbol with the same name in TS+PY isn't quietly truncated to
    // whichever language the first hit happened to land in.
    const lang = (narrowedByCaller && resolvedNode) ? resolvedNode.lang : null;
    return _cheapReferenceSearch(graph, symbol, cwd, { language: lang });
  }

  if (mode === 'callers') {
    const symbol = String(args?.symbol || '').trim();
    if (!symbol) throw new Error('code_graph callers: "symbol" is required');
    const explicitLanguage = String(args?.language || '').trim() || null;
    const narrowedByCaller = Boolean(rel || explicitLanguage);
    const resolvedNode = _resolveReferenceLanguageNode(graph, symbol, rel, cwd, explicitLanguage);
    if (!resolvedNode && rel) return `Error: code_graph callers: file not found in graph: ${normFile || '(missing file)'}`;
    const lang = (narrowedByCaller && resolvedNode) ? resolvedNode.lang : null;
    const refs = _cheapReferenceSearch(graph, symbol, cwd, { language: lang });
    return _formatCallerReferences(graph, symbol, refs);
  }

  throw new Error(`code_graph: unknown mode "${mode}"`);
}

async function findSymbolTool(args, cwd) {
  const graph = _buildCodeGraph(cwd);
  const symbol = String(args?.symbol || '').trim();
  if (!symbol) throw new Error('find_symbol: "symbol" is required');
  const language = String(args?.language || '').trim() || null;
  const limit = Math.max(1, Math.min(50, Number(args?.limit || 20)));
  return _findSymbolAcrossGraph(graph, symbol, cwd, { language, limit });
}



export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    public: false,
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Repository graph / symbol navigation. Modes: overview, imports, dependents, related, impact, symbols, find_symbol, references, callers. `callers` returns call-site lines + enclosing caller symbol — answer from it before reading files. Use direct aliases (find_*) when available.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'references', 'callers'], description: 'Graph query mode.' },
        file: { type: 'string', description: 'Target file path. Required for imports/dependents/related/impact/symbols. Optional for references/callers. Ignored by overview/find_symbol.' },
        symbol: { type: 'string', description: 'Symbol name. Required for find_symbol/references/callers; optional for impact.' },
        language: { type: 'string', description: 'Optional language filter for find_symbol/references/callers; omit if unsure.' },
        limit: { type: 'number', description: 'Optional result cap for find_symbol. Default 20, max 50.' },
        cwd: { type: 'string', description: 'Override search cwd. If absent, uses caller cwd.' },
      },
      required: ['mode'],
    },
  },
  {
    name: 'find_symbol',
    title: 'Find Symbol',
    annotations: { title: 'Find Symbol', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Symbol-level navigation across the repository. Default mode finds the declaration site for a known identifier (file:line + nearby code). Pass `mode` to switch into graph queries: `callers` (call sites for functions), `references` (all references — use for non-function symbols too), `imports` (what a file imports), `dependents` (who imports a file), or `overview`/`symbols`/`related`/`impact` for file-level analysis. Prefer over grep when the identifier is known but the file is not. Default mode already returns file-grouped reference candidates with matches=N counts; call references mode only when line-level details for every reference are required.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol or identifier. Required for default/callers/references modes; optional for impact.' },
        mode: { type: 'string', enum: ['symbol', 'callers', 'references', 'imports', 'dependents', 'overview', 'symbols', 'related', 'impact'], description: 'Query mode. Omit or use "symbol" for declaration lookup. "callers"/"references" for usage. "imports"/"dependents" for module graph. "overview"/"symbols"/"related"/"impact" for file-level analysis.' },
        file: { type: 'string', description: 'Target file path. Required for imports/dependents/related/impact/symbols. Optional for declaration mode (auto-derives graph cwd from the file\'s nearest project root) or callers/references (narrows language).' },
        language: { type: 'string', description: 'Optional language filter (e.g. javascript, typescript, python).' },
        limit: { type: 'number', description: 'Optional result cap. Default 20, max 50.' },
        cwd: { type: 'string', description: 'Override search cwd. If absent, uses caller cwd.' },
      },
      required: [],
    },
  },
  {
    name: 'find_imports',
    public: false,
    title: 'Find Imports',
    annotations: { title: 'Find Imports', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'What does this file import? Returns modules/files the target pulls in. Prefer over `code_graph(mode:"imports")` when file path is known.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the target file.' },
        cwd: { type: 'string', description: 'Override search cwd. If absent, uses caller cwd.' },
      },
      required: ['file'],
    },
  },
  {
    name: 'find_dependents',
    public: false,
    title: 'Find Dependents',
    annotations: { title: 'Find Dependents', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Who imports this file? Returns files that depend on the target. Prefer over `code_graph(mode:"dependents")` when file path is known.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the target file.' },
        cwd: { type: 'string', description: 'Override search cwd. If absent, uses caller cwd.' },
      },
      required: ['file'],
    },
  },
  {
    name: 'find_references',
    public: false,
    title: 'Find References',
    annotations: { title: 'Find References', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Find references for a symbol across the repository. Prefer over `code_graph(mode:"references")` when symbol is known. For non-function symbols (constants, type aliases, variables), use this — `find_callers` only matches call-sites.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to resolve references for.' },
        file: { type: 'string', description: 'Optional file path to narrow the language/source file.' },
        language: { type: 'string', description: 'Optional language filter (e.g. javascript, typescript, python).' },
        cwd: { type: 'string', description: 'Override search cwd. If absent, uses caller cwd.' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'find_callers',
    public: false,
    title: 'Find Callers',
    annotations: { title: 'Find Callers', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Find call sites for a symbol — caller file, line, and enclosing caller symbol. Only matches call-site invocations. For non-function symbols (constants, type aliases, variables), use `find_references` instead.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name to resolve callers for.' },
        file: { type: 'string', description: 'Optional file path to narrow the language/source file.' },
        language: { type: 'string', description: 'Optional language filter (e.g. javascript, typescript, python).' },
        cwd: { type: 'string', description: 'Override search cwd. If absent, uses caller cwd.' },
      },
      required: ['symbol'],
    },
  },
];

// MCP clients sometimes inject empty-string defaults for optional schema
// fields (e.g. `file: ""`). That empty path round-trips through
// normalizeInputPath as a literal string, populating `rel` and tripping
// the "file not found in graph" early-return in callers/references modes
// even when the caller intended bare-symbol search. Strip empty/null
// optional path-like fields before dispatch.
function _stripEmptyArgs(args) {
  const a = { ...(args || {}) };
  for (const k of ['file', 'language']) {
    if (a[k] === '' || a[k] === null) delete a[k];
  }
  return a;
}

function _deriveCwdFromFile(file, currentCwd) {
  if (!file || !currentCwd) return currentCwd;
  const abs = pathResolve(file);
  const rel = pathRelative(currentCwd, abs);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return currentCwd;
  let dir = dirname(abs);
  while (dir && dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return dirname(abs);
}

export async function executeCodeGraphTool(name, args, cwd) {
  if (!cwd) throw new Error('find_symbol/code_graph requires cwd — caller did not provide a working directory');
  // When the caller passes an absolute `file` outside cwd, anchor the graph
  // build at the file's project root (nearest package.json/.git ancestor).
  // Lets find_symbol({symbol, file}) work cross-cwd without forcing the
  // caller to also override cwd manually.
  const fileArg = (args && typeof args.file === 'string' && args.file.trim()) ? args.file.trim() : '';
  const baseCwd = (args && typeof args.cwd === 'string' && args.cwd.trim()) ? args.cwd.trim() : cwd;
  const effectiveCwd = fileArg ? _deriveCwdFromFile(fileArg, baseCwd) : baseCwd;
  switch (name) {
    case 'code_graph': return codeGraph(args, effectiveCwd);
    case 'find_symbol': {
      // The advertised `mode` switch lets find_symbol act as a router into
      // every code_graph query (callers/references/imports/dependents/
      // overview/symbols/related/impact). Default to declaration lookup
      // when omitted or set to symbol/find_symbol.
      const rawMode = String(args?.mode || '').trim();
      const declModes = new Set(['', 'symbol', 'find_symbol']);
      if (declModes.has(rawMode)) return findSymbolTool(_stripEmptyArgs(args), effectiveCwd);
      return codeGraph({ ..._stripEmptyArgs(args), mode: rawMode }, effectiveCwd);
    }
    case 'find_imports': return codeGraph({ ..._stripEmptyArgs(args), mode: 'imports' }, effectiveCwd);
    case 'find_dependents': return codeGraph({ ..._stripEmptyArgs(args), mode: 'dependents' }, effectiveCwd);
    case 'find_references': return codeGraph({ ..._stripEmptyArgs(args), mode: 'references' }, effectiveCwd);
    case 'find_callers': return codeGraph({ ..._stripEmptyArgs(args), mode: 'callers' }, effectiveCwd);
    default: throw new Error(`Unknown code-graph tool: ${name}`);
  }
}

export function isCodeGraphTool(name) {
  return CODE_GRAPH_TOOL_DEFS.some((t) => t.name === name);
}

export function buildExplainerFileIndex(cwd) {
  const graph = _buildCodeGraph(cwd);
  return {
    signature: graph.signature,
    items: [...graph.nodes.values()].map((node) => ({
      filePath: node.rel,
      language: node.lang,
      summary: _buildExplainerFileSummary(node, graph, cwd),
    })),
  };
}

export const _internals = {
  resetCodeGraphCachesForTesting,
  persistCodeGraphDiskCacheNow: _persistDiskCodeGraphCacheNow,
  getCodeGraphCacheStatsForTesting: () => ({ ..._codeGraphCacheStats }),
};
