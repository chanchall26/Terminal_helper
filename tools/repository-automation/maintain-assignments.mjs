import { readFile } from 'node:fs/promises';
import { findVirtualAssignee, githubClient } from './lib/common.mjs';

const config = JSON.parse(await readFile('.github/repository-automation/config.json', 'utf8'));
if (!config.assignment.enabled_by_default) {
  console.log('Assignment maintenance is disabled by configuration.');
  process.exit(0);
}
const client = githubClient({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY });
const issues = await client.request(`/repos/${client.repository}/issues?state=open&labels=${encodeURIComponent('status: in progress')}&per_page=100`);
const now = Date.now();

for (const issue of issues.filter((item) => !item.pull_request)) {
  const nativeAssignee = issue.assignees?.[0]?.login;
  let assignee = nativeAssignee;
  let isVirtual = false;

  if (!assignee) {
    const comments = await client.request(`/repos/${client.repository}/issues/${issue.number}/comments?per_page=100`);
    assignee = findVirtualAssignee(comments);
    isVirtual = !!assignee;
    if (!assignee) continue; // label exists but no assignee found, skip
  }

  const inactiveDays = (now - Date.parse(issue.updated_at)) / 86_400_000;
  const comments = await client.request(`/repos/${client.repository}/issues/${issue.number}/comments?per_page=100`);
  const warningDates = comments
    .map((comment) => /repository-automation:inactivity-warning issued_at=([^\s>]+)/.exec(comment.body ?? '')?.[1])
    .filter(Boolean)
    .map(Date.parse)
    .filter(Number.isFinite);
  const latestWarning = warningDates.length ? Math.max(...warningDates) : null;
  const updatedAt = Date.parse(issue.updated_at);
  const warningWindowDays = config.assignment.unassign_after_days - config.assignment.reminder_after_days;
  const warningHasNoNewActivity = latestWarning && updatedAt <= latestWarning;

  if (warningHasNoNewActivity && (now - latestWarning) / 86_400_000 >= warningWindowDays) {
    // Unassign
    if (!isVirtual) {
      await client.request(`/repos/${client.repository}/issues/${issue.number}/assignees`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assignees: [assignee] }),
      });
    }
    await client.request(`/repos/${client.repository}/issues/${issue.number}/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: `@${assignee}, this issue was unassigned after ${config.assignment.unassign_after_days} days without activity so another contributor can pick it up. Please comment if you need it reassigned.\n\n<!-- repository-automation:unassignment assignee=${assignee} unassigned_at=${new Date().toISOString()} -->` }),
    });
    if (isVirtual) {
      try {
        await client.request(`/repos/${client.repository}/issues/${issue.number}/labels/${encodeURIComponent('status: in progress')}`, { method: 'DELETE' });
      } catch (e) { console.warn(`Label removal failed: ${e.message}`); }
    }
  } else if (inactiveDays >= config.assignment.reminder_after_days && (!latestWarning || latestWarning < updatedAt)) {
    await client.request(`/repos/${client.repository}/issues/${issue.number}/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: `@${assignee}, a friendly reminder: please post a short progress update or let us know if you need to release this issue for another contributor.\n\n<!-- repository-automation:inactivity-warning issued_at=${new Date().toISOString()} -->` }),
    });
  }
}
console.log(`Reviewed ${issues.length} in-progress issues.`);
