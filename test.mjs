// Smoke test against your own account: spawns the server over stdio, calls the tools, prints time + size.
// Usage: node test.mjs [--login]   (set SERVER_CMD="npx" SERVER_ARGS="-y ." to test the packaged bin)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const c = new Client({ name: "smoke", version: "1" });
await c.connect(new StdioClientTransport({ command: process.env.SERVER_CMD || "node", args: (process.env.SERVER_ARGS || "index.js").split(" ") }));
let failed = 0;
const call = async (name, args = {}, show = 200, soft = false) => { // soft: an error is fine (e.g. course has no recordings)
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 10 * 60_000 });
  const t = r.content[0].text;
  if (r.isError && !soft) failed++;
  console.log(`\n== ${name} ${JSON.stringify(args)} ${r.isError ? "ERROR" : "ok"} ${Date.now() - t0}ms ~${Math.round(t.length / 4)} tokens\n${t.slice(0, show)}`);
  return r.isError ? "" : t;
};
const tools = (await c.listTools()).tools;
console.log("tools:", tools.map((t) => t.name).join(", "));
if (process.argv.includes("--login")) await call("login");

const courses = [...(await call("list_courses", {}, 600)).matchAll(/^(\d+) \| /gm)].map((m) => +m[1]);
await call("whats_due");
for (const course_id of courses) { // first course that has assignments
  const list = await call("get_assignments", { course_id, only_todo: false });
  const a = /^(\d+) \|/m.exec(list)?.[1];
  if (!a) continue;
  const brief = await call("get_assignment", { course_id, assignment_id: +a }, 400);
  const f = /"files":\[\{"id":(\d+)/.exec(brief)?.[1];
  if (f) await call("read_file", { course_id, file_id: +f, max_chars: 200 });
  await call("get_grades", { course_id });
  break;
}
for (const course_id of courses) { // first course with materials / recordings
  const mats = await call("course_materials", { course_id }, 300);
  if (!mats.startsWith("(none")) {
    const page = /^page (\S+) \|/m.exec(mats)?.[1];
    if (page) await call("read_page", { course_id, page, max_chars: 200 });
    await call("get_announcements", { course_id });
    break;
  }
}
for (const course_id of courses) { // first course that has Panopto recordings
  const id = /\| ([0-9a-f-]{36}) \|/.exec(await call("list_recordings", { course_id, limit: 2 }, 200, true))?.[1];
  if (id) { await call("get_summary", { recording_id: id }, 300); break; }
}
console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
