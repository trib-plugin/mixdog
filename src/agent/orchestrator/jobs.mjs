import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { getPluginData } from './config.mjs';
function getJobsDir() {
    const dir = join(getPluginData(), 'jobs');
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return dir;
}
function stateFilePath() {
    return join(getJobsDir(), 'state.json');
}
function jobFilePath(jobId) {
    return join(getJobsDir(), `${jobId}.json`);
}
function readState() {
    const p = stateFilePath();
    if (!existsSync(p))
        return [];
    try {
        return JSON.parse(readFileSync(p, 'utf-8'));
    }
    catch {
        return [];
    }
}
function writeState(state) {
    const p = stateFilePath();
    const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, p);
}

// Module-level mutex: serializes all state R/M/W in this process.
let _stateLock = Promise.resolve();

export function createJob(sessionId, prompt, context, { scopeKey, lane } = {}) {
    // Add random entropy to avoid same-millisecond collisions.
    let jobId;
    do {
        jobId = `job_${Date.now()}_${randomBytes(3).toString('hex')}`;
    } while (existsSync(jobFilePath(jobId)));
    const now = new Date().toISOString();
    const detail = {
        jobId,
        sessionId,
        status: 'running',
        scopeKey: scopeKey || null,
        lane: lane || null,
        request: { prompt, context },
        startedAt: now,
    };
    // Write detail file first (unique path — no contention).
    writeFileSync(jobFilePath(jobId), JSON.stringify(detail, null, 2));
    // Serialize state index mutation.
    _stateLock = _stateLock.then(() => {
        try {
            const state = readState();
            state.push({ jobId, sessionId, status: 'running', startedAt: now, lane: lane || null });
            writeState(state);
        } catch { /* best-effort */ }
    });
    return jobId;
}
export function completeJob(jobId, result, failed = false) {
    const now = new Date().toISOString();
    const status = failed ? 'failed' : 'completed';
    // Serialize state index mutation.
    _stateLock = _stateLock.then(() => {
        try {
            const state = readState();
            const entry = state.find(j => j.jobId === jobId);
            if (entry) {
                entry.status = status;
                entry.finishedAt = now;
                writeState(state);
            }
        } catch { /* best-effort */ }
    });
    // Update detail file
    const detailPath = jobFilePath(jobId);
    if (existsSync(detailPath)) {
        try {
            const detail = JSON.parse(readFileSync(detailPath, 'utf-8'));
            detail.status = status;
            detail.result = result;
            detail.finishedAt = now;
            writeFileSync(detailPath, JSON.stringify(detail, null, 2));
        }
        catch { /* ignore corrupt file */ }
    }
}
export function getJob(jobId) {
    const p = jobFilePath(jobId);
    if (!existsSync(p))
        return null;
    try {
        return JSON.parse(readFileSync(p, 'utf-8'));
    }
    catch {
        return null;
    }
}
export function listJobs() {
    return readState();
}
