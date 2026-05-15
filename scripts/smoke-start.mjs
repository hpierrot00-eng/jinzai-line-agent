process.env.PORT ||= '8799';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'smoke-test-key';
process.env.SLACK_BOT_TOKEN ||= 'xoxb-smoke-test';
process.env.SLACK_SIGNING_SECRET ||= 'smoke-test-secret';
process.env.SLACK_APPROVAL_CHANNEL_ID ||= 'C0123456789';
process.env.LINE_CHANNEL_ACCESS_TOKEN ||= 'smoke-test-line-token';
process.env.ADMIN_API_KEY ||= 'smoke-test-admin-key';

await import('../dist/server.js');

const url = `http://127.0.0.1:${process.env.PORT}/health`;
let ok = false;
let lastError;
for (let i = 0; i < 20; i += 1) {
  try {
    const res = await fetch(url);
    const json = await res.json();
    if (res.ok && json.ok === true && json.service === 'jinzai-line-agent') {
      ok = true;
      console.log('Smoke health check passed:', json);
      break;
    }
    lastError = new Error(`Unexpected health response ${res.status}: ${JSON.stringify(json)}`);
  } catch (err) {
    lastError = err;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

if (!ok) {
  console.error('Smoke health check failed:', lastError);
  process.exit(1);
}

process.exit(0);
