import { hasDockMention, isAppSender, isIssueTarget, parseBaseBranch, parseExecutionTarget, parseRunCapabilities } from './mention';

describe('hasDockMention', () => {
  it.each(['@dock fix this', '@DOCK please', 'hey @dock-2, look'])('matches %s case-insensitively', (body) => {
    expect(hasDockMention(body)).toBe(true);
  });

  it('ignores mentions inside fenced and inline code', () => {
    expect(hasDockMention('```\n@dock fix\n```')).toBe(false);
    expect(hasDockMention('run `@dock fix` locally')).toBe(false);
    expect(hasDockMention('real text @dock fix\n```\n@dock noise\n```')).toBe(true);
  });

  it('does not match word prefixes', () => {
    expect(hasDockMention('@docker rebuild')).toBe(false);
  });
});

describe('parseBaseBranch', () => {
  it('reads an explicit base override and defaults to null', () => {
    expect(parseBaseBranch('@dock fix this base: release/2.x')).toBe('release/2.x');
    expect(parseBaseBranch('@dock fix this')).toBeNull();
    expect(parseBaseBranch('```\n@dock base: evil\n```')).toBeNull();
  });
});

describe('parseExecutionTarget', () => {
  it('reads explicit fast and target forms while preserving the default when omitted', () => {
    expect(parseExecutionTarget('@dock fast fix this')).toBe('fast');
    expect(parseExecutionTarget('@dock fix this target:fast')).toBe('fast');
    expect(parseExecutionTarget('@dock fix this')).toBeNull();
  });

  it('returns invalid explicit targets for service validation and ignores code samples', () => {
    expect(parseExecutionTarget('@dock mode:turbo')).toBe('turbo');
    expect(parseExecutionTarget('```\n@dock fast\n```')).toBeNull();
  });
});
describe('parseRunCapabilities', () => {
  it('reads capability hints from the mention line only', () => {
    expect(parseRunCapabilities('@dock fast needs ssh')).toEqual({ sshTakeover: true });
    expect(parseRunCapabilities('@dock fast needs persistent state')).toEqual({ persistentState: true });
    expect(parseRunCapabilities('@dock fast needs docker')).toEqual({ docker: true });
    expect(parseRunCapabilities('@dock fix this')).toEqual({});
  });

  it('ignores capability words outside the mention line and inside code', () => {
    expect(parseRunCapabilities('@dock fix this\nssh takeover please')).toEqual({});
    expect(parseRunCapabilities('```\n@dock fast needs ssh\n```')).toEqual({});
  });
});

describe('isIssueTarget', () => {
  it('accepts issues and rejects PR conversation comments', () => {
    expect(isIssueTarget({ issue: { number: 1 } })).toBe(true);
    expect(isIssueTarget({ issue: { pull_request: { url: 'x' } } })).toBe(false);
    expect(isIssueTarget({ issue: { number: 1 }, pull_request: { id: 2 } })).toBe(false);
    expect(isIssueTarget({})).toBe(false);
  });
});

describe('isAppSender', () => {
  it('matches only the app bot login', () => {
    expect(isAppSender('dock[bot]', 'dock')).toBe(true);
    expect(isAppSender('dock', 'dock')).toBe(false);
    expect(isAppSender(undefined, 'dock')).toBe(false);
  });
});
