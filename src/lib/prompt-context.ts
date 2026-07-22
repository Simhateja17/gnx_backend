// A campaign's ICP source and prompt notes are stored together as a JSON blob
// in campaigns.prompt_context. That shape is a storage detail - it must never
// reach a model prompt verbatim, or the model reads the braces and key names
// as part of the instruction. Parse here, and format for prompts here.

export type PromptContext = {
  icpSource: string;
  promptNotes: string;
};

export function parsePromptContext(value: string | null): PromptContext {
  if (!value) return { icpSource: '', promptNotes: '' };
  try {
    const parsed = JSON.parse(value) as Partial<PromptContext>;
    return {
      // Pre-JSON rows stored the ICP source as a bare string, so a parse that
      // yields no known keys means the whole value was the source.
      icpSource: parsed.icpSource ?? value,
      promptNotes: parsed.promptNotes ?? '',
    };
  } catch {
    return { icpSource: value, promptNotes: '' };
  }
}

export function serializePromptContext(data: Partial<PromptContext>): string {
  return JSON.stringify({
    icpSource: data.icpSource ?? '',
    promptNotes: data.promptNotes ?? '',
  });
}

// Renders the context as labelled lines for a prompt. Returns '' when there is
// nothing to say, so callers can drop the section entirely. The email prompt
// uses bare UPPERCASE headings while the voice prompt uses a "- Title Case"
// bulleted list, so the caller picks which shape to match.
export function formatPromptContextForPrompt(
  value: string | null,
  options: { bullet?: string; labels?: 'upper' | 'title' } = {}
): string {
  const { bullet = '', labels = 'upper' } = options;
  const { icpSource, promptNotes } = parsePromptContext(value);

  const audienceLabel = labels === 'title' ? 'Target Audience' : 'TARGET AUDIENCE';
  const notesLabel = labels === 'title' ? 'Campaign Notes' : 'CAMPAIGN NOTES';

  const lines: string[] = [];
  if (icpSource.trim()) lines.push(`${bullet}${audienceLabel}: ${icpSource.trim()}`);
  if (promptNotes.trim()) lines.push(`${bullet}${notesLabel}: ${promptNotes.trim()}`);

  return lines.join('\n');
}
