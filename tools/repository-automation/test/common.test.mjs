import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIssueBody,
  extractTargetAssignee,
  fingerprint,
  hasAssignableLabel,
  hasDuplicateSearchResult,
  isAssignmentRequest,
  isMaintainer,
  isUnassignmentRequest,
  redact,
} from '../lib/common.mjs';

test('redacts common token formats', () => {
  assert.match(redact('token=abc123 github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234'), /\[REDACTED\]/);
  assert.doesNotMatch(redact('token=abc123'), /abc123/);
});

test('assignment request recognition accepts explicit safe requests', () => {
  assert.equal(isAssignmentRequest('/assign'), true);
  assert.equal(isAssignmentRequest('/claim'), true);
  assert.equal(isAssignmentRequest('/assign @chanchall26'), true);
  assert.equal(isAssignmentRequest('/claim @chanchall26'), true);
  assert.equal(isAssignmentRequest('I would like to work on this'), true);
  assert.equal(isAssignmentRequest('can i work on this'), true);
  assert.equal(isAssignmentRequest('please assign this to me'), true);
  assert.equal(isAssignmentRequest('Nice work!'), false);
});

test('unassignment request recognition accepts unassign commands and phrases', () => {
  assert.equal(isUnassignmentRequest('/unassign'), true);
  assert.equal(isUnassignmentRequest('/unclaim'), true);
  assert.equal(isUnassignmentRequest('/unassign @chanchall26'), true);
  assert.equal(isUnassignmentRequest('please unassign me'), true);
  assert.equal(isUnassignmentRequest('Keep up the good work'), false);
});

test('extractTargetAssignee extracts usernames and ignores self keywords', () => {
  assert.equal(extractTargetAssignee('/assign @chanchall26'), 'chanchall26');
  assert.equal(extractTargetAssignee('/assign chanchall26'), 'chanchall26');
  assert.equal(extractTargetAssignee('/claim @alice-dev'), 'alice-dev');
  assert.equal(extractTargetAssignee('/unassign @bob'), 'bob');
  assert.equal(extractTargetAssignee('/assign'), null);
  assert.equal(extractTargetAssignee('/assign me'), null);
  assert.equal(extractTargetAssignee('/unassign'), null);
  assert.equal(extractTargetAssignee('random text'), null);
});

test('isMaintainer identifies owners, members, and collaborators accurately', () => {
  assert.equal(isMaintainer({ comment: { author_association: 'OWNER' }, repository: 'gagansokhal-coder/Terminal_helper' }), true);
  assert.equal(isMaintainer({ comment: { author_association: 'COLLABORATOR' }, repository: 'gagansokhal-coder/Terminal_helper' }), true);
  assert.equal(isMaintainer({ comment: { author_association: 'MEMBER' }, repository: 'gagansokhal-coder/Terminal_helper' }), true);
  assert.equal(isMaintainer({ comment: { user: { login: 'gagansokhal-coder' } }, repository: 'gagansokhal-coder/Terminal_helper' }), true);
  assert.equal(isMaintainer({ comment: { author_association: 'NONE', user: { login: 'random-user' } }, repository: 'gagansokhal-coder/Terminal_helper' }), false);
});

test('eligible labels are detected without contributor-history discrimination', () => {
  assert.equal(hasAssignableLabel([{ name: 'NSOC' }], ['NSOC']), true);
  assert.equal(hasAssignableLabel([{ name: 'bug' }], ['NSOC']), false);
});

test('generated issue bodies keep a stable duplicate marker', () => {
  const id = fingerprint('verified failure');
  const body = buildIssueBody({ fingerprint: id, name: 'Tests', command: ['cargo', 'test'], exitCode: 1, output: 'failed' });
  assert.match(body, new RegExp(`fingerprint=${id}`));
  assert.match(body, /Acceptance criteria/);
});

test('duplicate detection requires a matching issue or pull request', () => {
  assert.equal(hasDuplicateSearchResult({ total_count: 0 }), false);
  assert.equal(hasDuplicateSearchResult({ total_count: 1 }), true);
  assert.equal(hasDuplicateSearchResult({ total_count: '2' }), true);
  assert.equal(hasDuplicateSearchResult({}), false);
});
