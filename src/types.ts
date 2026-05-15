export type DraftResult = {
  category: 'schedule' | 'payment' | 'general_question' | 'agent_meeting' | 'human_required';
  risk_level: 'low' | 'medium' | 'high' | 'blocked';
  confidence: number;
  needs_human_review: boolean;
  reply_text: string;
  reason: string;
  extracted_data: Record<string, unknown>;
  suggested_next_action: string;
};

export type InboundLineMessage = {
  lineUserId: string;
  displayName?: string;
  text: string;
  rawPayload?: unknown;
  messageType?: string;
};

export type KnowledgeItem = {
  id: string;
  title: string;
  category: string;
  body: string;
  priority: number;
  effective_from?: string | null;
  effective_until?: string | null;
};

export type MonthlyRule = {
  id: string;
  rule_month: string;
  category: string;
  label: string;
  value: string;
  notes?: string | null;
};

export type DraftContext = {
  text: string;
  history: unknown[];
  student?: unknown;
  knowledge: KnowledgeItem[];
  monthlyRules: MonthlyRule[];
  today: string;
};
