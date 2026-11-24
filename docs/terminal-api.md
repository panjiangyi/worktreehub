# External terminal API

Enable it in the root .env with WORKTREEHUB_API_TOKEN set to a cryptographically random secret (at least 32 characters; e.g. generate with openssl rand -hex 32). Restart the server. The API is disabled by default. All requests require Authorization: Bearer TOKEN. Use HTTPS or a private network; this grants access to live shells and their potentially sensitive output. Never expose the token to untrusted clients.

Base: http://127.0.0.1:3767/api/v1

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /terminals | List running PTYs, including minimized panes and directory sessions. Optional projectId and worktreeId filters. |
| PATCH | /terminals/:id | Rename a running terminal (including minimized panes). |
| GET | /terminals/:id/buffer | Read a retained buffer snapshot. |
| POST | /terminals/:id/input | Write text or special keys to a live PTY. |
| GET | /terminals/:id/stream | Subscribe to live raw PTY data using SSE. |

List returns a terminals array with session IDs, project and worktree IDs, projectName, branch, title, cwd, scope and status. Directory terminals have null project/worktree IDs. Minimized is a browser-local presentation state; the API lists all running PTYs regardless of visibility.

## Rename

Send PATCH /terminals/:id with a JSON body containing title. Titles are trimmed and must be 1–200 characters with no embedded control characters. Returns HTTP 200 with the updated terminal session. The title is persisted in SQLite and broadcast to connected web clients; the PTY, working directory and buffer are unchanged. Missing or stopped terminals return 404.

```sh
curl -X PATCH -H "Authorization: Bearer $WTH_TOKEN" -H 'Content-Type: application/json' -d '{"title":"Claude Code - Fix cart"}' http://127.0.0.1:3767/api/v1/terminals/TERM_ID
```

## Buffer

- format=text (default): active terminal buffer, rendered physical screen rows plus scrollback (up to 10,000 retained scrollback rows).
- format=screen: current screen rows only, including alternate screen when active.
- format=raw: bounded 16 MiB replay buffer with terminal escape sequences; line boundaries are LF, not visual rows. Query traffic is stripped by the existing replay implementation.
- tail=N, or start=N&end=M (1-based inclusive indices relative to the current retained snapshot), or omit both for all retained lines. Positive integers only, maximum 1,000,000. Indices can shift as history is evicted; these are not absolute offsets. Blank screen rows are included. Output includes terminalId, format, totalLines, start, end, content; empty ranges have null start/end.

Examples (set WTH_TOKEN in your environment):

```sh
curl -H "Authorization: Bearer $WTH_TOKEN" http://127.0.0.1:3767/api/v1/terminals
curl -H "Authorization: Bearer $WTH_TOKEN" 'http://127.0.0.1:3767/api/v1/terminals/TERM_ID/buffer?format=screen'
curl -H "Authorization: Bearer $WTH_TOKEN" 'http://127.0.0.1:3767/api/v1/terminals/TERM_ID/buffer?format=text&tail=100'
curl -H "Authorization: Bearer $WTH_TOKEN" -H 'Content-Type: application/json' -d '{"text":"hello","submit":true}' http://127.0.0.1:3767/api/v1/terminals/TERM_ID/input
curl -N -H "Authorization: Bearer $WTH_TOKEN" http://127.0.0.1:3767/api/v1/terminals/TERM_ID/stream
```

Input also accepts {"key":"CTRL_C"}; supported keys: ENTER, CTRL_C, ESC, TAB, UP, DOWN, LEFT, RIGHT. Text limit 65,536 characters. submit defaults to false; true appends carriage return. Success is 204 (input written, not a guarantee that a command completed). Input is literal PTY data, so use only trusted automation.

SSE emits ready, output (JSON data string) and exit (exitCode) events; heartbeat comments every 15 seconds. No history is replayed by SSE; use the buffer endpoint. Reconnect and read a new snapshot if disconnected. Slow consumers are disconnected to bound memory.

Errors: 400 invalid parameters, 401 missing or invalid token, 404 missing live PTY, 503 disabled or temporarily unavailable buffer. Terminal data is not persisted across server restart.

## Workspace UI

Desktop layout presets support single, equal split, large left plus one/two/three, two left plus large right, four grid, large top plus two, and six grid. Extra panes are minimized, not killed. Restore from the toolbar. Mobile uses a single focused pane with minimize/restore controls. Hidden IDs and visible layout overrides persist in the current browser; separate devices have independent UI preferences.

The previous WeChat integration has been removed; older database tables are left untouched for migration safety.
