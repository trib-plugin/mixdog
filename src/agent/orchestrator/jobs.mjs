import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
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
    writeFileSync(stateFilePath(), JSON.stringify(state, null, 2));
}
export function createJob(sessionId, prompt, context, { scopeKey, lane } = {}) {
    const jobId = `job_${Date.now()}`;
    const now = new Date().toISOString();
    const index = { jobId, sessionId, status: 'running', startedAt: now, lane: lane || null };
    const state = readState();
    state.push(index);
    writeState(state);
    const detail = {
        jobId,
        sessionId,
        status: 'running',
        scopeKey: scopeKey || null,
        lane: lane || null,
        request: { prompt, context },
        startedAt: now,
    };
    writeFileSync(jobFilePath(jobId), JSON.stringify(detail, null, 2));
    return jobId;
}
export function completeJob(jobId, result, failed = false) {
    const now = new Date().toISOString();
    const status = failed ? 'failed' : 'completed';
    // Update state index
    const state = readState();
    const entry = state.find(j => j.jobId === jobId);
    if (entry) {
        entry.status = status;
        entry.finishedAt = now;
        writeState(state);
    }
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
