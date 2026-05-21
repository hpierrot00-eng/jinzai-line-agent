import 'dotenv/config';
import { z } from 'zod';

const postgresUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID');

const boolFromEnv = z.preprocess((value) => {
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  return value;
}, z.boolean());

const mergedEnv = {
  ...process.env,
  GOOGLE_SHEETS_SPREADSHEET_ID: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || process.env.CUSTOMER_SHEET_SPREADSHEET_ID,
  GOOGLE_SHEETS_TAB_NAME: process.env.GOOGLE_SHEETS_TAB_NAME || process.env.CUSTOMER_SHEET_TAB_NAME,
  GOOGLE_SHEETS_HEADER_ROW: process.env.GOOGLE_SHEETS_HEADER_ROW || process.env.CUSTOMER_SHEET_HEADER_ROW,
  POST_PARTICIPATION_RESPONSES_SPREADSHEET_ID: process.env.POST_PARTICIPATION_RESPONSES_SPREADSHEET_ID || process.env.PARTICIPATION_FORM_SPREADSHEET_ID,
  POST_PARTICIPATION_RESPONSES_TAB_NAME: process.env.POST_PARTICIPATION_RESPONSES_TAB_NAME || process.env.PARTICIPATION_FORM_TAB_NAME,
  POST_PARTICIPATION_RESPONSES_HEADER_ROW: process.env.POST_PARTICIPATION_RESPONSES_HEADER_ROW || process.env.PARTICIPATION_FORM_HEADER_ROW,
  BANK_ACCOUNT_RESPONSES_SPREADSHEET_ID: process.env.BANK_ACCOUNT_RESPONSES_SPREADSHEET_ID || process.env.BANK_FORM_SPREADSHEET_ID,
  BANK_ACCOUNT_RESPONSES_TAB_NAME: process.env.BANK_ACCOUNT_RESPONSES_TAB_NAME || process.env.BANK_FORM_TAB_NAME,
  BANK_ACCOUNT_RESPONSES_HEADER_ROW: process.env.BANK_ACCOUNT_RESPONSES_HEADER_ROW || process.env.BANK_FORM_HEADER_ROW,
};

const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  PUBLIC_BASE_URL: z.string().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DEFAULT_CLIENT_ID: postgresUuid.default('00000000-0000-0000-0000-000000000001'),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_APPROVAL_CHANNEL_ID: z.string().min(1),
  LINE_HARNESS_SEND_URL: z.string().optional().default(''),
  LINE_HARNESS_API_KEY: z.string().optional().default(''),
  LINE_HARNESS_TAG_SYNC_ENABLED: boolFromEnv.default(false),
  LINE_HARNESS_TAG_SYNC_URL: z.string().optional().default(''),
  LINE_SEND_DRY_RUN: boolFromEnv.default(false),
  LINE_MARK_AS_READ_ENABLED: boolFromEnv.default(true),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().optional().default(''),
  LINE_CHANNEL_SECRET: z.string().optional().default(''),
  GOOGLE_SHEETS_SPREADSHEET_ID: z.string().optional().default(''),
  GOOGLE_SHEETS_TAB_NAME: z.string().optional().default(''),
  GOOGLE_SHEETS_HEADER_ROW: z.coerce.number().int().positive().default(1),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().optional().default(''),
  GOOGLE_PRIVATE_KEY: z.string().optional().default(''),
  SHEETS_COLUMN_MAP_JSON: z.string().optional().default(''),
  SHEETS_DRY_RUN: boolFromEnv.default(true),
  SHEETS_WRITE_DRY_RUN: boolFromEnv.default(false),
  POST_PARTICIPATION_RESPONSES_SPREADSHEET_ID: z.string().optional().default(''),
  POST_PARTICIPATION_RESPONSES_TAB_NAME: z.string().optional().default(''),
  POST_PARTICIPATION_RESPONSES_HEADER_ROW: z.coerce.number().int().positive().default(1),
  POST_PARTICIPATION_RESPONSE_COLUMN_MAP_JSON: z.string().optional().default(''),
  BANK_ACCOUNT_RESPONSES_SPREADSHEET_ID: z.string().optional().default(''),
  BANK_ACCOUNT_RESPONSES_TAB_NAME: z.string().optional().default(''),
  BANK_ACCOUNT_RESPONSES_HEADER_ROW: z.coerce.number().int().positive().default(1),
  BANK_ACCOUNT_RESPONSE_COLUMN_MAP_JSON: z.string().optional().default(''),
  POST_PARTICIPATION_FORM_URL: z.string().optional().default(''),
  BANK_ACCOUNT_FORM_URL: z.string().optional().default(''),
  WORKFLOW_TIMEZONE: z.string().default('Asia/Tokyo'),
  SAME_DAY_REMINDER_OFFSET_HOURS: z.coerce.number().default(2),
  POST_FORM_DELAY_HOURS: z.coerce.number().default(2),
  OPENCLAW_AGENT_URL: z.string().optional().default(''),
  OPENCLAW_AGENT_TOKEN: z.string().optional().default(''),
  OPENCLAW_MODEL_NAME: z.string().default('openclaw'),
  ADMIN_API_KEY: z.string().optional().default(''),
});

export const config = envSchema.parse(mergedEnv);
