import { NextResponse } from 'next/server';
import { google } from '@ai-sdk/google';
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from 'ai';
import { getServerSession } from '@/auth';
import { TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';
import { AGENT_GEMINI_MODEL } from '@/lib/agent/model';
import { buildAgentTools } from '@/lib/agent/tools';
import type { AttachedDataFile, DeskContextSnapshot } from '@/lib/agent/desk-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SYSTEM_PROMPT_SHARED = `You help the treasury user analyse and optimise their FX book in plain language.

Capabilities (via tools — always use them for numbers, never estimate):
- get_desk_state: current exposures, cash/payout, VaR setup, hedges. Call it before your first analysis.
- compute_var: parametric VaR across the book, with what-if setup / hedge-ratio overrides.
- compute_var_for_custom_exposure: VaR on numbers that are not on the desk (e.g. from uploaded files).
- analyze_liquidity: Liquidity tab cash path — trough, drawdown, days below floor, H* buffer, swap cover, funded cycle plan. Use this for "can I fund the next N months", payout gaps, or swap sizing. This is cash timing, not FX CFaR.
- optimize_liquidity_buffer: size H* and the FX-swap near leg (payout-uncertainty / floor / carry layers).
- analyze_cash_carry: cash interest + hedge carry (forward points, interest legs) over the forecast.
- optimize_carry_structure: search strip shapes around a target WAM to maximise carry enhancement.
- compute_cfar: Cash Flow at Risk (peak bridge-funding reserve from FX and timing), closed form or Monte Carlo. Complementary to analyze_liquidity — CFaR is FX-value-of-cash risk; liquidity is the cash-path funding plan.
- read_uploaded_data: tables from files the user attached (CSV / Excel).

Conversation style:
- If the user has not said what they want, ask what they would like to optimise:
  FX risk (VaR), liquidity / cash funding, carry cost/income, or cash-flow risk (CFaR) — and offer to look at attached data.
- Ground answers in tool results. Quote figures in USD millions (or K where small) and name the
  setup they were computed under (confidence, horizon, basis).
- Units: exposures and liquidity path figures are in local-currency millions; VaR / carry / CFaR figures are USD millions. Say which.
- Be concise. Format every answer in GitHub-flavoured markdown: ### headings,
  bullet lists, and pipe tables for per-currency figures. Horizontal rules (---)
  between sections. Do not wrap the whole reply in a code fence, and do not dump
  raw tool JSON. Close with one clear recommendation or next question.
- If a tool returns an error, explain it briefly and suggest what is missing.`;

const SYSTEM_PROMPT_WORKBENCH = `You are the AI assistant on the Simple Sigma Treasury Workbench FX desk.
${SYSTEM_PROMPT_SHARED}
- You are advisory: you cannot book trades or change desk state. When the user wants to act,
  tell them where in the Workbench to do it (Liquidity tab for buffers/swaps, Hedging Decision to book, Analytics to change setup).`;

const SYSTEM_PROMPT_SANDBOX = `You are the AI assistant in the Simple Sigma Practice sandbox (NordTech sample book).
${SYSTEM_PROMPT_SHARED}
- You are advisory: you cannot book trades, change desk state, or submit Curriculum Validate.
  When the user wants to act, tell them which sandbox tab to use (Analytics, Hedging Decision,
  Liquidity, Live Ladder). Curriculum answers must be typed into the task panel by the user.`;

interface AgentChatRequest {
  messages: UIMessage[];
  deskContext: DeskContextSnapshot;
  attachedData?: AttachedDataFile[];
}

export async function POST(request: Request) {
  const session = await getServerSession();
  const email = session?.user?.email?.trim() ?? '';
  if (!email || email === TEST_GUEST_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return NextResponse.json(
      {
        error:
          'AI agent is not configured: set GOOGLE_GENERATIVE_AI_API_KEY in .env.local '
          + '(free key at https://aistudio.google.com/apikey).',
      },
      { status: 503 },
    );
  }

  let body: AgentChatRequest;
  try {
    body = (await request.json()) as AgentChatRequest;
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || !body.deskContext) {
    return NextResponse.json(
      { error: 'Expected { messages, deskContext }' },
      { status: 400 },
    );
  }

  const result = streamText({
    model: google(AGENT_GEMINI_MODEL),
    system:
      body.deskContext.surface === 'sandbox'
        ? SYSTEM_PROMPT_SANDBOX
        : SYSTEM_PROMPT_WORKBENCH,
    messages: await convertToModelMessages(body.messages),
    tools: buildAgentTools(body.deskContext, body.attachedData ?? []),
    // One question can legitimately fan out: desk state → VaR → carry → CFaR.
    stopWhen: stepCountIs(8),
    // Don't burn 3 quota hits retrying a 429.
    maxRetries: 0,
    onError: ({ error }) => {
      console.error('[api/agent/chat] stream error', error);
    },
  });

  return result.toUIMessageStreamResponse({
    // AI SDK v7: maps stream errors into the UI message stream (not ResponseInit).
    onError: error => {
      const raw = error instanceof Error ? error.message : String(error);
      if (/quota|429|RESOURCE_EXHAUSTED|rate/i.test(raw)) {
        return (
          'Gemini free-tier quota for this model is used up. Wait about a minute '
          + `and try again (daily cap is per model — we use ${AGENT_GEMINI_MODEL}).`
        );
      }
      return raw || 'The AI agent failed to respond. Try again.';
    },
  });
}
