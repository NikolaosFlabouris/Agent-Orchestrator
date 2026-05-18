import { describe, it, expect } from 'vitest';
import {
  formatReviewFeedback,
  formatRubricMarkdown,
  formatReviewForRework,
} from '../../agents/review.js';

describe('formatReviewFeedback — new shape', () => {
  const feedback = [
    {
      file: 'src/b.ts',
      line: 10,
      category: 'security',
      severity: 'blocker',
      comment: 'SQL string is interpolated',
      suggestion: 'Use a parameterized query',
    },
    {
      file: 'src/a.ts',
      line: 5,
      category: 'correctness',
      severity: 'major',
      comment: 'Off-by-one in loop bound',
      suggestion: 'Use < instead of <=',
    },
    {
      file: 'src/a.ts',
      line: 99,
      category: 'security',
      severity: 'blocker',
      comment: 'Secret logged',
      suggestion: 'Redact the token before logging',
    },
  ];

  it('groups by severity (blocker before major)', () => {
    const md = formatReviewFeedback(feedback);
    expect(md).toContain('#### Blocker');
    expect(md).toContain('#### Major');
    expect(md.indexOf('#### Blocker')).toBeLessThan(md.indexOf('#### Major'));
  });

  it('renders file:line, category, comment, and suggestion', () => {
    const md = formatReviewFeedback(feedback);
    expect(md).toContain('**src/b.ts:10**');
    expect(md).toContain('_(security)_');
    expect(md).toContain('SQL string is interpolated');
    expect(md).toContain('Suggested change: Use a parameterized query');
  });

  it('sorts files within a severity group', () => {
    const md = formatReviewFeedback(feedback);
    const blockerSection = md.slice(md.indexOf('#### Blocker'));
    expect(blockerSection.indexOf('src/a.ts:99')).toBeLessThan(
      blockerSection.indexOf('src/b.ts:10')
    );
  });
});

describe('formatReviewFeedback — backward compatibility', () => {
  it('renders the legacy {file,line,comment} shape without throwing', () => {
    const legacy = [
      { file: 'src/x.ts', line: 3, comment: 'Needs a null check' },
    ];
    const md = formatReviewFeedback(legacy);
    expect(md).toContain('src/x.ts:3');
    expect(md).toContain('Needs a null check');
    // No category/severity/suggestion -> bucketed under "Other", no crash.
    expect(md).toContain('#### Other');
    expect(md).not.toContain('Suggested change:');
  });

  it('returns a bare string verbatim', () => {
    expect(formatReviewFeedback('Just fix the thing')).toBe(
      'Just fix the thing'
    );
  });

  it('does not throw on null/undefined/empty/malformed input', () => {
    expect(formatReviewFeedback(undefined)).toBe('');
    expect(formatReviewFeedback([])).toBe('');
    // Malformed entries (missing fields, wrong types) must degrade, not
    // throw. review.json is LLM-produced, so the formatter is the boundary.
    const malformed = [
      { line: 'not-a-number' },
      null,
      { file: 7, comment: 42 },
    ] as unknown as Parameters<typeof formatReviewFeedback>[0];
    expect(() => formatReviewFeedback(malformed)).not.toThrow();
    expect(formatReviewFeedback(malformed)).toContain('unknown');
  });
});

describe('formatRubricMarkdown', () => {
  it('renders all dimensions in canonical order', () => {
    const md = formatRubricMarkdown({
      quality: { status: 'pass', note: 'clean' },
      requirements: { status: 'fail', note: 'missing X' },
      correctness: { status: 'concern', note: 'edge case' },
      tests: { status: 'pass' },
      security: { status: 'pass' },
    });
    expect(md).toContain('### Rubric');
    expect(md).toContain('**requirements**: FAIL — missing X');
    expect(md).toContain('**correctness**: CONCERN — edge case');
    expect(md).toContain('**quality**: PASS');
    expect(md.indexOf('requirements')).toBeLessThan(md.indexOf('quality'));
  });

  it('returns empty string for missing/invalid rubric', () => {
    expect(formatRubricMarkdown(undefined)).toBe('');
    // @ts-expect-error intentionally invalid
    expect(formatRubricMarkdown('nope')).toBe('');
  });
});

describe('formatReviewForRework', () => {
  it('combines rubric summary and grouped feedback', () => {
    const body = formatReviewForRework({
      verdict: 'changes_needed',
      summary: 'Needs work',
      rubric: { requirements: { status: 'fail', note: 'missing validation' } },
      feedback: [
        {
          file: 'src/login.ts',
          line: 12,
          category: 'requirements',
          severity: 'blocker',
          comment: 'No email format check',
          suggestion: 'Add a regex validation before submit',
        },
      ],
    });
    expect(body).toContain('### Rubric');
    expect(body).toContain('### Feedback');
    expect(body).toContain('src/login.ts:12');
    expect(body).toContain('Suggested change: Add a regex validation');
  });

  it('still produces output for the legacy/string shapes', () => {
    expect(
      formatReviewForRework({
        verdict: 'changes_needed',
        feedback: 'fix it',
      })
    ).toContain('fix it');
    expect(
      formatReviewForRework({
        verdict: 'changes_needed',
        feedback: [{ file: 'a.ts', line: 1, comment: 'bug' }],
      })
    ).toContain('a.ts:1');
  });
});
