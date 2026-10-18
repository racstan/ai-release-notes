const core = require('@actions/core');
const github = require('@actions/github');

const MARKER = '<!-- ai-release-notes -->';

/**
 * Format commit list for LLM prompt and fallback.
 */
function extractCommitSummaries(commits) {
  if (!Array.isArray(commits)) return [];
  return commits.map(c => {
    const fullMsg = c.commit?.message || c.message || '';
    const firstLine = fullMsg.split('\n')[0].trim();
    const sha = (c.sha || '').substring(0, 7);
    return { sha, summary: firstLine, message: fullMsg };
  });
}

/**
 * Generate fallback plain bullet list of commits.
 */
function generateFallbackNotes(commits) {
  const summaries = extractCommitSummaries(commits);
  if (summaries.length === 0) {
    return '### Summary\n\nNo changes since last release.';
  }

  const bullets = summaries.map(c => (c.sha ? `- ${c.summary} (${c.sha})` : `- ${c.summary}`));
  return `### Changes\n\n${bullets.join('\n')}`;
}

/**
 * Normalize LLM base URL to include /chat/completions.
 */
function getCompletionsEndpoint(baseUrl) {
  let url = (baseUrl || 'https://openrouter.ai/api/v1').trim();
  if (url.endsWith('/chat/completions')) {
    return url;
  }
  return `${url.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * Construct new release body with <!-- ai-release-notes --> marker prepended.
 */
function buildUpdatedReleaseBody(notes, existingBody) {
  const trimmedNotes = (notes || '').trim();
  const trimmedExisting = (existingBody || '').trim();

  if (trimmedExisting.length > 0) {
    return `${MARKER}\n\n${trimmedNotes}\n\n---\n\n${trimmedExisting}`;
  }
  return `${MARKER}\n\n${trimmedNotes}`;
}

/**
 * Determine the previous tag from a list of tags sorted by creation date descending.
 */
function findPreviousTag(sortedTags, targetTag) {
  if (!Array.isArray(sortedTags) || sortedTags.length === 0) {
    return null;
  }

  if (!targetTag) {
    // If no target tag specified, previous tag to latest is the second tag
    return sortedTags.length > 1 ? sortedTags[1].name : null;
  }

  const targetIndex = sortedTags.findIndex(t => t.name === targetTag);
  if (targetIndex !== -1) {
    if (targetIndex + 1 < sortedTags.length) {
      return sortedTags[targetIndex + 1].name;
    }
    // targetTag is the earliest tag
    return null;
  }

  // targetTag is not found in existing tags (e.g. newly created tag or draft)
  // The latest existing tag before this new one is the first tag
  const latestExisting = sortedTags[0].name;
  return latestExisting !== targetTag ? latestExisting : (sortedTags[1]?.name || null);
}

/**
 * Fetch tags sorted by creation/commit date descending.
 */
async function getTagsSortedByDate(octokit, owner, repo) {
  // First attempt: GraphQL API for fast, single-query ordered tags
  try {
    const query = `
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          refs(refPrefix: "refs/tags/", first: 100, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) {
            nodes {
              name
              target {
                oid
                ... on Commit {
                  committedDate
                }
                ... on Tag {
                  tagger {
                    date
                  }
                  target {
                    ... on Commit {
                      committedDate
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = await octokit.graphql(query, { owner, repo });
    const nodes = data?.repository?.refs?.nodes || [];
    if (nodes.length > 0) {
      const parsedTags = nodes.map(node => {
        const dateStr =
          node.target?.tagger?.date ||
          node.target?.committedDate ||
          node.target?.target?.committedDate;
        return {
          name: node.name,
          date: dateStr ? new Date(dateStr).getTime() : 0
        };
      });
      parsedTags.sort((a, b) => b.date - a.date);
      return parsedTags;
    }
  } catch (graphErr) {
    core.info(`GraphQL tag fetch skipped or unavailable (${graphErr.message}). Falling back to REST API.`);
  }

  // Fallback: REST API
  try {
    const tags = await octokit.paginate(octokit.rest.repos.listTags, {
      owner,
      repo,
      per_page: 100
    });

    if (!tags || tags.length === 0) {
      return [];
    }

    // Try to get dates from releases first to minimize API calls
    const tagDateMap = new Map();
    try {
      const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
        owner,
        repo,
        per_page: 100
      });
      for (const rel of releases) {
        if (rel.tag_name && (rel.published_at || rel.created_at)) {
          tagDateMap.set(rel.tag_name, new Date(rel.published_at || rel.created_at).getTime());
        }
      }
    } catch {
      // Ignore release fetch error and proceed
    }

    // For candidate tags without release date, fetch commit dates for up to 30 most recent tags
    const candidateTags = tags.slice(0, 30);
    const enriched = await Promise.all(
      candidateTags.map(async tag => {
        if (tagDateMap.has(tag.name)) {
          return { name: tag.name, date: tagDateMap.get(tag.name) };
        }
        try {
          const { data: commitData } = await octokit.rest.repos.getCommit({
            owner,
            repo,
            ref: tag.commit.sha
          });
          const dateStr = commitData.commit?.committer?.date || commitData.commit?.author?.date;
          const date = dateStr ? new Date(dateStr).getTime() : 0;
          return { name: tag.name, date };
        } catch {
          return { name: tag.name, date: 0 };
        }
      })
    );

    enriched.sort((a, b) => b.date - a.date);
    return enriched;
  } catch (err) {
    core.warning(`Error fetching tags via REST: ${err.message}`);
    return [];
  }
}

/**
 * Summarize commits using an OpenAI-compatible /chat/completions endpoint.
 */
async function summarizeWithLLM({ commits, targetTag, llmBaseUrl, llmModel, llmApiKey }) {
  if (!llmApiKey || llmApiKey.trim() === '') {
    core.warning('No LLM API key configured (llm-api-key is empty). Falling back to plain bullet list of commits.');
    return generateFallbackNotes(commits);
  }

  const summaries = extractCommitSummaries(commits);
  if (summaries.length === 0) {
    return '### Summary\n\nNo changes since last release.';
  }

  const formattedCommits = summaries
    .map(c => `- ${c.summary} (${c.sha})`)
    .join('\n');

  const endpoint = getCompletionsEndpoint(llmBaseUrl);
  core.info(`Requesting release summary from LLM endpoint (${endpoint}) using model "${llmModel}"...`);

  const systemPrompt = [
    'You are an expert release notes generator.',
    'Given the commit messages, write clean, human-readable release notes in GitHub Markdown.',
    'Group items into sections by type: Features, Bug Fixes, Chores.',
    'Exclude empty sections.',
    'No fluff, greetings, intro, or outro. Maximum ~40 lines.'
  ].join(' ');

  const userPrompt = `Release: ${targetTag || 'Latest'}\n\nCommits:\n${formattedCommits}`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmApiKey}`,
        'HTTP-Referer': 'https://github.com/marketplace/actions/ai-release-notes',
        'X-Title': 'AI Release Notes Action'
      },
      body: JSON.stringify({
        model: llmModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2
      }),
      signal: AbortSignal.timeout(45000)
    });

    if (!res.ok) {
      const errText = await res.text();
      core.warning(`LLM API returned status ${res.status}: ${errText}. Falling back to plain bullet list.`);
      return generateFallbackNotes(commits);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content?.trim();

    if (!content) {
      core.warning('LLM response returned empty content. Falling back to plain bullet list.');
      return generateFallbackNotes(commits);
    }

    return content;
  } catch (err) {
    core.warning(`LLM request failed (${err.message}). Falling back to plain bullet list.`);
    return generateFallbackNotes(commits);
  }
}

/**
 * Main action runner.
 */
async function run() {
  try {
    const githubToken = core.getInput('github-token') || process.env.GITHUB_TOKEN;
    if (!githubToken) {
      throw new Error('GitHub token is required. Pass github-token input or set GITHUB_TOKEN environment variable.');
    }

    const tagInput = core.getInput('tag')?.trim() || '';
    const llmBaseUrl = core.getInput('llm-base-url') || 'https://openrouter.ai/api/v1';
    const llmModel = core.getInput('llm-model') || 'openrouter/auto';
    const llmApiKey = core.getInput('llm-api-key')?.trim() || '';
    const dryRun = core.getBooleanInput('dry-run', { required: false });

    // Mask sensitive keys
    if (llmApiKey) {
      core.setSecret(llmApiKey);
    }
    if (githubToken) {
      core.setSecret(githubToken);
    }

    const octokit = github.getOctokit(githubToken);
    const { owner, repo } = github.context.repo;
    core.info(`Running AI Release Notes for ${owner}/${repo}...`);

    let targetTag = tagInput;
    let releaseId = null;
    let existingBody = '';

    // Check if triggered by release event
    if (github.context.eventName === 'release' && github.context.payload.release) {
      const release = github.context.payload.release;
      targetTag = targetTag || release.tag_name;
      releaseId = release.id;
      existingBody = release.body || '';
      core.info(`Detected release event for tag "${targetTag}" (Release ID: ${releaseId}).`);
    }

    // If tag wasn't set by release event or input, try to resolve it
    if (!targetTag) {
      if (github.context.ref && github.context.ref.startsWith('refs/tags/')) {
        targetTag = github.context.ref.replace('refs/tags/', '');
        core.info(`Detected tag from git ref: "${targetTag}".`);
      } else {
        try {
          const { data: latestRelease } = await octokit.rest.repos.getLatestRelease({ owner, repo });
          targetTag = latestRelease.tag_name;
          releaseId = releaseId || latestRelease.id;
          existingBody = existingBody || latestRelease.body || '';
          core.info(`Using latest release tag "${targetTag}".`);
        } catch {
          core.info('Could not find latest release. Listing repository tags...');
          const tags = await getTagsSortedByDate(octokit, owner, repo);
          if (tags.length > 0) {
            targetTag = tags[0].name;
            core.info(`Using most recent tag "${targetTag}".`);
          }
        }
      }
    }

    // If we have targetTag but no releaseId/existingBody yet, look up the release
    if (targetTag && !releaseId) {
      try {
        const { data: release } = await octokit.rest.repos.getReleaseByTag({ owner, repo, tag: targetTag });
        releaseId = release.id;
        existingBody = release.body || '';
      } catch (err) {
        if (err.status === 404) {
          core.info(`No existing GitHub release found for tag "${targetTag}".`);
        } else {
          core.warning(`Error looking up release for tag "${targetTag}": ${err.message}`);
        }
      }
    }

    // Check idempotency early: If marker already exists in body, skip
    if (existingBody && existingBody.includes(MARKER)) {
      core.info(`Release body already contains "${MARKER}". Skipping update (idempotent).`);
      core.setOutput('notes', '');
      core.setOutput('release-updated', 'false');
      return;
    }

    // Find previous tag
    core.info('Resolving previous tag...');
    const sortedTags = await getTagsSortedByDate(octokit, owner, repo);
    const previousTag = findPreviousTag(sortedTags, targetTag);

    let commits = [];

    if (previousTag) {
      core.info(`Comparing commits between previous tag "${previousTag}" and target tag "${targetTag}"...`);
      try {
        const comparison = await octokit.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${previousTag}...${targetTag}`
        });
        commits = comparison.data.commits || [];
        core.info(`Found ${commits.length} commit(s) between ${previousTag} and ${targetTag}.`);
      } catch (err) {
        core.warning(`compareCommitsWithBasehead failed (${err.message}). Trying compareCommits fallback...`);
        const comparison = await octokit.rest.repos.compareCommits({
          owner,
          repo,
          base: previousTag,
          head: targetTag
        });
        commits = comparison.data.commits || [];
      }
    } else {
      core.info('No previous tag found (first release). Fetching up to 200 commits on default branch...');
      let defaultBranch = 'main';
      try {
        const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
        defaultBranch = repoData.default_branch || 'main';
      } catch (err) {
        core.warning(`Failed to fetch default branch name: ${err.message}`);
      }

      const shaToUse = targetTag || defaultBranch;
      let page = 1;
      while (commits.length < 200) {
        const perPage = Math.min(100, 200 - commits.length);
        const { data: pageCommits } = await octokit.rest.repos.listCommits({
          owner,
          repo,
          sha: shaToUse,
          per_page: perPage,
          page
        });
        if (!pageCommits || pageCommits.length === 0) break;
        commits.push(...pageCommits);
        if (pageCommits.length < perPage) break;
        page++;
      }
      core.info(`Collected ${commits.length} commit(s) for the first release.`);
    }

    // Generate release notes
    let notes = '';
    if (commits.length === 0) {
      core.info('No changes detected in commit range.');
      notes = '### Summary\n\nNo changes since last release.';
    } else {
      notes = await summarizeWithLLM({
        commits,
        targetTag,
        llmBaseUrl,
        llmModel,
        llmApiKey
      });
    }

    core.setOutput('notes', notes);

    // Build the updated release body
    const updatedBody = buildUpdatedReleaseBody(notes, existingBody);

    if (dryRun) {
      core.info('=== [DRY RUN MODE ENABLED] ===');
      core.info('The release will NOT be updated. Generated release notes:');
      core.info(updatedBody);
      core.setOutput('release-updated', 'false');
      return;
    }

    if (!releaseId) {
      core.warning(
        `Target tag "${targetTag || 'unknown'}" does not have an associated GitHub Release. Release body was not modified.`
      );
      core.setOutput('release-updated', 'false');
      return;
    }

    // Update release body
    core.info(`Updating release (ID: ${releaseId}) with AI release notes...`);
    await octokit.rest.repos.updateRelease({
      owner,
      repo,
      release_id: releaseId,
      body: updatedBody
    });

    core.info(`Successfully updated release "${targetTag}" with AI release notes!`);
    core.setOutput('release-updated', 'true');
  } catch (error) {
    core.setFailed(`AI Release Notes Action failed: ${error.message}`);
  }
}

module.exports = {
  run,
  extractCommitSummaries,
  generateFallbackNotes,
  getCompletionsEndpoint,
  buildUpdatedReleaseBody,
  findPreviousTag,
  getTagsSortedByDate,
  summarizeWithLLM,
  MARKER
};

if (require.main === module) {
  run();
}
