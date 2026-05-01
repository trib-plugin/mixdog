import { mkdirSync, openSync, fsyncSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
let _tmpSeq = 0;
function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}
function removeFileIfExists(filePath) {
  try {
    unlinkSync(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
}
function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}
function writeTextFile(filePath, value) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, value);
}
function writeJsonFile(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${++_tmpSeq}.tmp`;
  ensureDir(dirname(filePath));
  writeFileSync(tmpPath, JSON.stringify(value));
  try {
    const fd = openSync(tmpPath, "r+");
    try {
      fsyncSync(fd);
    } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'ENOTSUP') throw e;
      process.stderr.write(`[state-file] fsync unsupported on platform for ${filePath}: ${e.code}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'ENOTSUP') throw e;
    process.stderr.write(`[state-file] fsync open unsupported on platform for ${filePath}: ${e.code}\n`);
  }
  try {
    renameSync(tmpPath, filePath);
  } catch (e) {
    process.stderr.write(`[state-file] rename failed for ${filePath}: ${e?.code || e?.message}\n`);
    throw e;
  }
  try {
    const dfd = openSync(dirname(filePath), "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch (e) {
    if (e.code !== "EPERM" && e.code !== "ENOTSUP") throw e;
  }
}
class JsonStateFile {
  constructor(filePath, fallback) {
    this.filePath = filePath;
    this.fallback = fallback;
  }
  read() {
    return readJsonFile(this.filePath, this.fallback);
  }
  write(value) {
    writeJsonFile(this.filePath, value);
    return value;
  }
  ensure() {
    writeJsonFile(this.filePath, this.read());
  }
  update(mutator) {
    const draft = this.read();
    mutator(draft);
    return this.write(draft);
  }
}
export {
  JsonStateFile,
  ensureDir,
  readJsonFile,
  removeFileIfExists,
  writeJsonFile,
  writeTextFile
};
