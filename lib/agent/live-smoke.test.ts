/**
 * Live smoke test for the AI Agent: one real Gemini call through the desk
 * tool loop. Needs GOOGLE_GENERATIVE_AI_API_KEY (read from the environment or
 * .env.local); skips silently when absent so the suite stays offline-safe.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateText, stepCountIs } from 'ai';
import { google } from '@ai-sdk/google';
import { AGENT_GEMINI_MODEL } from '@/lib/agent/model';
import { buildAgentTools } from '@/lib/agent/tools';
import type { DeskContextSnapshot } from '@/lib/agent/desk-context';
import { computeTaskVar } from '@/lib/test-mode/task-var';
import { DEFAULT_VAR_SETUP, type VarSetup } from '@/lib/test-mode/var-setup';
import type { LadderBar } from '@/lib/test-mode/types';

const KEY_NAME = 'GOOGLE_GENERATIVE_AI_API_KEY';

// Vitest does not load .env.local; pick the key up the way `next dev` would.
if (!process.env[KEY_NAME]) {
  const envPath = path.resolve(__dirname, '../../.env.local');
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .find(l => l.startsWith(`${KEY_NAME}=`));
    const value = line?.slice(KEY_NAME.length + 1).trim();
    if (value) process.env[KEY_NAME] = value;
  }
}

const hasKey = Boolean(process.env[KEY_NAME]);

function snapshot(): DeskContextSnapshot {
  const setup: VarSetup = {
    ...DEFAULT_VAR_SETUP,
    horizon: '1y',
    forecastMonths: 12,
  };
  const bar: LadderBar = {
    ccy: 'EUR',
    stockNetM: 1.9,
    flowM: 1.2,
    avg3mM: 2.5,
    direction: 'long',
  };
  return {
    entityName: 'SmokeCo',
    dashboardName: 'FX desk',
    risk: [
      {
        bar,
        varStock: computeTaskVar(bar, { ...setup, exposureBasis: 'stock' }),
        varAvg3m: computeTaskVar(bar, { ...setup, exposureBasis: 'avgBuildup' }),
      },
    ],
    varSetup: setup,
    hedgeRatios: {},
    bookedHedges: [],
    preparedByCcy: {},
    marketRatesByCcy: {},
    bookRows: [],
    forecastProfile: null,
    ratesScopeId: 'smoke-entity',
  };
}

describe('agent live smoke (Gemini)', () => {
  it.skipIf(!hasKey)(
    'answers a VaR question by calling the desk tools',
    async () => {
      const result = await generateText({
        model: google(AGENT_GEMINI_MODEL),
        system:
          'You are a treasury FX desk assistant. Always use the tools for numbers.',
        prompt:
          'What is my current open EUR VaR in USD millions? Check the desk state and compute it.',
        tools: buildAgentTools(snapshot(), []),
        stopWhen: stepCountIs(5),
      });
      const toolsUsed = result.steps.flatMap(s =>
        s.toolCalls.map(c => c.toolName),
      );
      expect(toolsUsed.length).toBeGreaterThan(0);
      expect(result.text.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log('[live-smoke] tools used:', toolsUsed.join(', '));
      // eslint-disable-next-line no-console
      console.log('[live-smoke] reply:', result.text);
    },
    90_000,
  );
});
