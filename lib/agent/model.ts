/**
 * Gemini model for the Workbench AI Agent.
 *
 * Pin the Lite alias — `gemini-flash-latest` currently resolves to
 * gemini-3.7-flash (20 free requests/day), and concrete 2.5 IDs are closed
 * to new API keys. Lite has its own quota bucket and still does tool calling.
 */
export const AGENT_GEMINI_MODEL = 'gemini-flash-lite-latest';
