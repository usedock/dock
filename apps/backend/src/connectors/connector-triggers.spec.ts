import { figmaTrigger, linearTrigger, sentryOrgFromUrl, sentryTrigger, slackTrigger } from './connector-triggers';

const linearIssue = (over: Record<string, unknown> = {}, from: Record<string, unknown> | undefined = undefined, action = 'update') => ({
  action,
  type: 'Issue',
  url: 'https://linear.app/acme/issue/ENG-7',
  organizationId: 'org-1',
  data: { id: 'iss-1', identifier: 'ENG-7', title: 'Crash on save', description: 'Steps...', assigneeId: null, labels: [], ...over },
  ...(from ? { updatedFrom: from } : {}),
});

describe('linearTrigger', () => {
  it('fires when the issue is assigned to the connected user', () => {
    const t = linearTrigger(linearIssue({ assigneeId: 'me' }, { assigneeId: null }), 'me');
    expect(t).toMatchObject({ kind: 'linear', key: 'issue:iss-1', title: 'ENG-7 Crash on save', body: 'Steps...', reply: { issueId: 'iss-1' } });
  });

  it('ignores edits that leave the assignee alone and assignments to someone else', () => {
    expect(linearTrigger(linearIssue({ assigneeId: 'me' }, { title: 'old' }), 'me')).toBeNull();
    expect(linearTrigger(linearIssue({ assigneeId: 'other' }, { assigneeId: null }), 'me')).toBeNull();
    expect(linearTrigger(linearIssue({ assigneeId: 'me' }, { assigneeId: null }), null)).toBeNull();
  });

  it('fires when the dock label is newly added and not when it was already there', () => {
    const labels = [{ id: 'l1', name: 'Dock' }];
    expect(linearTrigger(linearIssue({ labels }, { labelIds: [] }), 'me')).not.toBeNull();
    expect(linearTrigger(linearIssue({ labels }, { labelIds: ['l1'] }), 'me')).toBeNull();
    expect(linearTrigger(linearIssue({ labels }, { title: 'x' }), 'me')).toBeNull();
    expect(linearTrigger(linearIssue({ labels }, undefined, 'create'), 'me')).not.toBeNull();
  });

  it('ignores other entities and removals', () => {
    expect(linearTrigger({ ...linearIssue({ assigneeId: 'me' }, { assigneeId: null }), type: 'Comment' }, 'me')).toBeNull();
    expect(linearTrigger({ ...linearIssue({ assigneeId: 'me' }, { assigneeId: null }), action: 'remove' }, 'me')).toBeNull();
  });
});

describe('slackTrigger', () => {
  const mention = (event: Record<string, unknown>) => ({
    type: 'event_callback',
    team_id: 'T1',
    event_id: 'Ev1',
    event: { type: 'app_mention', channel: 'C1', ts: '171.1', text: '<@UBOT> please look at this', user: 'U1', ...event },
  });

  it('replies in the existing thread, or starts one on the mention itself', () => {
    expect(slackTrigger(mention({ thread_ts: '170.0' }))).toMatchObject({ key: 'thread:C1:170.0', body: 'please look at this', reply: { channel: 'C1', threadTs: '170.0' } });
    expect(slackTrigger(mention({}))?.reply).toEqual({ channel: 'C1', threadTs: '171.1' });
  });

  it('ignores bot messages and other events', () => {
    expect(slackTrigger(mention({ bot_id: 'B1' }))).toBeNull();
    expect(slackTrigger(mention({ type: 'message' }))).toBeNull();
    expect(slackTrigger({ type: 'url_verification' })).toBeNull();
  });
});

describe('sentryTrigger', () => {
  it('starts on issue.created', () => {
    const t = sentryTrigger('issue', {
      action: 'created',
      data: { issue: { id: '42', title: 'TypeError', culprit: 'app/main', level: 'error', web_url: 'https://sentry.io/i/42', project: { slug: 'web' } } },
    });
    expect(t).toMatchObject({ kind: 'sentry', key: 'issue:42', title: 'TypeError', url: 'https://sentry.io/i/42', reply: { issueId: '42' } });
    expect(t?.body).toContain('Project: web');
  });

  it('starts on event_alert and shares the issue key with issue.created', () => {
    const t = sentryTrigger('event_alert', {
      action: 'triggered',
      data: { event: { issue_id: '42', title: 'TypeError', web_url: 'https://sentry.io/e' }, triggered_rule: 'Prod errors' },
    });
    expect(t).toMatchObject({ key: 'issue:42', reply: { issueId: '42' } });
    expect(t?.body).toContain('Prod errors');
  });

  it('ignores other resources and actions', () => {
    expect(sentryTrigger('issue', { action: 'resolved', data: { issue: { id: '42' } } })).toBeNull();
    expect(sentryTrigger('comment', { action: 'created', data: {} })).toBeNull();
  });
});

describe('sentryOrgFromUrl', () => {
  it('reads the organization from path and subdomain URLs', () => {
    expect(sentryOrgFromUrl('https://sentry.example.com/organizations/acme/issues/42/')).toBe('acme');
    expect(sentryOrgFromUrl('https://acme.sentry.io/issues/42/')).toBe('acme');
    expect(sentryOrgFromUrl('https://acme.de.sentry.io/issues/42/')).toBe('acme');
    expect(sentryOrgFromUrl('https://de.sentry.io/issues/42/')).toBeUndefined();
    expect(sentryOrgFromUrl('nope')).toBeUndefined();
  });

  it('is carried in the issue and alert reply targets', () => {
    expect(sentryTrigger('issue', { action: 'created', data: { issue: { id: '1', web_url: 'https://acme.sentry.io/issues/1/' } } })?.reply.org).toBe('acme');
    expect(sentryTrigger('event_alert', { action: 'triggered', data: { event: { issue_id: '1', web_url: 'https://sentry.io/organizations/beta/issues/1/' } } })?.reply.org).toBe('beta');
  });
});

describe('figmaTrigger', () => {
  const comment = (over: Record<string, unknown> = {}) => ({
    event_type: 'FILE_COMMENT',
    file_key: 'FK',
    file_name: 'Checkout',
    comment_id: 555,
    comment: [{ text: 'hey ' }, { mention: '99' }, { text: ' fix the spacing' }],
    mentions: [{ id: '99', handle: 'dock' }],
    triggered_by: { id: '7', handle: 'pat' },
    ...over,
  });

  it('fires on a mention of the connected user and replies to the comment', () => {
    expect(figmaTrigger(comment(), '99')).toMatchObject({ kind: 'figma', key: 'comment:FK:555', reply: { fileKey: 'FK', commentId: '555' }, body: 'hey  fix the spacing' });
  });

  it('fires on a literal @dock and replies to the thread root', () => {
    const t = figmaTrigger(comment({ mentions: [], comment: [{ text: '@dock check this' }], parent_id: 500 }), '99');
    expect(t?.reply).toEqual({ fileKey: 'FK', commentId: '500' });
  });

  it('ignores comments that do not mention it and other events', () => {
    expect(figmaTrigger(comment({ mentions: [], comment: [{ text: 'looks good' }] }), '99')).toBeNull();
    expect(figmaTrigger(comment({ event_type: 'PING' }), '99')).toBeNull();
  });
});
