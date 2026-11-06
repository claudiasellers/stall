import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify } from '../shared/signing.ts';
import { consensus } from '../app/src/service.ts';
import { hashPassword, verifyPassword } from '../app/src/auth.ts';

test('webhook signatures verify and reject tampering/replay', () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign('s3cret', ts, '{"a":1}');
  assert.ok(verify('s3cret', ts, '{"a":1}', sig));
  assert.ok(!verify('s3cret', ts, '{"a":2}', sig));
  assert.ok(!verify('other', ts, '{"a":1}', sig));
  assert.ok(!verify('s3cret', ts, '{"a":1}', undefined));
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  assert.ok(!verify('s3cret', old, '{"a":1}', sign('s3cret', old, '{"a":1}')));
});

test('consensus needs enough upvotes and a high enough yes share', () => {
  const cfg = { voteMinUpvotes: 3, consensusRatio: 0.7, rejectMinDownvotes: 3 };
  assert.equal(consensus({ upvotes: 2, downvotes: 0 }, cfg), 'pending');
  assert.equal(consensus({ upvotes: 3, downvotes: 0 }, cfg), 'approve');
  assert.equal(consensus({ upvotes: 3, downvotes: 2 }, cfg), 'pending'); // 60% < 70%
  assert.equal(consensus({ upvotes: 7, downvotes: 3 }, cfg), 'approve'); // 70%
  assert.equal(consensus({ upvotes: 1, downvotes: 3 }, cfg), 'reject');
  assert.equal(consensus({ upvotes: 3, downvotes: 3 }, cfg), 'pending'); // tie is not a rejection
  assert.equal(consensus({ upvotes: 0, downvotes: 0 }, { ...cfg, voteMinUpvotes: 0 }), 'approve'); // voting off
  assert.equal(consensus({ upvotes: 0, downvotes: 9 }, { ...cfg, rejectMinDownvotes: 0 }), 'pending'); // auto-reject off
});

test('password hashing round-trips', async () => {
  const h = await hashPassword('correct horse');
  assert.ok(await verifyPassword('correct horse', h));
  assert.ok(!(await verifyPassword('wrong horse', h)));
});
