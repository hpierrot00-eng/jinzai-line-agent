import { config } from './config.js';
import type { DraftContext, DraftResult, MonthlyRule } from './types.js';

export const KNOWLEDGE_SEARCH_KEYWORDS = [
  '支払い',
  '入金',
  '報酬',
  '就活支援金',
  'キャンセル',
  '日程変更',
  'リスケ',
  '面談',
  '2回目',
  '二回目',
  '確認できました',
  '確認しました',
  '回答しました',
  '参加確認',
  'フォーム',
  '銀行',
  '口座',
  '注意事項',
  'エージェント',
  '紹介',
  'いつ',
  'URL',
  'リンク',
] as const;

const PAYMENT_RE = /支払|支払い|入金|報酬|料金|返金|給与|給料|時給|月給|日給|単価|交通費|契約|条件|待遇|福利厚生|勤務時間|残業|雇用|内定|オファー|採用可否|合否/;
const LEGAL_RE = /法律|違法|労基|労働基準|労災|税金|保険|社会保険|ビザ|visa|在留|永住|就労資格|契約書|個人情報|削除|消去|開示|訂正|同意撤回|退会/iu;
const COMPLAINT_RE = /クレーム|苦情|ハラスメント|パワハラ|セクハラ|詐欺|炎上|訴え|訴訟|トラブル|揉め|晒す|脅|暴力|自殺|死にたい/;

function sensitiveHandoffReply() {
  return 'ご連絡ありがとうございます。内容を担当者が確認し、個別にご案内いたします。正確な確認が必要な内容のため、このまま担当者対応に切り替えます。';
}

function classify(text: string): Pick<DraftResult, 'category' | 'risk_level' | 'confidence' | 'reason'> {
  if (LEGAL_RE.test(text) || COMPLAINT_RE.test(text)) {
    return { category: 'human_required', risk_level: 'blocked', confidence: 0.92, reason: '法律・在留資格・個人情報・苦情など、人間対応が必須の問い合わせ。' };
  }
  if (PAYMENT_RE.test(text)) {
    return { category: 'payment', risk_level: 'high', confidence: 0.88, reason: '支払い・雇用条件・採用判断に関わるため、AIは実質回答せず担当者確認に切り替える。' };
  }
  if (/日程|予定|面談|いつ|何時|都合|空い|空き|予約|リスケ|変更/.test(text)) {
    return { category: 'schedule', risk_level: 'medium', confidence: 0.84, reason: '日程調整に関わるため、初期運用ではSlack承認後に返信。' };
  }
  if (/リンク|URL|zoom|Zoom|meet|Google Meet|注意事項|持ち物/.test(text)) {
    return { category: 'agent_meeting', risk_level: 'low', confidence: 0.78, reason: '面談案内に関する問い合わせ。' };
  }
  return { category: 'general_question', risk_level: 'medium', confidence: 0.7, reason: '一般問い合わせとして安全な返信案を作成。' };
}

function extractSchedule(text: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const dateLike = text.match(/(\d{1,2})[\/月](\d{1,2})日?/);
  const timeLike = text.match(/(\d{1,2})[:時](\d{2})?/);
  if (dateLike) data.date_text = dateLike[0];
  if (timeLike) data.time_text = timeLike[0];
  if (/2回目|二回目|次回/.test(text)) data.appointment_type = 'second_meeting';
  if (/初回|エージェント|面談/.test(text)) data.appointment_type = data.appointment_type ?? 'first_agent_meeting';
  const school = text.match(/([^、。\s]+大学|[^、。\s]+短大|[^、。\s]+専門学校)/);
  if (school) data.school_name = school[1];
  const grad = text.match(/(20\d{2})年卒/);
  if (grad) data.graduation_year = grad[1];
  return data;
}

function fallbackDraft(input: DraftContext): DraftResult {
  const text = input.text;
  const base = classify(text);
  const templateReply = selectTemplate(input.templates, base.category);
  let reply = templateReply ?? 'ご連絡ありがとうございます。内容を確認いたしました。担当より確認のうえ、順次ご案内いたします。';
  const monthlyAnswer = monthlyRuleAnswer(input.monthlyRules);
  if (base.category === 'human_required' || base.risk_level === 'blocked' || base.risk_level === 'high') {
    reply = templateReply ?? sensitiveHandoffReply();
  } else if (!templateReply && base.category === 'schedule') {
    reply = monthlyAnswer ?? 'ご連絡ありがとうございます。日程について確認いたします。候補日時やご希望があれば、あわせてお送りください。';
  } else if (!templateReply && base.category === 'agent_meeting') {
    reply = 'ご連絡ありがとうございます。面談に関するご案内を確認し、必要なリンクや注意事項をお送りします。';
  }
  const topKnowledge = input.knowledge[0];
  if (!monthlyAnswer && !templateReply && topKnowledge && base.risk_level !== 'blocked' && base.risk_level !== 'high') reply = `${reply}\n\n参考: ${topKnowledge.body}`;
  return {
    ...base,
    needs_human_review: true,
    reply_text: reply,
    extracted_data: extractSchedule(text),
    suggested_next_action: base.risk_level === 'blocked' || base.risk_level === 'high' ? 'escalate' : 'approve_send',
  };
}

export function knowledgeSearchTerms(text: string) {
  const normalized = String(text ?? '').normalize('NFKC');
  const terms = new Set<string>();
  for (const term of normalized.split(/[\s、。！？!?,.，．\n\r]+/)) {
    const value = term.trim();
    if (value.length >= 2 && value.length <= 40) terms.add(value);
  }
  for (const keyword of KNOWLEDGE_SEARCH_KEYWORDS) {
    if (normalized.includes(keyword)) terms.add(keyword);
  }
  return [...terms].slice(0, 12);
}

export function formatKnowledgeForPrompt(items: DraftContext['knowledge'] = []) {
  return items.slice(0, 6).map((item) => ({
    title: item.title,
    category: item.category,
    body: item.body,
    priority: item.priority,
  }));
}

function selectTemplate(templates: DraftContext['templates'] = [], category: DraftResult['category']) {
  const exact = templates.find((template) => template.category === category);
  const general = templates.find((template) => template.category === 'general');
  return exact?.body ?? general?.body ?? null;
}

function monthlyRuleAnswer(rules: MonthlyRule[]) {
  if (rules.length === 0) return null;
  const payment = rules.find((rule) => /payment|支払|支払い|報酬/.test(`${rule.category} ${rule.label}`));
  const schedule = rules.find((rule) => /schedule|日程|面談|説明会/.test(`${rule.category} ${rule.label}`));
  const selected = payment ?? schedule ?? rules[0];
  return `${selected.label}は「${selected.value}」です。${selected.notes ? ` ${selected.notes}` : ''}`;
}

function fallbackRevision(currentDraftText: string, instruction: string, monthlyRules: MonthlyRule[] = []): DraftResult {
  let reply = currentDraftText;
  const monthlyAnswer = monthlyRuleAnswer(monthlyRules);

  if (/短く|簡潔|short/i.test(instruction)) {
    reply = currentDraftText
      .replace(/ご連絡ありがとうございます。?/, 'ご連絡ありがとうございます。')
      .replace(/少々お待ちください。?/, '')
      .slice(0, 120);
  }

  if (/丁寧|やわらか|柔らか/.test(instruction)) {
    reply = `${reply}\n\n確認でき次第、あらためて丁寧にご案内いたします。`;
  }

  const sensitivity = classify(currentDraftText + instruction);
  const sensitive = sensitivity.category === 'payment' || sensitivity.category === 'human_required';
  if (sensitive) {
    reply = sensitiveHandoffReply();
  }

  return {
    category: sensitive ? sensitivity.category : 'general_question',
    risk_level: sensitive ? sensitivity.risk_level : 'medium',
    confidence: 0.68,
    needs_human_review: true,
    reply_text: sensitive ? reply : (monthlyAnswer ?? reply),
    reason: `Slack修正依頼を反映: ${instruction}`,
    extracted_data: {},
    suggested_next_action: sensitive ? 'escalate' : 'approve_send',
  };
}

const humanEscalationRequiredFor = ['pay', 'employment_terms', 'hiring_decisions', 'legal', 'visa', 'complaints', 'personal_data_deletion'];

export async function generateDraft(input: DraftContext): Promise<DraftResult> {
  const fallback = fallbackDraft(input);
  if (!config.OPENCLAW_AGENT_URL) return fallback;

  const res = await fetch(config.OPENCLAW_AGENT_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.OPENCLAW_AGENT_TOKEN ? { authorization: `Bearer ${config.OPENCLAW_AGENT_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      task: 'jinzai_line_reply_draft',
      policy: { auto_send_allowed: false, default_mode: 'draft_only', human_escalation_required_for: humanEscalationRequiredFor },
      output_schema: 'category,risk_level,confidence,needs_human_review,reply_text,reason,extracted_data,suggested_next_action',
      input,
      template_hints: input.templates?.map((template) => ({ key: template.key, category: template.category, body: template.body })),
      knowledge_hints: formatKnowledgeForPrompt(input.knowledge),
    }),
  });
  if (!res.ok) throw new Error(`OpenClaw draft failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as Partial<DraftResult>;
  if (fallback.risk_level === 'blocked' || fallback.risk_level === 'high') return fallback;
  return {
    category: json.category ?? fallback.category,
    risk_level: json.risk_level ?? 'medium',
    confidence: typeof json.confidence === 'number' ? json.confidence : 0.7,
    needs_human_review: true,
    reply_text: json.reply_text || fallback.reply_text,
    reason: json.reason || 'OpenClaw generated draft.',
    extracted_data: json.extracted_data ?? fallback.extracted_data,
    suggested_next_action: json.suggested_next_action ?? 'approve_send',
  };
}

export async function generateRevisionDraft(input: { currentDraftText: string; instruction: string; history: unknown[]; student?: unknown; knowledge?: unknown[]; monthlyRules?: MonthlyRule[]; today?: string }): Promise<DraftResult> {
  const fallback = fallbackRevision(input.currentDraftText, input.instruction, input.monthlyRules ?? []);
  if (!config.OPENCLAW_AGENT_URL) return fallback;

  const res = await fetch(config.OPENCLAW_AGENT_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.OPENCLAW_AGENT_TOKEN ? { authorization: `Bearer ${config.OPENCLAW_AGENT_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      task: 'jinzai_line_reply_revision',
      policy: { auto_send_allowed: false, default_mode: 'draft_only', human_escalation_required_for: humanEscalationRequiredFor },
      output_schema: 'category,risk_level,confidence,needs_human_review,reply_text,reason,extracted_data,suggested_next_action',
      input,
    }),
  });
  if (!res.ok) throw new Error(`OpenClaw revision failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as Partial<DraftResult>;
  if (fallback.risk_level === 'blocked' || fallback.risk_level === 'high') return fallback;
  return {
    category: json.category ?? fallback.category,
    risk_level: json.risk_level ?? 'medium',
    confidence: typeof json.confidence === 'number' ? json.confidence : 0.7,
    needs_human_review: true,
    reply_text: json.reply_text || fallback.reply_text,
    reason: json.reason || fallback.reason,
    extracted_data: json.extracted_data ?? {},
    suggested_next_action: json.suggested_next_action ?? 'approve_send',
  };
}
