import 'dotenv/config';
import { z } from 'zod';

const postgresUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID');

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
  LINE_CHANNEL_ACCESS_TOKEN: z.string().optional().default(''),
  LINE_CHANNEL_SECRET: z.string().optional().default(''),
  OPENCLAW_AGENT_URL: z.string().optional().default(''),
  OPENCLAW_AGENT_TOKEN: z.string().optional().default(''),
  OPENCLAW_MODEL_NAME: z.string().default('openclaw'),
  ADMIN_API_KEY: z.string().optional().default(''),
});

export const config = envSchema.parse(process.env);
