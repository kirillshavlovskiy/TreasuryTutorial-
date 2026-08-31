import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { extractText, isTreasuryMcpConfigured, parseToolResult } from './mcp-client';

const ORIGINAL_URL = process.env.TREASURY_MCP_URL;

describe('treasury/mcp-client', () => {
  afterEach(() => {
    // Plain assignment would coerce `undefined` to the literal string
    // "undefined" (truthy), silently flipping isTreasuryMcpConfigured()
    // for a var that was never actually set.
    if (ORIGINAL_URL === undefined) delete process.env.TREASURY_MCP_URL;
    else process.env.TREASURY_MCP_URL = ORIGINAL_URL;
  });

  describe('extractText', () => {
    it('extracts the text block from an MCP content array', () => {
      expect(extractText([{ type: 'text', text: '{"ok":true}' }])).toBe('{"ok":true}');
    });

    it('picks the first text block when multiple content blocks are present', () => {
      expect(
        extractText([
          { type: 'image', data: 'irrelevant' },
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ]),
      ).toBe('first');
    });

    it('returns null when there is no text block', () => {
      expect(extractText([{ type: 'image', data: 'x' }])).toBeNull();
    });

    it('returns null for non-array content', () => {
      expect(extractText(undefined)).toBeNull();
      expect(extractText('not an array')).toBeNull();
      expect(extractText(null)).toBeNull();
    });
  });

  describe('parseToolResult', () => {
    const schema = z.object({ count: z.number(), name: z.string() });

    it('returns the schema-validated data on a well-shaped success result', () => {
      const result = { content: [{ type: 'text', text: '{"count":2,"name":"EUR"}' }] };
      expect(parseToolResult(result, 'some_tool', schema)).toEqual({ count: 2, name: 'EUR' });
    });

    it('throws using the error content when isError is true', () => {
      const result = { isError: true, content: [{ type: 'text', text: 'permission denied' }] };
      expect(() => parseToolResult(result, 'some_tool', schema)).toThrow(/permission denied/);
    });

    it('throws a generic message when isError is true with no text content', () => {
      const result = { isError: true, content: [] };
      expect(() => parseToolResult(result, 'some_tool', schema)).toThrow(/some_tool.*error/);
    });

    it('throws when there is no text content block at all', () => {
      const result = { content: [{ type: 'image', data: 'x' }] };
      expect(() => parseToolResult(result, 'some_tool', schema)).toThrow(/no text content/);
    });

    it('throws when the text content is not valid JSON', () => {
      const result = { content: [{ type: 'text', text: 'not json{' }] };
      expect(() => parseToolResult(result, 'some_tool', schema)).toThrow(/non-JSON/);
    });

    it('throws when the parsed JSON does not match the schema (e.g. a renamed/retyped field)', () => {
      // Simulates the real failure mode: Treasury renames a field or sends
      // a number where a string was expected — must not silently pass.
      const result = { content: [{ type: 'text', text: '{"count":"two","name":"EUR"}' }] };
      expect(() => parseToolResult(result, 'some_tool', schema)).toThrow(/unexpected shape/);
    });
  });

  describe('isTreasuryMcpConfigured', () => {
    it('is true when TREASURY_MCP_URL is set', () => {
      process.env.TREASURY_MCP_URL = 'https://treasury.deel.com/mcp';
      expect(isTreasuryMcpConfigured()).toBe(true);
    });

    it('is false when unset or blank', () => {
      delete process.env.TREASURY_MCP_URL;
      expect(isTreasuryMcpConfigured()).toBe(false);
      process.env.TREASURY_MCP_URL = '   ';
      expect(isTreasuryMcpConfigured()).toBe(false);
    });
  });
});
