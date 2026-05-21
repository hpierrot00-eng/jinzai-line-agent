const baseUrl = process.env.CRON_BASE_URL || process.env.PUBLIC_BASE_URL || 'https://jinzai-line-agent.onrender.com';
const adminKey = process.env.ADMIN_API_KEY;
const dryRun = ['1', 'true', 'yes', 'on'].includes(String(process.env.CRON_DRY_RUN ?? 'false').toLowerCase());
const task = process.argv[2] || process.env.CRON_TASK || 'ops';
const limit = Number(process.env.WORKFLOW_TICK_LIMIT || '20');
const sheetsBatchSize = Number(process.env.SHEETS_SYNC_BATCH_SIZE || '50');

if (!adminKey) {
  console.error('ADMIN_API_KEY is required for Render cron jobs.');
  process.exit(1);
}

async function adminRequest(path, body) {
  const startedAt = Date.now();
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${adminKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const message = typeof data?.error === 'string' ? data.error : text.slice(0, 500);
    throw new Error(`${path} failed with ${res.status}: ${message}`);
  }
  return { path, ms: Date.now() - startedAt, data };
}

function compact(result) {
  const data = result.data ?? {};
  if (result.path === '/sheets/sync') {
    return { path: result.path, ms: result.ms, dryRun: data.dryRun, rows: data.rows, totalRows: data.totalRows, offset: data.offset, jobsCreated: data.jobs?.jobs?.length ?? 0 };
  }
  if (result.path === '/sheets/sync-form-responses') {
    return {
      path: result.path,
      ms: result.ms,
      dryRun: data.dryRun,
      postResults: data.postParticipation?.results?.length ?? 0,
      bankResults: data.bankAccount?.results?.length ?? 0,
    };
  }
  if (result.path === '/workflow/rebuild-jobs') {
    return { path: result.path, ms: result.ms, dryRun: data.dryRun, applications: data.applications, jobs: data.jobs?.length ?? 0, missingLineUser: data.missingLineUser?.length ?? 0 };
  }
  if (result.path === '/workflow/tick') {
    return { path: result.path, ms: result.ms, dryRun: data.dryRun, processed: data.processed, ok: data.results?.filter((item) => item.ok).length ?? 0, failed: data.results?.filter((item) => !item.ok).length ?? 0 };
  }
  return { path: result.path, ms: result.ms };
}

async function syncSheetsInBatches() {
  const startedAt = Date.now();
  const results = [];
  let offset = 0;
  let totalRows = null;
  let rows = 0;
  let jobsCreated = 0;

  while (totalRows === null || offset < totalRows) {
    const result = await adminRequest('/sheets/sync', { dryRun, offset, limit: sheetsBatchSize });
    results.push(result);
    const data = result.data ?? {};
    const batchRows = Number(data.rows ?? 0);
    totalRows = Number(data.totalRows ?? offset + batchRows);
    rows += batchRows;
    jobsCreated += Number(data.jobs?.jobs?.length ?? 0);
    if (batchRows === 0) break;
    offset += batchRows;
  }

  return {
    path: '/sheets/sync',
    ms: Date.now() - startedAt,
    data: { ok: true, dryRun, rows, totalRows, offset: 0, batches: results.length, jobs: { jobs: Array.from({ length: jobsCreated }) } },
  };
}

const tasks = {
  'sheets-sync': () => syncSheetsInBatches(),
  'sync-form-responses': () => adminRequest('/sheets/sync-form-responses', { dryRun, notifySlack: true }),
  'rebuild-jobs': () => adminRequest('/workflow/rebuild-jobs', { dryRun }),
  'workflow-tick': () => adminRequest('/workflow/tick', { dryRun, limit }),
  async ops() {
    const results = [];
    results.push(await tasks['sheets-sync']());
    results.push(await tasks['sync-form-responses']());
    results.push(await tasks['rebuild-jobs']());
    results.push(await tasks['workflow-tick']());
    return results;
  },
};

if (!tasks[task]) {
  console.error(`Unknown cron task: ${task}`);
  console.error(`Available tasks: ${Object.keys(tasks).join(', ')}`);
  process.exit(1);
}

const output = await tasks[task]();
const results = Array.isArray(output) ? output : [output];
console.log(JSON.stringify({ ok: true, task, dryRun, results: results.map(compact) }, null, 2));
