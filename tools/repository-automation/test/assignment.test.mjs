import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const assignmentScript = join(repositoryRoot, 'tools/repository-automation/assign-on-comment.mjs');

function event({ actor = 'student', assignees = [], body = '/assign', authorAssociation = 'NONE' } = {}) {
  return {
    issue: { number: 41, state: 'open', assignees, labels: [{ name: 'NSOC' }] },
    comment: { user: { login: actor }, body, author_association: authorAssociation },
  };
}

function currentIssue({ assignees = [] } = {}) {
  return { number: 41, state: 'open', assignees, labels: [{ name: 'NSOC' }] };
}

async function runAssignment({ payload, current, searchCount = 0, assigneeEligible = true, comments = [] }) {
  const directory = await mkdtemp(join(tmpdir(), 'assignment-test-'));
  const eventPath = join(directory, 'event.json');
  const preloadPath = join(directory, 'mock-fetch.mjs');
  const callsPath = join(directory, 'calls.json');
  await writeFile(eventPath, JSON.stringify(payload));
  await writeFile(preloadPath, `
    import { writeFileSync } from 'node:fs';
    const calls = [];
    const current = ${JSON.stringify(current)};
    const mockComments = ${JSON.stringify(comments)};
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ url: String(url), method, body: options.body ?? null });
      if (String(url).includes('/search/issues')) {
        return new Response(JSON.stringify({ total_count: ${searchCount} }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'POST' && String(url).includes('/assignees')) {
        if (!${assigneeEligible}) {
          return new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'GET' && /\\/issues\\/41\\/comments/.test(String(url))) {
        return new Response(JSON.stringify(mockComments), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'GET' && /\\/issues\\/41$/.test(String(url))) {
        return new Response(JSON.stringify(current), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'DELETE' || method === 'POST') {
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ number: 1, html_url: 'https://example.invalid/1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    process.on('exit', () => writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls)));
  `);

  try {
    await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [
        '--import', pathToFileURL(preloadPath).href,
        '--input-type=module',
        '--eval', 'await import(process.env.ASSIGNMENT_SCRIPT)',
      ], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          ASSIGNMENT_SCRIPT: pathToFileURL(assignmentScript).href,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_TOKEN: 'test-token',
          GITHUB_REPOSITORY: 'example/repository',
        },
        stdio: 'ignore',
      });
      child.on('error', rejectRun);
      child.on('close', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`assignment script exited ${code}`)));
    });
    return JSON.parse(await readFile(callsPath, 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const writesToAssignees = (calls) => calls.filter((c) => c.method === 'POST' && c.url.includes('/assignees'));
const deletesFromAssignees = (calls) => calls.filter((c) => c.method === 'DELETE' && c.url.includes('/assignees'));
const postsComment = (calls) => calls.filter((c) => c.method === 'POST' && c.url.includes('/comments'));

test('uses the current issue state to reject an already-assigned issue', async () => {
  const calls = await runAssignment({
    payload: event(),
    current: currentIssue({ assignees: [{ login: 'first-student' }] }),
  });
  assert.equal(writesToAssignees(calls).length, 0);
});

test('enforces the contributor assignment quota before assignment', async () => {
  const calls = await runAssignment({ payload: event(), current: currentIssue(), searchCount: 1 });
  assert.equal(writesToAssignees(calls).length, 0);
});

test('permits one eligible assignment (native)', async () => {
  const calls = await runAssignment({ payload: event(), current: currentIssue() });
  assert.equal(writesToAssignees(calls).length, 1);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/labels')).length, 1);
});

test('falls back to virtual assignment when contributor is not a collaborator', async () => {
  const calls = await runAssignment({ payload: event(), current: currentIssue(), assigneeEligible: false });
  // Native assignment attempted but failed (422), script should still succeed
  assert.equal(writesToAssignees(calls).length, 1); // the attempt
  // Comment posted with virtual assignment marker
  const commentCalls = postsComment(calls);
  assert.ok(commentCalls.length >= 1);
  const lastComment = commentCalls[commentCalls.length - 1];
  assert.ok(JSON.parse(lastComment.body).body.includes('virtual'));
  assert.ok(JSON.parse(lastComment.body).body.includes('repository-automation:assignment'));
  // Label still applied
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/labels')).length, 1);
});

test('rejects a stale queued request when the issue was assigned by the prior run', async () => {
  const calls = await runAssignment({
    payload: event({ actor: 'second-student', assignees: [] }),
    current: currentIssue({ assignees: [{ login: 'first-student' }] }),
  });
  assert.equal(writesToAssignees(calls).length, 0);
});

test('permits maintainer delegation with /assign @student', async () => {
  const calls = await runAssignment({
    payload: event({ actor: 'owner-login', body: '/assign @chanchall26', authorAssociation: 'OWNER' }),
    current: currentIssue(),
  });
  const assignCalls = writesToAssignees(calls);
  assert.equal(assignCalls.length, 1);
  assert.equal(JSON.parse(assignCalls[0].body).assignees[0], 'chanchall26');
});

test('permits maintainer /assign without mention by picking candidate from prior comments', async () => {
  const calls = await runAssignment({
    payload: event({ actor: 'owner-login', body: '/assign', authorAssociation: 'OWNER' }),
    current: currentIssue(),
    comments: [
      { user: { login: 'chanchall26' }, body: 'I would like to work on this issue for NSOC', author_association: 'NONE' },
    ],
  });
  const assignCalls = writesToAssignees(calls);
  assert.equal(assignCalls.length, 1);
  assert.equal(JSON.parse(assignCalls[0].body).assignees[0], 'chanchall26');
});

test('rejects non-maintainer delegation attempt', async () => {
  const calls = await runAssignment({
    payload: event({ actor: 'student1', body: '/assign @student2', authorAssociation: 'NONE' }),
    current: currentIssue(),
  });
  assert.equal(writesToAssignees(calls).length, 0);
  assert.ok(postsComment(calls).length >= 1);
});

test('permits contributor unassignment with /unassign', async () => {
  const calls = await runAssignment({
    payload: event({ actor: 'student', body: '/unassign', authorAssociation: 'NONE' }),
    current: currentIssue({ assignees: [{ login: 'student' }] }),
  });
  assert.equal(deletesFromAssignees(calls).length, 1);
});

test('permits maintainer unassignment with /unassign @student', async () => {
  const calls = await runAssignment({
    payload: event({ actor: 'owner-login', body: '/unassign @student', authorAssociation: 'OWNER' }),
    current: currentIssue({ assignees: [{ login: 'student' }] }),
  });
  assert.equal(deletesFromAssignees(calls).length, 1);
});

test('detects virtual assignment and blocks duplicate', async () => {
  const calls = await runAssignment({
    payload: event({ actor: 'another-student' }),
    current: currentIssue({ assignees: [] }),
    comments: [
      { body: 'Assigned to @first-student (virtual)\n\n<!-- repository-automation:assignment assignee=first-student assigned_at=2026-01-01T00:00:00Z -->', user: { login: 'github-actions[bot]' } },
    ],
  });
  assert.equal(writesToAssignees(calls).length, 0);
  const commentBodies = postsComment(calls).map(c => JSON.parse(c.body).body);
  assert.ok(commentBodies.some(b => b.includes('already has an active assignee')));
});
