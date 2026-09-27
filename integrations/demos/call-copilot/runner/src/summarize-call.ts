import Anthropic from '@anthropic-ai/sdk';
import type { Pool } from 'mysql2/promise';
import { buildSummaryPrompt } from './prompt';
import { redactPII } from './redact';

export const summarizeCall = async (options: {
  readonly pool: Pool;
  readonly callId: string;
  readonly fullTranscript: string;
}): Promise<string> => {
  const anthropic = new Anthropic();
  const redacted = redactPII(options.fullTranscript);
  const message = await anthropic.messages.create({
    model: process.env.ANTHROPIC_SUMMARY_MODEL ?? 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: buildSummaryPrompt({ fullTranscript: redacted }) }],
  });
  const summaryText = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  await options.pool.query(
    `CREATE TABLE IF NOT EXISTS call_summaries (
      call_id VARCHAR(64) PRIMARY KEY,
      transcript TEXT,
      summary TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await options.pool.query('REPLACE INTO call_summaries (call_id, transcript, summary) VALUES (?, ?, ?)', [
    options.callId,
    redacted,
    summaryText,
  ]);
  return summaryText;
};
