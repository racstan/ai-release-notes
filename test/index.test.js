const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractCommitSummaries,
  generateFallbackNotes,
  getCompletionsEndpoint,
  buildUpdatedReleaseBody,
  findPreviousTag,
  MARKER
} = require('../src/index');

test('extractCommitSummaries extracts first line of message and short sha', () => {
  const commits = [
    {
      sha: '1234567890abcdef',
      commit: { message: 'feat: add awesome feature\n\nDetailed description here.' }
    },
    {
      sha: 'abcdef1234567890',
      commit: { message: 'fix: resolve edge case crash' }
    }
  ];

  const result = extractCommitSummaries(commits);
  assert.equal(result.length, 2);
  assert.equal(result[0].sha, '1234567');
  assert.equal(result[0].summary, 'feat: add awesome feature');
  assert.equal(result[1].sha, 'abcdef1');
  assert.equal(result[1].summary, 'fix: resolve edge case crash');
});

test('generateFallbackNotes returns "No changes" when commit list is empty', () => {
  const notes = generateFallbackNotes([]);
  assert.match(notes, /No changes since last release/);
});

test('generateFallbackNotes creates bullet list when commits exist', () => {
  const commits = [
    {
      sha: '1111222333',
      commit: { message: 'feat: new login page' }
    },
    {
      sha: '4444555666',
      commit: { message: 'fix: typo in header' }
    }
  ];

  const notes = generateFallbackNotes(commits);
  assert.match(notes, /### Changes/);
  assert.match(notes, /- feat: new login page \(1111222\)/);
  assert.match(notes, /- fix: typo in header \(4444555\)/);
});

test('getCompletionsEndpoint appends /chat/completions correctly', () => {
  assert.equal(
    getCompletionsEndpoint('https://openrouter.ai/api/v1'),
    'https://openrouter.ai/api/v1/chat/completions'
  );
  assert.equal(
    getCompletionsEndpoint('https://openrouter.ai/api/v1/'),
    'https://openrouter.ai/api/v1/chat/completions'
  );
  assert.equal(
    getCompletionsEndpoint('https://api.openai.com/v1/chat/completions'),
    'https://api.openai.com/v1/chat/completions'
  );
});

test('buildUpdatedReleaseBody prepends marker and notes', () => {
  const notes = '### Features\n- New UI';
  const existing = 'Manual release assets details.';

  const body = buildUpdatedReleaseBody(notes, existing);
  assert(body.startsWith(MARKER));
  assert(body.includes('### Features\n- New UI'));
  assert(body.includes('Manual release assets details.'));
  assert(body.includes('---'));
});

test('buildUpdatedReleaseBody handles empty existing body', () => {
  const notes = '### Features\n- Initial release';
  const body = buildUpdatedReleaseBody(notes, '');
  assert.equal(body, `${MARKER}\n\n${notes}`);
});

test('findPreviousTag accurately finds tag before target tag', () => {
  const sortedTags = [
    { name: 'v2.0.0', date: 300 },
    { name: 'v1.5.0', date: 200 },
    { name: 'v1.0.0', date: 100 }
  ];

  // Target v2.0.0 -> previous should be v1.5.0
  assert.equal(findPreviousTag(sortedTags, 'v2.0.0'), 'v1.5.0');

  // Target v1.5.0 -> previous should be v1.0.0
  assert.equal(findPreviousTag(sortedTags, 'v1.5.0'), 'v1.0.0');

  // Target v1.0.0 (oldest) -> previous should be null
  assert.equal(findPreviousTag(sortedTags, 'v1.0.0'), null);

  // Target not in list (new tag like v3.0.0) -> previous should be newest existing (v2.0.0)
  assert.equal(findPreviousTag(sortedTags, 'v3.0.0'), 'v2.0.0');
});

test('findPreviousTag handles empty or single tag lists', () => {
  assert.equal(findPreviousTag([], 'v1.0.0'), null);
  assert.equal(findPreviousTag([{ name: 'v1.0.0', date: 100 }], 'v1.0.0'), null);
});
