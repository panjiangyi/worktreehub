# External Workspace API (v1)

These endpoints extend the [Terminal API](terminal-api.md). All require the same Bearer token. Configure WORKTREEHUB_API_TOKEN in the repository root .env and restart the backend. The token must be at least 32 characters. See the terminal API reference for authentication and error format.

```sh
export WTH_BASE="http://127.0.0.1:3767/api/v1"
# Set WTH_TOKEN to the secret configured on the server.
```

All paths below are relative to WTH_BASE.

| Method | Path | Success |
| --- | --- | --- |
| GET | /projects | 200 |
| GET | /projects/:projectId/worktrees | 200 |
| GET | /projects/:projectId/branches | 200 |
| POST | /projects/:projectId/worktrees | 201 |
| POST | /projects/:projectId/worktrees/:worktreeId/terminals | 201 |
| POST | /projects/:projectId/terminals | 201 |

## List projects

```sh
curl -sS -H "Authorization: Bearer $WTH_TOKEN" "$WTH_BASE/projects"
```

Returns {"projects":[Project,...]}, with each Project containing id, name, repoPath, worktreeBasePath, mainBranch, setupScript, devServerScript, createdAt and updatedAt. Only already registered projects are returned. Use the exact id in subsequent calls.

## List worktrees

```sh
curl -sS -H "Authorization: Bearer $WTH_TOKEN" "$WTH_BASE/projects/PROJECT_ID/worktrees"
```

Synchronizes Git worktrees and returns {"worktrees":[Worktree,...]}. Each Worktree includes id, projectId, name, displayName, path, branch, head, isMain, isDirty, isArchived, createdByApp, createdAt, updatedAt and optional mergeCheck. Reuse an existing matching worktree rather than trying to create a duplicate branch. Archived worktrees are listed but cannot be used to create new terminals through this API.

## List branches

```sh
curl -sS -H "Authorization: Bearer $WTH_TOKEN" "$WTH_BASE/projects/PROJECT_ID/branches"
```

Returns {"local":["main"],"remote":["origin/main"]} (illustrative values); the results come from the repository's currently known Git refs, not a network fetch.

## Create a worktree

```sh
curl -sS -X POST "$WTH_BASE/projects/PROJECT_ID/worktrees" \
  -H "Authorization: Bearer $WTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"branch":"feature/fix-cart","baseRef":"main","name":"Fix cart"}'
```

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| branch | string | Yes | New local Git branch, must not already exist |
| baseRef | string | No | Existing Git ref, defaults to the project's mainBranch |
| name | string | No | Display name, 1–200 characters after trimming |

Returns 201 and a Worktree object directly (not wrapped), including its new id, path, projectId and branch. The target directory is derived from the project's configured worktreeBasePath and branch. Custom paths are not accepted. The existing Git validation and path-safety checks apply. If a project has a setupScript, the service attempts to start a separate setup terminal automatically; 201 does not mean setup completed. A failed request can leave Git-side changes, so inspect the worktree list before retrying. Existing local branches without a worktree cannot be attached through this creation route; it creates new branches only.

## Create a terminal in a worktree

```sh
curl -sS -X POST "$WTH_BASE/projects/PROJECT_ID/worktrees/WORKTREE_ID/terminals" \
  -H "Authorization: Bearer $WTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Claude Code - Fix cart","initialCommand":"claude","cols":120,"rows":30}'
```

All fields optional; an empty object or omitted body creates a default shell.

| Field | Type | Meaning |
| --- | --- | --- |
| title | string | Custom title (1–200 characters after trimming) |
| initialCommand | string | Optional command written to the new terminal, max 65,536 UTF-16 code units |
| cols | integer | Initial width, 20–500 |
| rows | integer | Initial height, 5–200 |

Returns 201 and a TerminalSession object directly, including id, projectId, worktreeId, title, cwd, status, pid and other fields described in the terminal API reference. Uses the server's default shell and the specified worktree directory. The server checks that the worktree belongs to the project. Connected web clients receive terminal-created broadcasts. Refresh project/worktree lists if a newly created worktree is not yet visible in the browser.

A successful terminal creation does not mean the initial command has finished or the Agent is ready. Read the screen buffer before sending additional input. To use an existing terminal, list running terminals instead of creating another.

## Start a task directly on the project's default branch

```sh
curl -sS -X POST "$WTH_BASE/projects/PROJECT_ID/terminals" \
  -H "Authorization: Bearer $WTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Fix cart","initialCommand":"claude \"Fix the cart bug\""}'
```

No branch or worktree ID is needed. Body fields are the same as in the previous section (title, initialCommand, cols, rows; all optional). initialCommand is an ordinary shell command, not a separate AI prompt field. Omit it for a plain terminal. The installed coding agent must support the command you supply.

The server resolves the project's configured mainBranch, not necessarily a branch named main. It reuses the existing checkout of that branch (preferring the primary checkout). If the local default branch exists but is not checked out, the server attaches it in a new worktree under the configured base path without creating a new branch. It does not switch an existing checkout, pull, reset, force checkout, or commit. This automatic attachment does not run the project's setup script; initialize dependencies explicitly if needed.

Returns 201 with the TerminalSession fields plus branch. The returned worktreeId identifies the resolved checkout. Missing default local branches return 409 DEFAULT_BRANCH_NOT_FOUND; unavailable checkouts return 409 DEFAULT_WORKTREE_UNAVAILABLE; archived checkouts return 409 WORKTREE_ARCHIVED. Other Git failures may use existing error codes. A missing project returns 404.

Multiple launches can share the same default-branch checkout and its uncommitted changes. This is not task isolation; avoid concurrent changes to the same files. The existing terminal input and screen APIs apply, and 201 means the terminal was created, not that the task completed. The operation is not idempotent.

## Errors and retries

All routes use the external API's authentication. Missing projects and wrong/missing worktrees return 404 (PROJECT_NOT_FOUND or WORKTREE_NOT_FOUND); archived worktrees return 409 WORKTREE_ARCHIVED. Invalid fields return 400 VALIDATION_ERROR. Existing service errors such as BRANCH_EXISTS, BASE_REF_NOT_FOUND, UNSAFE_PATH, WORKTREE_PATH_EXISTS, and WORKTREE_PATH_NOT_FOUND are returned with their existing status codes (generally 400). Unknown Git/process errors may return 500 INTERNAL_ERROR. Invalid or missing token returns 401; disabled API returns 503. Unknown request fields and query parameters are rejected.

Creation is not idempotent. If a request times out, query the project/worktrees or running terminals to reconcile before retrying.

## Agent workflow

For work directly on the default branch, use POST /projects/:projectId/terminals with an optional initialCommand and proceed directly to terminal monitoring. For isolated feature branches:

1. GET /projects to locate the registered project.
2. GET /projects/:projectId/worktrees and reuse a matching worktree if it exists.
3. If needed, POST /projects/:projectId/worktrees with a new branch and base ref.
4. Use the returned worktree id to POST /projects/:projectId/worktrees/:worktreeId/terminals. Optionally start Claude Code or Codex using initialCommand, provided it is installed on the host.
5. Use the returned terminal id with /terminals/:id/buffer, /input, /stream and PATCH /terminals/:id.
6. Monitor setup and Agent readiness before sending commands. Use a trusted client; the bearer token grants shell access.
7. When finished, DELETE /terminals/:id to close the terminal (204). This stops its PTY and removes the session without deleting the worktree or branch.
