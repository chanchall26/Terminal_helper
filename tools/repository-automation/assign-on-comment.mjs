import { readFile } from 'node:fs/promises';
import {
  assignmentMarker,
  extractTargetAssignee,
  findVirtualAssignee,
  githubClient,
  hasAssignableLabel,
  isAssignmentRequest,
  isMaintainer,
  isUnassignmentRequest,
  unassignmentMarker,
} from './lib/common.mjs';

const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const config = JSON.parse(await readFile('.github/repository-automation/config.json', 'utf8'));
const eventIssue = event.issue;
const actor = event.comment?.user?.login;
const request = event.comment?.body ?? '';

const isAssign = isAssignmentRequest(request);
const isUnassign = isUnassignmentRequest(request);

if (!config.assignment.enabled_by_default || !eventIssue || !actor || (!isAssign && !isUnassign)) {
  console.log('Comment is not an enabled assignment or unassignment request.');
  process.exit(0);
}

const client = githubClient({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY });
const issue = await client.request(`/repos/${client.repository}/issues/${eventIssue.number}`);
const comment = async (body) => client.request(`/repos/${client.repository}/issues/${issue.number}/comments`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }),
});

if (issue.pull_request) {
  await comment('Thanks for offering to help. Assignment requests belong on the linked issue, not on a pull request.');
  process.exit(0);
}

const maintainer = isMaintainer({ comment: event.comment, repository: client.repository });
const explicitTarget = extractTargetAssignee(request);

// --- UNASSIGN ---
if (isUnassign) {
  const allComments = await client.request(`/repos/${client.repository}/issues/${issue.number}/comments?per_page=100`);
  const virtualAssignee = findVirtualAssignee(allComments);
  const nativeAssignees = (issue.assignees ?? []).map(a => a.login);
  const effectiveAssignees = [...new Set([...nativeAssignees, ...(virtualAssignee ? [virtualAssignee] : [])])];

  let targetToUnassign = explicitTarget;
  if (!targetToUnassign) {
    targetToUnassign = maintainer ? effectiveAssignees[0] : actor;
  }

  if (!maintainer && targetToUnassign?.toLowerCase() !== actor.toLowerCase()) {
    await comment('Only repository maintainers can unassign other contributors. You can unassign yourself using `/unassign`.');
    process.exit(0);
  }

  const isNativeAssigned = nativeAssignees.some(a => a.toLowerCase() === targetToUnassign?.toLowerCase());
  const isVirtualAssigned = virtualAssignee?.toLowerCase() === targetToUnassign?.toLowerCase();

  if (!targetToUnassign || (!isNativeAssigned && !isVirtualAssigned)) {
    await comment(`No active assignment found for @${targetToUnassign ?? actor} on this issue.`);
    process.exit(0);
  }

  if (isNativeAssigned) {
    try {
      await client.request(`/repos/${client.repository}/issues/${issue.number}/assignees`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assignees: [targetToUnassign] }),
      });
    } catch (e) { console.warn(`Native unassign failed: ${e.message}`); }
  }

  try {
    await client.request(`/repos/${client.repository}/issues/${issue.number}/labels/${encodeURIComponent('status: in progress')}`, { method: 'DELETE' });
  } catch (e) { console.warn(`Label removal failed: ${e.message}`); }

  await comment(`Unassigned @${targetToUnassign}. This issue is now open for other contributors.\n\n${unassignmentMarker(targetToUnassign, new Date().toISOString())}`);
  console.log(`Unassigned ${targetToUnassign} from #${issue.number}.`);
  process.exit(0);
}

// --- ASSIGN ---
let target = explicitTarget;

if (explicitTarget) {
  if (!maintainer && explicitTarget.toLowerCase() !== actor.toLowerCase()) {
    await comment('Only repository maintainers can delegate assignments to other contributors. You can assign yourself using `/assign` or `/claim`.');
    process.exit(0);
  }
} else if (maintainer) {
  const comments = await client.request(`/repos/${client.repository}/issues/${issue.number}/comments?per_page=100`);
  const candidates = (comments ?? []).filter((c) => {
    const login = c.user?.login;
    const isBot = c.user?.type === 'Bot' || login?.endsWith('[bot]');
    const isSenderOrMaintainer = login?.toLowerCase() === actor.toLowerCase() || isMaintainer({ comment: c, repository: client.repository });
    return !isBot && !isSenderOrMaintainer;
  });

  const applicant = [...candidates].reverse().find((c) => isAssignmentRequest(c.body ?? ''))
    || candidates[candidates.length - 1];

  if (applicant?.user?.login) {
    target = applicant.user.login;
    console.log(`Maintainer ${actor} assigned previous applicant ${target}.`);
  } else {
    await comment('No contributor applicant found on this issue. Use `/assign @username` to specify.');
    process.exit(0);
  }
} else {
  target = actor;
}

if (issue.state !== 'open') {
  await comment('Thanks for your interest. This issue is not open for assignment.');
  process.exit(0);
}

// Check both native and virtual assignees
const allComments = await client.request(`/repos/${client.repository}/issues/${issue.number}/comments?per_page=100`);
const virtualAssignee = findVirtualAssignee(allComments);
const nativeAssignees = (issue.assignees ?? []).map(a => a.login);
const effectiveAssignees = [...new Set([...nativeAssignees, ...(virtualAssignee ? [virtualAssignee] : [])])];

if (effectiveAssignees.length) {
  if (effectiveAssignees.some(a => a.toLowerCase() === target.toLowerCase())) {
    await comment(`@${target} is already assigned to this issue.`);
    process.exit(0);
  }
  await comment('Thanks for your interest. This issue already has an active assignee.');
  process.exit(0);
}
if (!hasAssignableLabel(issue.labels ?? [], config.assignment.assignable_labels)) {
  await comment(`A maintainer must first label this issue as one of: ${config.assignment.assignable_labels.join(', ')}.`);
  process.exit(0);
}

const query = encodeURIComponent(`repo:${client.repository} is:issue is:open assignee:${target}`);
const assigned = await client.request(`/search/issues?q=${query}&per_page=100`);
if (assigned.total_count >= config.assignment.max_open_assignments_per_contributor) {
  await comment(`@${target} already has ${config.assignment.max_open_assignments_per_contributor} open assigned issue(s). Please finish or unassign first.`);
  process.exit(0);
}

// Try native assignment. If user isn't eligible (not a collaborator), fall back to virtual assignment.
let nativeSuccess = false;
try {
  await client.request(`/repos/${client.repository}/issues/${issue.number}/assignees`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assignees: [target] }),
  });
  nativeSuccess = true;
} catch (error) {
  if (error.status === 422 || error.status === 404) {
    console.log(`Native assignment failed (${error.status}), using virtual assignment for @${target}.`);
  } else {
    throw error;
  }
}

try {
  await client.request(`/repos/${client.repository}/issues/${issue.number}/labels`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ labels: ['status: in progress'] }),
  });
} catch (e) { console.warn(`Status label failed: ${e.message}`); }

const delegationNotice = (maintainer && target.toLowerCase() !== actor.toLowerCase())
  ? ` by maintainer @${actor}`
  : '';
const markerType = nativeSuccess ? 'native' : 'virtual';
const virtualLabel = nativeSuccess ? '' : ' (virtual — contributor is not yet a repository collaborator)';
await comment(`Assigned to @${target}${delegationNotice}${virtualLabel}. Thank you! Please create a focused branch, link your pull request to #${issue.number}, include tests where practical, and do not include credentials, terminal history, or private data.\n\n${assignmentMarker(target, new Date().toISOString(), markerType)}`);
console.log(`Assigned #${issue.number} to ${target} (native=${nativeSuccess}).`);
