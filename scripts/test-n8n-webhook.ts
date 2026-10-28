/**
 * Calls the Urvara n8n farm-event webhook with hardcoded test cases and checks
 * each response against what the workflow promises.
 *
 *   npm run test:n8n                      # all cases, production webhook
 *   npm run test:n8n -- --only rain-heavy # one case (comma-separate for more)
 *   npm run test:n8n -- --test            # use the /webhook-test/ URL
 *   npm run test:n8n -- --url <url>       # any other URL
 *   npm run test:n8n -- --verbose         # print every response body
 *   npm run test:n8n -- --list            # list case ids and exit
 *   npm run test:n8n -- --strict          # also fail on fields the docs promise but the response omits
 *
 * Cases run one at a time because each valid event runs the AI step.
 * Weather and task dates are relative to today so the validator's past-date
 * check does not start failing the suite as the calendar moves on.
 * Every valid call writes a row to the farm_decisions Data Table; eventIds
 * are prefixed "test-" so those rows are easy to find and clear.
 */

const PROD_URL = "https://atharv2008.app.n8n.cloud/webhook/urvara-farm-event";
const TEST_URL = "https://atharv2008.app.n8n.cloud/webhook-test/urvara-farm-event";
const TIMEOUT_MS = 120_000;

type Status = "proposed" | "pending_approval" | "rejected" | "invalid_event" | "persistence_failed";

type TestCase = {
  id: string;
  description: string;
  body: unknown;
  expectHttp: number[];
  expectStatus: Status[];
  /** Extra checks; return a list of problems (empty = pass). */
  check?: (res: WebhookResponse, body: SentEvent) => string[];
};

/**
 * The parts of a request body the checks read. Every field is optional because
 * the invalid-event cases deliberately drop some.
 */
type SentEvent = {
  eventId?: string;
  farmId?: string;
  data?: { context?: { tasks?: { taskId?: string }[]; resources?: { resourceId?: string }[] } };
};

type ProposedAction = {
  type?: string;
  taskId?: string;
  resourceId?: string;
  newScheduledDate?: string;
  validationIssues?: unknown[];
};

type ValidationSummary = { validActions?: number; totalActions?: number };

type WebhookResponse = {
  status?: string;
  decisionRecord?: {
    runId?: string;
    eventId?: string;
    farmId?: string;
    trigger?: unknown;
    status?: string;
    summary?: string;
    riskLevel?: string;
    proposedActions?: unknown;
    validationResults?: unknown;
    requiresOwnerApproval?: boolean;
    createdAt?: string;
  };
  persistence?: { target?: string; saved?: boolean; table?: string; runId?: string; rowId?: unknown };
  approvalStatus?: string;
  approvalNote?: string;
  [key: string]: unknown;
};

type Record_ = NonNullable<WebhookResponse["decisionRecord"]> & { approvalStatus?: string; approvalNote?: string };

/**
 * The docs say success responses wrap the record in `decisionRecord`, but the
 * live workflow returns it flat at the top level. Accept both.
 */
function recordOf(res: WebhookResponse): Record_ | undefined {
  if (res.decisionRecord) return res.decisionRecord as Record_;
  if (res.runId || res.proposedActions) return res as unknown as Record_;
  return undefined;
}

const isRejected = (res: WebhookResponse) => recordOf(res)?.status === "rejected";

// ── helpers ──────────────────────────────────────────────────────────────────

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

const nowIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().replace("Z", "+05:30");

/** Copy of an object without the given keys, for the cases that drop required fields. */
function without<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const copy: Partial<T> = { ...obj };
  for (const k of keys) delete copy[k];
  return copy as Omit<T, K>;
}

function farmEvent(id: string, data: unknown, extra: Record<string, unknown> = {}) {
  return {
    eventId: `test-${id}-${Date.now()}`,
    eventType: "WEATHER_CHANGED",
    farmId: "farm-001",
    timestamp: nowIst(),
    source: "n8n-test-suite",
    data,
    ...extra,
  };
}

/** Pull every string value stored under a given key anywhere in a JSON value. */
function collect(value: unknown, key: string, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => collect(v, key, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === key && typeof v === "string") out.push(v);
      collect(v, key, out);
    }
  }
  return out;
}

/** The AI may only reference task and resource IDs we supplied. */
function onlyKnownIds(res: WebhookResponse, body: SentEvent): string[] {
  const ctx = body?.data?.context ?? {};
  const taskIds = new Set((ctx.tasks ?? []).map((t) => t.taskId));
  const resourceIds = new Set((ctx.resources ?? []).map((r) => r.resourceId));
  if (isRejected(res)) return []; // a rejected plan is already blocked; bad IDs are why
  const actions = recordOf(res)?.proposedActions;
  const problems: string[] = [];
  for (const id of collect(actions, "taskId")) if (!taskIds.has(id)) problems.push(`unknown taskId in plan: ${id}`);
  for (const id of collect(actions, "resourceId"))
    if (!resourceIds.has(id)) problems.push(`unknown resourceId in plan: ${id}`);
  return problems;
}

/** A plan that touches spraying must never come back as plain "proposed". */
function sprayingNeedsApproval(res: WebhookResponse): string[] {
  const rec = recordOf(res);
  const text = JSON.stringify(rec?.proposedActions ?? "").toLowerCase();
  if (rec?.status === "proposed" && text.includes("spray"))
    return ["plan touches spraying but was not held for owner approval"];
  return [];
}

/**
 * Two accepted actions putting the same resource on the same date is the
 * "same-day resource conflict" the validator promises to catch.
 */
function noSameDayConflicts(res: WebhookResponse): string[] {
  const rec = recordOf(res);
  if (!rec || isRejected(res) || !Array.isArray(rec.proposedActions)) return [];
  const seen = new Map<string, string | undefined>();
  const problems: string[] = [];
  for (const a of rec.proposedActions as ProposedAction[]) {
    const date = a?.newScheduledDate;
    if (!a?.resourceId || !date || a.type === "CANCEL_TASK") continue;
    const key = `${a.resourceId}@${date}`;
    const flagged = (a.validationIssues ?? []).length > 0;
    if (seen.has(key) && !flagged)
      problems.push(`${seen.get(key)} and ${a.taskId} both put ${a.resourceId} on ${date}; validator did not flag it`);
    else seen.set(key, a.taskId);
  }
  return problems;
}

// ── test cases ───────────────────────────────────────────────────────────────

const CASES: TestCase[] = [
  {
    id: "rain-heavy",
    description: "Heavy rain over irrigation + spraying (the documented example)",
    body: farmEvent("rain-heavy", {
      weather: { condition: "heavy_rain", rainfallMm: 40, from: day(1), to: day(2) },
      context: {
        tasks: [
          { taskId: "task-101", type: "irrigation", date: day(1), resourceId: "pump-1" },
          { taskId: "task-102", type: "spraying", date: day(1), resourceId: "sprayer-1" },
        ],
        resources: [
          { resourceId: "pump-1", type: "pump" },
          { resourceId: "sprayer-1", type: "sprayer" },
        ],
      },
    }),
    expectHttp: [200],
    expectStatus: ["pending_approval", "rejected"],
    check: (r, b) => [...onlyKnownIds(r, b), ...sprayingNeedsApproval(r)],
  },
  {
    id: "rain-light",
    description: "Light drizzle, one irrigation task — low risk",
    body: farmEvent("rain-light", {
      weather: { condition: "light_rain", rainfallMm: 4, from: day(2), to: day(2) },
      context: {
        tasks: [{ taskId: "task-201", type: "irrigation", date: day(2), resourceId: "pump-1" }],
        resources: [{ resourceId: "pump-1", type: "pump" }],
      },
    }),
    expectHttp: [200],
    expectStatus: ["proposed", "pending_approval"],
    check: onlyKnownIds,
  },
  {
    id: "heatwave",
    description: "Heatwave: irrigation should be kept or increased, not cancelled",
    body: farmEvent("heatwave", {
      weather: { condition: "heatwave", maxTempC: 43, from: day(1), to: day(3) },
      context: {
        tasks: [
          { taskId: "task-301", type: "irrigation", date: day(2), resourceId: "pump-2" },
          { taskId: "task-302", type: "harvesting", date: day(3), resourceId: "harvester-1" },
        ],
        resources: [
          { resourceId: "pump-2", type: "pump" },
          { resourceId: "harvester-1", type: "harvester" },
        ],
      },
    }),
    expectHttp: [200],
    expectStatus: ["proposed", "pending_approval"],
    check: onlyKnownIds,
  },
  {
    id: "storm-multi",
    description: "Severe storm across spraying, sowing and harvest — high risk",
    body: farmEvent("storm-multi", {
      weather: { condition: "thunderstorm", rainfallMm: 85, windKmh: 70, from: day(1), to: day(2) },
      context: {
        tasks: [
          { taskId: "task-401", type: "spraying", date: day(1), resourceId: "sprayer-1" },
          { taskId: "task-402", type: "sowing", date: day(2), resourceId: "seeder-1" },
          { taskId: "task-403", type: "harvesting", date: day(2), resourceId: "harvester-1" },
        ],
        resources: [
          { resourceId: "sprayer-1", type: "sprayer" },
          { resourceId: "seeder-1", type: "seeder" },
          { resourceId: "harvester-1", type: "harvester" },
        ],
      },
    }),
    expectHttp: [200],
    expectStatus: ["pending_approval", "rejected"],
    check: (r, b) => {
      const p = [...onlyKnownIds(r, b), ...sprayingNeedsApproval(r)];
      const risk = recordOf(r)?.riskLevel;
      if (!isRejected(r) && risk && !["high", "critical"].includes(risk))
        p.push(`expected high/critical risk for an 85 mm storm, got "${risk}"`);
      return p;
    },
  },
  {
    id: "resource-conflict",
    description: "Two tasks on the same pump the same day — validator should flag or hold",
    body: farmEvent("resource-conflict", {
      weather: { condition: "heavy_rain", rainfallMm: 30, from: day(1), to: day(1) },
      context: {
        tasks: [
          { taskId: "task-501", type: "irrigation", date: day(3), resourceId: "pump-1" },
          { taskId: "task-502", type: "irrigation", date: day(3), resourceId: "pump-1" },
        ],
        resources: [{ resourceId: "pump-1", type: "pump" }],
      },
    }),
    expectHttp: [200],
    expectStatus: ["pending_approval", "rejected", "proposed"],
    check: onlyKnownIds,
  },
  {
    id: "no-tasks",
    description: "Weather change with nothing scheduled — plan should be empty or trivial",
    body: farmEvent("no-tasks", {
      weather: { condition: "cloudy", rainfallMm: 0, from: day(1), to: day(1) },
      context: { tasks: [], resources: [] },
    }),
    expectHttp: [200],
    expectStatus: ["proposed", "pending_approval", "rejected"],
    check: (r) =>
      isRejected(r)
        ? []
        : collect(recordOf(r)?.proposedActions, "taskId").map((id) => `invented taskId ${id}`),
  },
  {
    id: "defaults",
    description: "No timestamp or source — workflow should fill the defaults and still run",
    body: without(
      farmEvent("defaults", {
        weather: { condition: "light_rain", rainfallMm: 6, from: day(1), to: day(1) },
        context: {
          tasks: [{ taskId: "task-701", type: "irrigation", date: day(1), resourceId: "pump-1" }],
          resources: [{ resourceId: "pump-1", type: "pump" }],
        },
      }),
      "timestamp",
      "source",
    ),
    expectHttp: [200],
    expectStatus: ["proposed", "pending_approval", "rejected"],
    check: onlyKnownIds,
  },
  {
    id: "invalid-no-event-id",
    description: "Missing eventId",
    body: without(farmEvent("x", { weather: { condition: "heavy_rain" } }), "eventId"),
    expectHttp: [400],
    expectStatus: ["invalid_event"],
  },
  {
    id: "invalid-no-farm-id",
    description: "Missing farmId",
    body: without(farmEvent("no-farm", { weather: { condition: "heavy_rain" } }), "farmId"),
    expectHttp: [400],
    expectStatus: ["invalid_event"],
  },
  {
    id: "invalid-event-type",
    description: "Unsupported eventType",
    body: farmEvent("bad-type", { weather: { condition: "heavy_rain" } }, { eventType: "ALIEN_INVASION" }),
    expectHttp: [400],
    expectStatus: ["invalid_event"],
  },
  {
    id: "invalid-empty-body",
    description: "Empty JSON object",
    body: {},
    expectHttp: [400],
    expectStatus: ["invalid_event"],
  },
];

// ── runner ───────────────────────────────────────────────────────────────────

type CheckResult = { problems: string[]; warnings: string[] };

function checkResponse(tc: TestCase, http: number, res: WebhookResponse): CheckResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!tc.expectHttp.includes(http)) problems.push(`HTTP ${http}, expected ${tc.expectHttp.join("/")}`);

  const rec = recordOf(res);
  const status = (res.status ?? rec?.status) as string | undefined;
  if (!status || !tc.expectStatus.includes(status as Status))
    problems.push(`status "${status}", expected one of ${tc.expectStatus.join(", ")}`);

  if (http !== 200) return { problems, warnings };
  if (!rec) return { problems: [...problems, "no decision record in response"], warnings };

  const sent = tc.body as SentEvent;

  // What the plan must have to be usable at all.
  for (const k of ["runId", "status", "summary"] as const) if (rec[k] == null) problems.push(`${k} missing`);
  if (!Array.isArray(rec.proposedActions)) problems.push("proposedActions is not an array");
  if (rec.validationResults == null) problems.push("validationResults missing");

  // Fields the docs promise but the live workflow does not return yet.
  if (!res.decisionRecord) warnings.push("record is flat, not wrapped in decisionRecord as documented");
  const missing = (["eventId", "farmId", "riskLevel", "requiresOwnerApproval", "createdAt"] as const).filter(
    (k) => rec[k] === undefined,
  );
  if (missing.length) warnings.push(`documented fields missing: ${missing.join(", ")}`);
  if (rec.eventId !== undefined && rec.eventId !== sent.eventId) problems.push(`eventId echoed as "${rec.eventId}"`);
  if (rec.farmId !== undefined && rec.farmId !== sent.farmId) problems.push(`farmId echoed as "${rec.farmId}"`);

  // Approval state must agree with the status.
  const needsApproval = rec.requiresOwnerApproval ?? (rec.approvalStatus ? rec.approvalStatus === "pending_approval" : undefined);
  if (rec.status === "pending_approval" && needsApproval !== true)
    problems.push("status is pending_approval but approval is not marked as required");
  if (rec.status === "proposed" && needsApproval === true) problems.push("status is proposed but approval is required");
  if (rec.status === "rejected" && /passed deterministic validation/i.test(rec.approvalNote ?? ""))
    warnings.push("rejected plan carries the note \"All actions passed deterministic validation\"");

  // A plan with invalid actions must not be accepted as-is.
  const vr = rec.validationResults as ValidationSummary | null;
  if (rec.status === "proposed" && vr && vr.validActions !== vr.totalActions)
    problems.push(`proposed with only ${vr.validActions}/${vr.totalActions} valid actions`);

  const p = res.persistence;
  if (!p) problems.push("missing persistence");
  else {
    if (p.saved !== true) problems.push("persistence.saved is not true");
    if (p.target !== "n8n_data_table") problems.push(`persistence.target is "${p.target}"`);
    if (p.runId && p.runId !== rec.runId) problems.push("persistence.runId differs from the record's runId");
  }

  problems.push(...noSameDayConflicts(res));
  if (tc.check) problems.push(...tc.check(res, tc.body as SentEvent));
  return { problems, warnings };
}

async function call(url: string, body: unknown): Promise<{ http: number; json: WebhookResponse; raw: string; ms: number }> {
  const started = Date.now();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await resp.text();
  let json: WebhookResponse = {};
  try {
    json = raw ? JSON.parse(raw) : {};
    if (Array.isArray(json)) json = json[0] ?? {}; // n8n sometimes wraps the item
  } catch {
    /* non-JSON body is reported below */
  }
  return { http: resp.status, json, raw, ms: Date.now() - started };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (flag("--list")) {
    for (const tc of CASES) console.log(`${tc.id.padEnd(22)} ${tc.description}`);
    return;
  }

  const url = value("--url") ?? (flag("--test") ? TEST_URL : PROD_URL);
  const only = value("--only")?.split(",");
  const verbose = flag("--verbose");
  const strict = flag("--strict");
  const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
  if (cases.length === 0) {
    console.error(`No cases match --only ${only}. Use --list.`);
    process.exit(2);
  }

  console.log(`Urvara n8n webhook — ${cases.length} case(s)\n${url}\n`);
  let failed = 0;
  const warned = new Set<string>();

  for (const tc of cases) {
    process.stdout.write(`• ${tc.id.padEnd(22)} `);
    try {
      const { http, json, raw, ms } = await call(url, tc.body);
      const problems = raw && Object.keys(json).length === 0 ? [`non-JSON response: ${raw.slice(0, 200)}`] : [];
      const result = checkResponse(tc, http, json);
      problems.push(...result.problems);
      if (strict) problems.push(...result.warnings);
      const rec = recordOf(json);
      const status = json.status ?? rec?.status ?? "?";
      const risk = rec?.riskLevel ? ` risk=${rec.riskLevel}` : "";
      const tag = problems.length ? "FAIL" : "PASS";
      console.log(`${tag}  HTTP ${http}  ${status}${risk}  (${(ms / 1000).toFixed(1)}s)`);
      if (rec?.summary) console.log(`    ${rec.summary}`);
      if (problems.length) {
        failed++;
        for (const p of problems) console.log(`    ✗ ${p}`);
      }
      if (!strict) for (const w of result.warnings) warned.add(w);
      if (verbose || problems.length) console.log(indent(pretty(json, raw)));
    } catch (err) {
      failed++;
      console.log(`FAIL  ${(err as Error).name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000}s` : (err as Error).message}`);
    }
  }

  if (warned.size) {
    console.log("\nContract warnings (the response differs from the workflow docs; --strict fails on these):");
    for (const w of warned) console.log(`  ! ${w}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed) process.exit(1);
}

const pretty = (json: unknown, raw: string) => (raw ? JSON.stringify(json, null, 2) : "(empty body)");
const indent = (s: string) => s.split("\n").map((l) => "      " + l).join("\n");

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
export {};
