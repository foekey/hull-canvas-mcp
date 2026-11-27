# hull-canvas-mcp

An [MCP](https://modelcontextprotocol.io) server for **University of Hull Canvas + Panopto**, built for getting assignments done: what's due, the full brief, rubric, linked files, feedback, lecture slides and Panopto's AI lecture summaries. Output is compact on purpose, so it costs few tokens.

> Unofficial, not affiliated with the University of Hull. It acts as **you**, using your own sign-in, and only reads what you can already see. Follow your university's rules on AI use and academic integrity.

## Tools

| Tool | What it does |
|---|---|
| `whats_due` | **Start here.** Every unsubmitted assignment/quiz/discussion across all courses, soonest first. One request, ~120 tokens. |
| `list_courses` | Active courses (id, name, term). |
| `get_assignments` | Compact list for one course. |
| `get_assignment` | The full brief: instructions, linked files and links, rubric, submission state, feedback. |
| `get_grades` | Marks, teacher feedback and grade weighting. |
| `get_announcements` | Announcements and discussion posts. |
| `course_materials` | Module outline: slides, readings, pages, with ids. |
| `read_file` | Text of a PDF, Word, code or text file (long files come in slices). |
| `read_page` | A course page, plus the files it links to. |
| `download_file` | Save a Canvas file to disk; `extract: true` unpacks zips. Never overwrites unless asked. |
| `list_recordings` | Panopto lecture recordings for a course. |
| `get_summary` / `get_course_summaries` | Panopto AI summary and key points for one lecture / the latest N. |
| `login` | Opens a browser window to sign in (first run, or if the session expires). |

Read-only tools are annotated `readOnlyHint`, so IDEs can auto-approve them; `login` and `download_file` still prompt.

## Install

Needs **Node 18+** and a Chromium browser (Brave, Chrome or Edge) for the one-off sign-in.

**1. Add it to your client** (pick yours below).
**2. Ask it to run `login`** and sign in with your Hull Microsoft account in the window that opens. That window uses its own profile, so it never touches your everyday browser. Your session is saved for up to 14 days; after that tools refresh it silently, or ask you to `login` again.

### Claude Code

```sh
claude mcp add hull -- npx -y https://codeload.github.com/foekey/hull-canvas-mcp/tar.gz/refs/heads/main
```

### Claude Desktop, Cursor, Windsurf, Cline, Gemini CLI, JetBrains AI Assistant

Add to the client's MCP JSON (`claude_desktop_config.json`, `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, the Cline MCP settings, `~/.gemini/settings.json`, or Settings > Tools > AI Assistant > Model Context Protocol):

```json
{
  "mcpServers": {
    "hull": { "command": "npx", "args": ["-y", "https://codeload.github.com/foekey/hull-canvas-mcp/tar.gz/refs/heads/main"] }
  }
}
```

On Windows, if a client can't launch `npx` directly, use `"command": "cmd", "args": ["/c", "npx", "-y", "https://codeload.github.com/foekey/hull-canvas-mcp/tar.gz/refs/heads/main"]`.

### Google Antigravity (IDE, CLI and 2.0)

They all share one file, `~/.gemini/config/mcp_config.json` (Windows: `C:\Users\<you>\.gemini\config\mcp_config.json`); a project can add its own at `.agents/mcp_config.json`. In the IDE: agent panel **...** > **MCP Servers** > **Manage MCP Servers** > **View raw config**.

```json
{
  "mcpServers": {
    "hull": {
      "command": "npx",
      "args": ["-y", "https://codeload.github.com/foekey/hull-canvas-mcp/tar.gz/refs/heads/main"],
      "timeoutSeconds": 600
    }
  }
}
```

On Windows use `"command": "npx.cmd"`. Keep `timeoutSeconds`: Antigravity's default of 180 s per tool call can cut off `login` while you are still signing in.

### VS Code (GitHub Copilot)

`.vscode/mcp.json`, or run **MCP: Add Server**:

```json
{
  "servers": {
    "hull": { "type": "stdio", "command": "npx", "args": ["-y", "https://codeload.github.com/foekey/hull-canvas-mcp/tar.gz/refs/heads/main"] }
  }
}
```

### Zed

`settings.json`:

```json
{
  "context_servers": {
    "hull": { "command": { "path": "npx", "args": ["-y", "https://codeload.github.com/foekey/hull-canvas-mcp/tar.gz/refs/heads/main"] } }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.hull]
command = "npx"
args = ["-y", "https://codeload.github.com/foekey/hull-canvas-mcp/tar.gz/refs/heads/main"]
```

### From a local clone

```sh
git clone https://github.com/foekey/hull-canvas-mcp && cd hull-canvas-mcp && npm install
```

then point any client at `node /full/path/to/hull-canvas-mcp/index.js`.

## Configuration (environment variables, all optional)

| Variable | Default | Purpose |
|---|---|---|
| `BROWSER_PATH` | auto-detected Brave, Chrome, Edge | Browser used for sign-in |
| `HULL_PROFILE` | `~/.hull-mcp-profile` | Where the sign-in profile lives; delete it (plus `.cookies.json`) to sign out |
| `CANVAS_URL` | `https://canvas.hull.ac.uk` | Canvas site |
| `PANOPTO_URL` | `https://uoh.cloud.panopto.eu` | Panopto site |

## How it works, and limits

- Canvas is read through its normal REST API; Panopto through the same JSON the web viewer uses (`GetSessions`, `DeliveryInfo`). No scraping of rendered pages.
- Calls are plain HTTP with your saved cookies. The browser only starts to sign in or refresh an expired session.
- Responses are cached briefly (a minute for assignments, ten for course structure), and long text is sliced with an `offset` to continue.
- Built and tested against Hull's Canvas and Panopto. Other institutions need the `CANVAS_URL` / `PANOPTO_URL` variables and may need changes to the SSO click in `session.js` (it picks the `hull.ac.uk` Microsoft account).
- Can't read PowerPoint files or images. Quizzes appear in `whats_due`, but individual quiz questions aren't exposed.
- On Linux, `download_file` with `extract` needs `unzip`.

## Privacy

Cookies are stored unencrypted in `~/.hull-mcp-profile.cookies.json` (your home folder, never in the repo). Treat that file like a password.

## Development

```sh
npm install
npm run login   # sign in once
npm run smoke   # calls every tool against your real account
```

MIT licensed.
