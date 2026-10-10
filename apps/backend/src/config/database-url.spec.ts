import { resolveDatabaseUrl } from './database-url';

describe('resolveDatabaseUrl', () => {
  const primary = 'postgres://user:pass@localhost:5432/db';
  const testUrl = 'postgres://user:pass@localhost:5432/db_test';

  it.each([undefined, 'development', 'production'])(
    'uses the primary URL when NODE_ENV is %p',
    (nodeEnv) => {
      expect(resolveDatabaseUrl({ nodeEnv, databaseUrl: primary, testDatabaseUrl: testUrl })).toBe(
        primary,
      );
    },
  );

  it('uses the test URL when NODE_ENV is test', () => {
    expect(
      resolveDatabaseUrl({ nodeEnv: 'test', databaseUrl: primary, testDatabaseUrl: testUrl }),
    ).toBe(testUrl);
  });

  it.each([undefined, ''])('throws naming TEST_DATABASE_URL when test URL is %p', (testDatabaseUrl) => {
    expect(() =>
      resolveDatabaseUrl({ nodeEnv: 'test', databaseUrl: primary, testDatabaseUrl }),
    ).toThrow(/TEST_DATABASE_URL/);
  });
});
