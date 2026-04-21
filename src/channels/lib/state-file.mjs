import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
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
  const tmpPath = filePath + ".tmp";
  ensureDir(dirname(filePath));
  writeFileSync(tmpPath, JSON.stringify(value));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(tmpPath, filePath);
      return;
    } catch (e) {
      if (e.code !== "EPERM" || attempt === 2) {
        try {
          unlinkSync(filePath);
        } catch {
        }
        try {
          renameSync(tmpPath, filePath);
          return;
        } catch {
        }
        writeFileSync(filePath, readFileSync(tmpPath));
        try {
          unlinkSync(tmpPath);
        } catch {
        }
        return;
      }
      const start = Date.now();
      while (Date.now() - start < 50) {
      }
    }
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
