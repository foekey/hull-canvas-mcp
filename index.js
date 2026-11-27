#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { canvas, download, login, panopto } from "./session.js";

// ---- output helpers: every byte here is tokens, so keep it terse -------------------------------
const reply = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, (k, x) => (x == null || x === "" || x === false || (Array.isArray(x) && !x.length) ? undefined : x)) }] });
const lines = (a) => (a.length ? a.join("\n") : "(none)");
const day = (iso) => (iso ? iso.slice(0, 16).replace("T", " ") : "-");
const short = (n) => n.replace(/\s*\([^)]*\)\s*$/, "");
const strip = (h) =>
  (h || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
// Long text comes back in slices so a big brief costs tokens only when asked for.
const slice = (text, offset = 0, max = 6000) => {
  const s = text.slice(offset, offset + max), left = text.length - offset - s.length;
  return left > 0 ? `${s}\n…[${left} more chars: call again with offset=${offset + max}]` : s;
};
const LIM = { offset: z.number().default(0), max_chars: z.number().default(6000) };

const server = new McpServer({ name: "hull", version: "2.0.0" });
// Annotations let IDEs auto-approve the read-only tools and still prompt for the two that open a window or write files.
const READ = { readOnlyHint: true, openWorldHint: true }, WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const tool = (name, description, inputSchema, fn, annotations = READ) =>
  server.registerTool(name, { description, inputSchema, annotations }, async (a) => {
    try { return reply(await fn(a)); }
    catch (e) { return { isError: true, content: [{ type: "text", text: String(e.message || e) }] }; }
  });

const MIN = 60_000, STATIC = 10 * MIN;
const courses = () => canvas("/courses?enrollment_state=active&per_page=100&include[]=term", { ttl: STATIC });
const courseName = async (id) => (await canvas(`/courses/${id}`, { ttl: STATIC })).name;
const done = (s) => ["submitted", "graded", "pending_review"].includes(s);

// ---- sign-in / overview ------------------------------------------------------------------------
tool("login", "Open a Brave window to sign in to Hull Canvas + Panopto. Only needed the first time or if a tool says the session expired.", {}, login, WRITES);

tool("list_courses", "Active Canvas courses: id | name | term. Current terms only unless all=true.", { all: z.boolean().default(false) }, async ({ all }) =>
  lines((await courses()).filter((c) => all || !c.term?.end_at || new Date(c.term.end_at) > new Date()).map((c) => `${c.id} | ${c.name} | ${c.term?.name}`)));

tool(
  "whats_due",
  "START HERE for 'what do I need to do': every unsubmitted assignment/quiz/discussion across all courses, soonest first (overdue from the last 14 days included). One cheap call. Lines: due | course | title | points | flags | course_id/assignment_id.",
  { days_ahead: z.number().default(21) },
  async ({ days_ahead }) => {
    const iso = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 10);
    const items = await canvas(`/planner/items?start_date=${iso(-14 * 864e5)}&end_date=${iso(days_ahead * 864e5)}&per_page=100`);
    return lines(
      items
        .filter((i) => ["assignment", "quiz", "discussion_topic"].includes(i.plannable_type) && !i.submissions?.submitted && !i.submissions?.graded && !i.planner_override?.marked_complete)
        .map((i) => {
          const p = i.plannable, flags = [i.plannable_type !== "assignment" && i.plannable_type, i.submissions?.missing && "MISSING", i.submissions?.late && "late"].filter(Boolean).join(",");
          return `${day(p.due_at || i.plannable_date)} | ${short(i.context_name)} | ${p.title} | ${p.points_possible ?? "-"}pts | ${flags || "-"} | ${i.course_id}/${p.assignment_id ?? i.plannable_id}`;
        })
        .sort(),
    );
  },
);

// ---- assignments -------------------------------------------------------------------------------
tool(
  "get_assignments",
  "Assignments in one course as compact lines: id | due | points | status | name. Use get_assignment for the full brief.",
  { course_id: z.number(), only_todo: z.boolean().default(true).describe("Hide submitted/graded work") },
  async ({ course_id, only_todo }) =>
    lines(
      (await canvas(`/courses/${course_id}/assignments?per_page=100&order_by=due_at&include[]=submission`))
        .filter((a) => !only_todo || !done(a.submission?.workflow_state))
        .map((a) => `${a.id} | ${day(a.due_at)} | ${a.points_possible ?? "-"} | ${a.submission?.workflow_state || "-"}${a.submission?.missing ? " MISSING" : ""} | ${a.name}`),
    ),
);

const fileMeta = async (course, id) => {
  const f = await canvas(`/courses/${course}/files/${id}`, { ttl: STATIC }).catch(() => null);
  return f && { id: f.id, name: f.display_name, type: f["content-type"], kb: Math.round(f.size / 1024) };
};

tool(
  "get_assignment",
  "Everything needed to DO an assignment: instructions, files linked in the brief (read them with read_file), external links, rubric with level descriptors, submission state and any feedback.",
  { course_id: z.number(), assignment_id: z.number(), rubric: z.enum(["brief", "full"]).default("brief").describe("full = every grade band's descriptor (long)"), ...LIM },
  async ({ course_id, assignment_id, rubric, offset, max_chars }) => {
    const [a, s, course] = await Promise.all([
      canvas(`/courses/${course_id}/assignments/${assignment_id}`),
      canvas(`/courses/${course_id}/assignments/${assignment_id}/submissions/self?include[]=submission_comments&include[]=rubric_assessment`).catch(() => ({})),
      courseName(course_id),
    ]);
    const html = a.description || "";
    const ids = [...new Set([...html.matchAll(/\/courses\/\d+\/files\/(\d+)/g)].map((m) => m[1]))];
    const links = [...new Map([...html.matchAll(/<a [^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
      .filter((m) => !/canvas\.hull\.ac\.uk\/(api\/v1\/)?courses\/\d+\/files/.test(m[1]))
      .map((m) => [m[1], { t: strip(m[2]).slice(0, 80), url: m[1] }])).values()].slice(0, 12);
    const ra = s.rubric_assessment || {};
    return {
      name: a.name, course: short(course), due: day(a.due_at), closes: day(a.lock_at), opens: a.unlock_at && day(a.unlock_at),
      points: a.points_possible, submit_as: a.submission_types?.join(","), allowed_ext: a.allowed_extensions, attempts: a.allowed_attempts > 0 ? a.allowed_attempts : undefined,
      group_assignment: a.group_category_id ? true : undefined, peer_reviews: a.peer_reviews,
      status: s.workflow_state, attempt: s.attempt, submitted_at: s.submitted_at && day(s.submitted_at), late: s.late, missing: s.missing,
      submitted_files: s.attachments?.map((f) => f.display_name), score: s.score, grade: s.grade,
      feedback: s.submission_comments?.map((c) => `${c.author_name}: ${strip(c.comment)}`),
      rubric: a.rubric?.map((r) => ({
        criterion: r.description, max: r.points, detail: r.long_description && strip(r.long_description).slice(0, 300),
        // brief: band names + what the top band demands; full: every band's descriptor
        bands: r.ratings?.map((x) => `${x.points} ${x.description}${rubric === "full" && x.long_description ? ": " + strip(x.long_description).slice(0, 250) : ""}`).join(rubric === "full" ? "\n" : " | "),
        top_band: rubric === "brief" ? strip(r.ratings?.[0]?.long_description || "").slice(0, 250) : undefined,
        got: ra[r.id]?.points, note: ra[r.id]?.comments,
      })),
      files: (await Promise.all(ids.map((id) => fileMeta(course_id, id)))).filter(Boolean),
      links,
      instructions: slice(strip(html), offset, max_chars),
    };
  },
);

tool(
  "get_grades",
  "Marks and feedback for a course (graded work, teacher comments, rubric scores) plus how the grade is weighted. Use it to learn what markers reward before writing.",
  { course_id: z.number() },
  async ({ course_id }) => {
    const [subs, groups] = await Promise.all([
      canvas(`/courses/${course_id}/students/submissions?student_ids[]=self&include[]=submission_comments&include[]=assignment&per_page=100`),
      canvas(`/courses/${course_id}/assignment_groups?per_page=50`, { ttl: STATIC }),
    ]);
    const marked = subs.filter((s) => s.score != null || s.submission_comments?.length || s.grade);
    return lines([
      "Weights: " + groups.filter((g) => g.group_weight).map((g) => `${g.name}=${g.group_weight}%`).join("; "),
      ...marked.map((s) => `${s.assignment?.name} | ${s.score ?? "-"}/${s.assignment?.points_possible ?? "-"} | ${s.grade ?? "-"}${s.late ? " late" : ""}${s.submission_comments?.length ? " | feedback: " + s.submission_comments.map((c) => strip(c.comment)).join(" / ") : ""}`),
    ]);
  },
);

tool(
  "get_announcements",
  "Recent announcements and discussion posts for a course (lecturers often clarify assignments here).",
  { course_id: z.number(), limit: z.number().default(5) },
  async ({ course_id, limit }) => {
    const [ann, disc] = await Promise.all([
      canvas(`/announcements?context_codes[]=course_${course_id}&per_page=${limit}`, { all: false }),
      canvas(`/courses/${course_id}/discussion_topics?per_page=${limit}`, { all: false }),
    ]);
    return lines([...ann.map((x) => ({ ...x, k: "ann" })), ...disc.filter((d) => !d.assignment_id).map((x) => ({ ...x, k: "disc" }))]
      .sort((a, b) => (b.posted_at || "").localeCompare(a.posted_at || "")).slice(0, limit)
      .map((x) => `${x.k} | ${day(x.posted_at)} | ${x.title} | ${slice(strip(x.message), 0, 600)}`));
  },
);

// ---- course content ----------------------------------------------------------------------------
tool(
  "course_materials",
  "Module outline for a course: lecture slides, readings, pages, linked assignments, with ids for read_file / read_page. Filter with `query` to keep it short.",
  { course_id: z.number(), query: z.string().optional().describe("Case-insensitive filter on module or item title") },
  async ({ course_id, query }) => {
    const q = query?.toLowerCase();
    const out = [];
    for (const m of await canvas(`/courses/${course_id}/modules?include[]=items&per_page=50`, { ttl: STATIC })) {
      const items = (m.items || []).filter((i) => i.type !== "SubHeader" && (!q || m.name.toLowerCase().includes(q) || i.title.toLowerCase().includes(q)));
      if (!items.length) continue;
      out.push(`# ${m.name.trim()}`);
      for (const i of items)
        out.push(i.type === "File" ? `file ${i.content_id} | ${i.title}` : i.type === "Page" ? `page ${i.page_url} | ${i.title}` : i.type === "ExternalUrl" ? `link | ${i.title} | ${i.external_url}` : `${i.type.toLowerCase()} ${i.content_id} | ${i.title}`);
    }
    return lines(out);
  },
);

const texts = new Map(); // file id -> extracted text
tool(
  "read_file",
  "Read a Canvas file's text (PDF, Word, code or plain text): assignment briefs, lecture slides, starter code. File ids come from get_assignment or course_materials. Long files come back in slices.",
  { course_id: z.number(), file_id: z.number(), ...LIM },
  async ({ course_id, file_id, offset, max_chars }) => {
    const f = await canvas(`/courses/${course_id}/files/${file_id}`, { ttl: STATIC });
    if (!texts.has(file_id)) {
      const type = f["content-type"] || "", name = f.display_name.toLowerCase();
      const buf = await download(f.url);
      let t;
      if (type === "application/pdf" || name.endsWith(".pdf")) t = (await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true })).text;
      else if (name.endsWith(".docx")) t = (await mammoth.extractRawText({ buffer: buf })).value;
      else if (type.startsWith("text/") || /\.(cs|py|js|ts|java|c|cpp|h|json|md|csv|txt|xml|html|sql)$/.test(name)) t = buf.toString("utf8");
      else return `Can't extract text from ${f.display_name} (${type}).`;
      texts.set(file_id, t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
    }
    const t = texts.get(file_id);
    return `# ${f.display_name} (${t.length} chars)\n${slice(t, offset, max_chars)}`;
  },
);

const run = promisify(execFile);
// Windows and macOS ship a bsdtar that reads zips; Linux needs unzip. No archive dependency needed.
const ZIP = process.platform === "linux"
  ? { bin: "unzip", list: (p) => ["-Z1", p], extract: (p, d, keep) => [keep ? "-n" : "-o", p, "-d", d] }
  : { bin: process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar", list: (p) => ["-tf", p], extract: (p, d, keep) => [keep ? "-xkf" : "-xf", p, "-C", d] };
tool(
  "download_file",
  "Save a Canvas file to disk (zips, starter code, test files, datasets, PDFs). Find file ids with course_materials or get_assignment. extract=true also unpacks a zip into dest_dir. Never overwrites existing files unless overwrite=true.",
  {
    course_id: z.number(), file_id: z.number(),
    dest_dir: z.string().default(join(homedir(), "Downloads", "Hull")).describe("Folder to save into (created if missing)"),
    extract: z.boolean().default(false), overwrite: z.boolean().default(false),
  },
  async ({ course_id, file_id, dest_dir, extract, overwrite }) => {
    const f = await canvas(`/courses/${course_id}/files/${file_id}`, { ttl: STATIC });
    const path = join(dest_dir, f.display_name.replace(/[\\/:*?"<>|]/g, "_"));
    if (existsSync(path) && !overwrite) throw new Error(`${path} already exists. Pass overwrite=true to replace it.`);
    mkdirSync(dest_dir, { recursive: true });
    writeFileSync(path, await download(f.url));
    let out = `Saved ${path} (${Math.round(f.size / 1024)} KB)`;
    if (extract) {
      const names = (await run(ZIP.bin, ZIP.list(path))).stdout.trim().split(/\r?\n/);
      await run(ZIP.bin, ZIP.extract(path, dest_dir, !overwrite)); // keep = don't touch files that already exist
      out += `\nExtracted ${names.length} entries into ${dest_dir}${overwrite ? "" : " (existing files kept)"}:\n${names.slice(0, 30).join("\n")}${names.length > 30 ? `\n…+${names.length - 30} more` : ""}`;
    }
    return out;
  },
  WRITES,
);

tool("read_page", "Read a Canvas course page by its page id (from course_materials). Lists any files it links to (zips, starter code) with ids for download_file / read_file.", { course_id: z.number(), page: z.string(), ...LIM }, async ({ course_id, page, offset, max_chars }) => {
  const html = (await canvas(`/courses/${course_id}/pages/${page}`, { ttl: STATIC })).body || "";
  const files = [...new Map([...html.matchAll(/<a [^>]*href="[^"]*\/files\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => [m[1], `${m[1]} ${strip(m[2])}`])).values()];
  return slice(strip(html), offset, max_chars) + (files.length ? `\nFiles:\n${files.join("\n")}` : "");
});

// ---- Panopto -----------------------------------------------------------------------------------
const q = (o) => ({ queryParameters: { query: null, sortColumn: 1, sortAscending: false, maxResults: 100, page: 0, folderID: null, bookmarked: false, getFolderData: true, isSharedWithMe: false, isSubscriptionsPage: false, includeArchived: false, includePlaylists: false, ...o } });
const sessions = (o) => panopto("/Panopto/Services/Data.svc/GetSessions", q(o)).then((r) => r.d);
const msDate = (s) => new Date(+/\d+/.exec(s)[0]).toISOString().slice(0, 10);

// Panopto folders are named "<term> - <canvas course name>"; match on the name or its (module code).
// The folder list is slow to build (~6s) but stable, so it is kept on disk and rebuilt only on a miss.
const FOLDERS = join(tmpdir(), "hull-mcp-folders.json");
let folders, refreshedAt = 0;
async function loadFolders(refresh) {
  if (!refresh && !folders) { try { folders = new Map(JSON.parse(readFileSync(FOLDERS, "utf8"))); } catch { /* none yet */ } }
  if (!refresh && folders) return folders;
  const first = await sessions({ includeArchived: true });
  const rest = await Promise.all(Array.from({ length: Math.min(Math.ceil(first.TotalNumber / 100) - 1, 30) }, (_, i) => sessions({ includeArchived: true, page: i + 1 })));
  folders = new Map([first, ...rest].flatMap((d) => d.Results.map((s) => [s.FolderID, s.FolderName])));
  writeFileSync(FOLDERS, JSON.stringify([...folders]));
  refreshedAt = Date.now();
  return folders;
}
async function folderFor(course_id) {
  const name = await courseName(course_id), code = /\(([^)]+)\)\s*$/.exec(name)?.[1];
  const find = (m) => [...m].find(([, n]) => n.endsWith(name) || (code && n.includes(`(${code})`)));
  // a miss may mean the cached list is stale, so rebuild it, but at most every 10 minutes
  const hit = find(await loadFolders(false)) || (Date.now() - refreshedAt > 10 * MIN && find(await loadFolders(true)));
  if (!hit) throw new Error(`No Panopto recordings folder for "${name}" (courses with no recorded lectures have none).`);
  return hit[0];
}

tool(
  "list_recordings",
  "Lecture recordings for a course, newest first: date | recording_id | title | minutes | topic headings.",
  { course_id: z.number(), limit: z.number().default(10) },
  async ({ course_id, limit }) =>
    lines((await sessions({ folderID: await folderFor(course_id), maxResults: limit })).Results.map((s) => `${msDate(s.StartTime)} | ${s.DeliveryID} | ${s.SessionName} | ${Math.round(s.Duration / 60)}m | ${(s.KeyPoints || []).join("; ")}`)),
);

const summaries = new Map();
async function summary(id, detail) {
  if (!summaries.has(id)) {
    const d = (await panopto("/Panopto/Pages/Viewer/DeliveryInfo.aspx", {
      deliveryId: id, invocationId: "", isLiveNotes: "false", refreshAuthCookie: "true", isActiveBroadcast: "false", isEditing: "false", isKollectiveAgentInstalled: "false", isEmbed: "false", responseType: "json",
    }, "form")).Delivery;
    if (!d) throw new Error("Recording not found or no access.");
    summaries.set(id, d);
  }
  const d = summaries.get(id), kp = [].concat(d.AIKeyPoints || []).map((k) => k.Title || k.title || k);
  return `# ${d.SessionName}\nKey points: ${kp.join("; ") || "-"}\n${d.AISummary || "(no AI summary generated)"}${detail === "full" && d.AIChapters ? "\nChapters: " + JSON.stringify(d.AIChapters) : ""}`;
}
const DETAIL = z.enum(["brief", "full"]).default("brief").describe("full adds chapter list");

tool("get_summary", "Panopto AI summary + key points for one recording.", { recording_id: z.string(), detail: DETAIL }, ({ recording_id, detail }) => summary(recording_id, detail));

tool(
  "get_course_summaries",
  "AI summaries of a course's latest N lectures in one call (catch up on missed lectures).",
  { course_id: z.number(), count: z.number().default(3), detail: DETAIL },
  async ({ course_id, count, detail }) =>
    (await Promise.all((await sessions({ folderID: await folderFor(course_id), maxResults: count })).Results.map(async (s) => `${msDate(s.StartTime)} ${await summary(s.DeliveryID, detail)}`))).join("\n\n"),
);

await server.connect(new StdioServerTransport());
