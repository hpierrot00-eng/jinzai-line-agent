const baseUrl = process.env.CRON_BASE_URL || process.env.PUBLIC_BASE_URL || 'https://jinzai-line-agent.onrender.com';
const adminKey = process.env.ADMIN_API_KEY;
const dryRun = ['1', 'true', 'yes', 'on'].includes(String(process.env.CRON_DRY_RUN ?? 'false').toLowerCase());
const task = process.argv[2] || process.env.CRON_TASK || 'ops';
const limit = Number(process.env.WORKFLOW_TICK_LIMIT || '20');
const sheetsBatchSize = Number(process.env.SHEETS_SYNC_BATCH_SIZE || '50');
const sheetsMinOffset = Math.max(0, Number(process.env.SHEETS_SYNC_MIN_OFFSET || '0'));
const sheetsStartOffset = Math.max(sheetsMinOffset, Number(process.env.SHEETS_SYNC_START_OFFSET || String(sheetsMinOffset)));
const sheetsMaxBatches = Math.max(1, Number(process.env.SHEETS_SYNC_MAX_BATCHES || String(Number.MAX_SAFE_INTEGER)));

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
    return {
      path: result.path,
      ms: result.ms,
      dryRun: data.dryRun,
      rows: data.rows,
      totalRows: data.totalRows,
      offset: data.offset,
      nextOffset: data.nextOffset,
      minOffset: data.minOffset,
      limit: data.limit,
      batches: data.batches,
      done: data.done,
      jobsCreated: data.jobs?.jobs?.length ?? 0,
    };
  }
  if (result.path === '/sheets/sync-form-responses') {
    return {
      path: result.path,
      ms: result.ms,
      dryRun: data.dryRun,
      partialFailure: Boolean(data.partialFailure),
      postOk: data.postParticipation?.ok !== false,
      bankOk: data.bankAccount?.ok !== false,
      postError: data.postParticipation?.error,
      bankError: data.bankAccount?.error,
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
  let offset = sheetsStartOffset;
  let totalRows = null;
  let rows = 0;
  let jobsCreated = 0;
  let batches = 0;

  while ((totalRows === null || offset < totalRows) && batches < sheetsMaxBatches) {
    const result = await adminRequest('/sheets/sync', { dryRun, offset, limit: sheetsBatchSize });
    results.push(result);
    batches += 1;
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
    data: {
      ok: true,
      dryRun,
      rows,
      totalRows,
      offset: sheetsStartOffset,
      minOffset: sheetsMinOffset,
      nextOffset: totalRows !== null && offset >= totalRows ? sheetsMinOffset : offset,
      limit: sheetsBatchSize,
      batches: results.length,
      done: totalRows !== null && offset >= totalRows,
      jobs: { jobs: Array.from({ length: jobsCreated }) },
    },
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
