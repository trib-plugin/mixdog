// repo-whitelist.mjs — deleted.
// The gh-based WRITE/MAINTAIN/ADMIN repo whitelist was a multi-step runtime
// heuristic (gh auth → gh repo list → path substring match) used to infer
// project_id from path strings. That inference path is removed. Project
// membership is now determined solely by explicit .mixdog/project.id files
// (resolveProjectId) or by stored project_id values on DB member rows
// (inferChunkProjectId). This file is kept as an empty stub so existing
// imports do not crash before callers are updated; exports are intentionally
// absent — update callers to remove their imports.
