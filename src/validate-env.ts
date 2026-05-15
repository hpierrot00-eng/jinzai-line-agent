import { config } from './config.js';

const hasLineSender = Boolean(config.LINE_HARNESS_SEND_URL || config.LINE_CHANNEL_ACCESS_TOKEN);
const checks = [
  { name: 'SUPABASE_URL', ok: Boolean(config.SUPABASE_URL) },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', ok: Boolean(config.SUPABASE_SERVICE_ROLE_KEY) },
  { name: 'SLACK_BOT_TOKEN', ok: Boolean(config.SLACK_BOT_TOKEN) },
  { name: 'SLACK_SIGNING_SECRET', ok: Boolean(config.SLACK_SIGNING_SECRET) },
  { name: 'SLACK_APPROVAL_CHANNEL_ID', ok: Boolean(config.SLACK_APPROVAL_CHANNEL_ID) },
  { name: 'LINE sender', ok: hasLineSender, detail: 'Set LINE_HARNESS_SEND_URL or LINE_CHANNEL_ACCESS_TOKEN.' },
  { name: 'ADMIN_API_KEY', ok: Boolean(config.ADMIN_API_KEY), detail: 'Recommended before exposing admin endpoints.' },
];

const missing = checks.filter((check) => !check.ok);

console.log(JSON.stringify({
  ok: missing.length === 0,
  service: 'jinzai-line-agent',
  requiredForMvp: checks,
  missing: missing.map((check) => ({ name: check.name, detail: check.detail })),
}, null, 2));

if (missing.length > 0) process.exit(1);
