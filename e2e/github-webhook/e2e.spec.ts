import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReturnTypeOf } from '@octokit/core/dist-types/types';
import { User } from '@octokit/webhooks-types';
import { ImapFlow } from 'imapflow';
import { ParsedMail } from 'mailparser';
import { CompletedRequest } from 'mockttp';
import { TestAccount } from 'nodemailer';
import { simpleGit } from 'simple-git';

import { GitHubClient } from '../../src/infrastructure/github';
import {
  connectToEmail,
  createTestEmailAccount,
  fetchEmails,
} from './helpers/email';
import {
  deleteLocalRemoteRepos,
  Fixture,
  getBcr,
  getLatestBranch,
  PREPARED_FIXTURES_PATH,
  setupLocalRemoteBcr,
  setupLocalRemoteRulesetRepo,
} from './helpers/fixture';
import { publishReleaseEvent } from './helpers/webhook';
import { CloudFunctions } from './stubs/cloud-functions';
import { FakeGitHub } from './stubs/fake-github';
import { FakeSecrets } from './stubs/fake-secrets';

jest.setTimeout(30000);

// Speed up e2e tests by retrying failed requests with 100ms delay factor.
process.env.BACKOFF_DELAY_FACTOR = '100';

describe('e2e tests', () => {
  let cloudFunctions: CloudFunctions;
  let fakeGitHub: FakeGitHub;
  let fakeSecrets: FakeSecrets;
  let emailAccount: TestAccount;
  let emailClient: ImapFlow;
  let secrets: ReturnTypeOf<typeof mockSecrets>;
  const testOrg = 'testorg';
  const releaser: Partial<User> = {
    login: 'releaser',
    email: 'releaser@test.org',
    name: 'Releaser',
  };

  beforeAll(async () => {
    // Setup external services once before all test runs as
    // there should be no issues reusing them across tests.
    emailAccount = await createTestEmailAccount();
    emailClient = await connectToEmail(emailAccount);

    fakeSecrets = new FakeSecrets();
    await fakeSecrets.start();

    fakeGitHub = new FakeGitHub();
    await fakeGitHub.start();

    cloudFunctions = new CloudFunctions(fakeGitHub, fakeSecrets, emailAccount);
    await cloudFunctions.start();

    // Clone the real bazel-central-registry to disk
    // and treat that as the canonical 'remote' so that
    // each test doesn't have to re-clone it.
    await setupLocalRemoteBcr();
  });

  afterAll(async () => {
    await emailClient.logout();

    // Shutdown external services
    await cloudFunctions.shutdown();
    await fakeGitHub.shutdown();
    await fakeSecrets.shutdown();

    // Clean up any temoprary files we created
    deleteLocalRemoteRepos();
  });

  beforeEach(async () => {
    secrets = mockSecrets(fakeSecrets, emailAccount);
    fakeGitHub.mockBotAppInstallation('bazelbuild', 'bazel-central-registry');
  });

  afterEach(async () => {
    await fakeGitHub.reset();
    await fakeSecrets.reset();
    await cloudFunctions.reset();
  });

  test('[snapshot] ruleset with unversioned module in source', async () => {
    const repo = Fixture.Unversioned;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(
      repo,
      'unversioned-1.0.0',
      'tar.gz'
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );
    expect(response.status).toEqual(200);

    const snapshot = await rollupEntryFiles();
    expect(snapshot).toMatchSnapshot();
  });

  test('[snapshot] ruleset with zero-versioned module in source', async () => {
    const repo = Fixture.ZeroVersioned;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(
      repo,
      'zero-versioned-1.0.0',
      'tar.gz'
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );
    expect(response.status).toEqual(200);

    const snapshot = await rollupEntryFiles();
    expect(snapshot).toMatchSnapshot();
  });

  test('[snapshot] ruleset with versioned module in source', async () => {
    const repo = Fixture.Versioned;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(
      repo,
      'versioned-1.0.0',
      'tar.gz'
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );

    expect(response.status).toEqual(200);

    const snapshot = await rollupEntryFiles();
    expect(snapshot).toMatchSnapshot();
  });

  test('[snapshot] ruleset with tarball release archive', async () => {
    const repo = Fixture.Tarball;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(repo, 'tarball-1.0.0', 'tar.gz');
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );

    expect(response.status).toEqual(200);

    const snapshot = await rollupEntryFiles();
    expect(snapshot).toMatchSnapshot();
  });

  test('[snapshot] ruleset with zip release archive', async () => {
    const repo = Fixture.Zip;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(repo, 'zip-1.0.0', 'zip');
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.zip`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );

    expect(response.status).toEqual(200);

    const snapshot = await rollupEntryFiles();
    expect(snapshot).toMatchSnapshot();
  });

  test('[snapshot] ruleset with tar.xz release archive', async () => {
    const repo = Fixture.TarballXz;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(
      repo,
      'tarball-xz-1.0.0',
      'tar.xz'
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.xz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );

    expect(response.status).toEqual(200);

    const snapshot = await rollupEntryFiles();
    expect(snapshot).toMatchSnapshot();
  });

  test('[snapshot] empty strip prefix', async () => {
    const repo = Fixture.NoPrefix;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(repo, '', 'tar.gz');
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );

    expect(response.status).toEqual(200);

    const snapshot = await rollupEntryFiles();
    expect(snapshot).toMatchSnapshot();
  });

  test('[snapshot] missing strip prefix', async () => {
    const repo = Fixture.EmptyPrefix;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(repo, '', 'tar.gz');
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );

    expect(response.status).toEqual(200);

    const snapshot = await rollupEntryFiles();
    expect(snapshot).toMatchSnapshot();
  });

  test('[snapshot] multiple modules', async () => {
    const repo = Fixture.MultiModule;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(
      repo,
      'multi-module-1.0.0',
      'tar.gz'
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/releases/download/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );
    expect(response.status).toEqual(200);

    const snapshot = await rollupEntryFiles();
    expect(snapshot).toMatchSnapshot();
  });

  test('[snapshot] ruleset with attestations', async () => {
    const repo = Fixture.Attestations;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(
      repo,
      'attestations-1.0.0',
      'tar.gz'
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/releases/download/${tag}/${repo}-${tag}.tar.gz`,
      releaseArchive
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/releases/download/${tag}/MODULE.bazel.intoto.jsonl`,
      mockAttestation('MODULE.bazel.intoto.jsonl')
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/releases/download/${tag}/source.json.intoto.jsonl`,
      mockAttestation('source.json.intoto.jsonl')
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/releases/download/${tag}/${repo}-${tag}.tar.gz.intoto.jsonl`,
      mockAttestation(`${repo}-${tag}.tar.gz.intoto.jsonl`)
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );
    expect(response.status).toEqual(200);

    const snapshot = await rollupEntryFiles();
    expect(snapshot).toMatchSnapshot();
  });

  test('happy path', async () => {
    const repo = Fixture.Versioned;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const rulesetInstallationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(
      repo,
      'versioned-1.0.0',
      'tar.gz'
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      rulesetInstallationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );

    // Function exited normally
    expect(response.status).toEqual(200);

    // No error emails were sent
    const messages = await fetchEmails(emailClient);
    expect(messages.length).toEqual(0);

    // Acquires an authorized remote url to push to the BCR fork
    expect(fakeGitHub.installationTokenHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/app/installations/${rulesetInstallationId}/access_tokens`,
      })
    );

    // Pull request was created with the corrects params
    expect(fakeGitHub.createPullRequestHandler).toHaveBeenCalledTimes(1);
    const request = fakeGitHub.createPullRequestHandler.mock
      .calls[0][0] as CompletedRequest;
    expect(request.path).toEqual(
      expect.stringMatching(/bazelbuild\/bazel-central-registry/)
    );
    const body = (await request.body.getJson()) as any;
    expect(body).toEqual(
      expect.objectContaining({
        base: 'main',
        head: expect.stringMatching(
          new RegExp(`${testOrg}\\:${testOrg}\\/${repo}@${tag}-.+`)
        ),
        title: `${repo}@1.0.0`,
      })
    );

    // PR body has a link to the github release
    expect(body.body).toEqual(
      expect.stringContaining(
        `https://github.com/${testOrg}/${repo}/releases/tag/${tag}`
      )
    );

    // Pull request was updated to enable auto merge
    expect(fakeGitHub.updatePullRequestHandler).toHaveBeenCalledTimes(1);
    const updateRequest = fakeGitHub.updatePullRequestHandler.mock
      .calls[0][0] as CompletedRequest;
    expect(updateRequest.path).toEqual(
      expect.stringMatching(
        /repos\/bazelbuild\/bazel-central-registry\/pulls\/\d+/
      )
    );
    const updateBody = (await updateRequest.body.getJson()) as any;
    expect(updateBody).toEqual(
      expect.objectContaining({
        allow_auto_merge: true,
      })
    );
  });

  test('happy path with multiple modules', async () => {
    const repo = Fixture.MultiModule;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(
      repo,
      'multi-module-1.0.0',
      'tar.gz'
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/releases/download/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );

    // Function exited normally
    expect(response.status).toEqual(200);

    // No error emails were sent
    const messages = await fetchEmails(emailClient);
    expect(messages.length).toEqual(0);

    // One pull requests was created with the corrects params
    expect(fakeGitHub.createPullRequestHandler).toHaveBeenCalledTimes(1);
    const request = fakeGitHub.createPullRequestHandler.mock
      .calls[0][0] as CompletedRequest;
    expect(request.path).toEqual(
      expect.stringMatching(/bazelbuild\/bazel-central-registry/)
    );
    const body = (await request.body.getJson()) as any;
    expect(body).toEqual(
      expect.objectContaining({
        base: 'main',
        head: expect.stringMatching(
          new RegExp(`${testOrg}\\:${testOrg}\\/${repo}@${tag}-.+`)
        ),
        title: 'module@1.0.0, submodule@1.0.0',
      })
    );
  });

  test('setting a fixed releaser sets the commit author', async () => {
    const repo = Fixture.FixedReleaser;
    const tag = 'v1.0.0';
    const fixedReleaser = {
      login: 'fixedReleaser',
      email: 'fixed-releaser@test.org',
      name: 'Fixed Releaser',
    };
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockUser(fixedReleaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(
      repo,
      'fixed-releaser-1.0.0',
      'tar.gz'
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );

    expect(response.status).toEqual(200);

    const git = getBcr();
    const entryBranch = await getLatestBranch(git);
    const logs = await git.log({ maxCount: 1, from: entryBranch });

    expect(logs.latest?.author_email).toEqual(fixedReleaser.email);
    expect(logs.latest?.author_name).toEqual(fixedReleaser.name);
  });

  test("falls back to the release author's bcr fork when one doesn't exist in the ruleset's org", async () => {
    const repo = Fixture.Versioned;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      releaser.login!,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(releaser.login!, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(
      repo,
      'versioned-1.0.0',
      'tar.gz'
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );

    expect(response.status).toEqual(200);

    // Pull request points to releaser's BCR fork
    expect(fakeGitHub.createPullRequestHandler).toHaveBeenCalled();
    const request = fakeGitHub.createPullRequestHandler.mock
      .calls[0][0] as CompletedRequest;
    const body = (await request.body.getJson()) as any;
    expect(body).toEqual(
      expect.objectContaining({
        head: expect.stringMatching(
          new RegExp(`${releaser.login!}\\:${testOrg!}\\/${repo}@${tag}-.+`)
        ),
      })
    );
  });

  test('send error email when app not installed to BCR fork', async () => {
    const repo = Fixture.Versioned;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    // App not installed to fork
    // fakeGitHub.mockAppInstallation(testOrg, "bazel-central-registry");

    const releaseArchive = releaseArchivePath(
      repo,
      'versioned-1.0.0',
      'tar.gz'
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );

    // Function exited normally
    expect(response.status).toEqual(200);

    // Email was sent
    const messages = await fetchEmails(emailClient);
    expect(messages.length).toEqual(1);

    expect(messages[0].subject).toEqual(`Publish to BCR`);
  });

  test('commits are attributed to the publish-to-bcr bot user when the github-actions[bot] is the releaser', async () => {
    // https://github.com/bazel-contrib/publish-to-bcr/issues/120

    const repo = Fixture.Versioned;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, {
      login: 'committer',
      email: 'committer@test.org',
    });

    fakeGitHub.mockUser({
      login: GitHubClient.GITHUB_ACTIONS_BOT.login,
      id: GitHubClient.GITHUB_ACTIONS_BOT.id,
    });
    fakeGitHub.mockUser({ login: 'publish-to-bcr-bot[bot]', id: 123 });
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(
      repo,
      'versioned-1.0.0',
      'tar.gz'
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser: { login: 'github-actions[bot]' },
      }
    );

    expect(response.status).toEqual(200);

    const git = getBcr();
    const entryBranch = await getLatestBranch(git);
    const logs = await git.log({ maxCount: 1, from: entryBranch });

    expect(logs.latest?.author_email).toEqual(
      '123+publish-to-bcr-bot[bot]@users.noreply.github.com'
    );
    expect(logs.latest?.author_name).toEqual('publish-to-bcr-bot');
  });

  test('[snapshot] error email for incorrect strip prefix', async () => {
    const repo = Fixture.Versioned;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const rulesetInstallationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    // Strip prefix in release archive doesn't match source.template.json
    const releaseArchive = releaseArchivePath(repo, 'invalid-prefix', 'tar.gz');
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      rulesetInstallationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );

    expect(response.status).toEqual(200);

    const messages = await fetchEmails(emailClient);
    expect(messages.length).toEqual(1);

    expect(emailSnapshot(messages[0])).toMatchSnapshot();
  });

  test('[snapshot] error email for incorrect strip prefix in multi module repo', async () => {
    const repo = Fixture.MultiModule;
    const tag = 'v1.0.0';
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const rulesetInstallationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    // Strip prefix in release archive doesn't match source.template.json
    const releaseArchive = releaseArchivePath(repo, 'invalid-prefix', 'tar.gz');
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      rulesetInstallationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );

    expect(response.status).toEqual(200);

    const messages = await fetchEmails(emailClient);
    expect(messages.length).toEqual(1);

    expect(emailSnapshot(messages[0])).toMatchSnapshot();
  });

  test('[snapshot] ruleset with maintainer github id missing', async () => {
    const repo = Fixture.NoGitHubId;
    const tag = 'v1.0.0';
    const maintainer: Partial<User> = {
      name: 'Foo McBar',
      email: 'foo@test.org',
      login: 'foobar',
      id: 5678,
    };
    await setupLocalRemoteRulesetRepo(repo, tag, releaser);

    fakeGitHub.mockUser(releaser);
    fakeGitHub.mockUser(maintainer);
    fakeGitHub.mockRepository(testOrg, repo);
    fakeGitHub.mockRepository(
      testOrg,
      'bazel-central-registry',
      'bazelbuild',
      'bazel-central-registry'
    );
    const installationId = fakeGitHub.mockAppInstallation(testOrg, repo);
    fakeGitHub.mockAppInstallation(testOrg, 'bazel-central-registry');

    const releaseArchive = releaseArchivePath(
      repo,
      'no-github-id-1.0.0',
      'tar.gz'
    );
    await fakeGitHub.mockReleaseArtifact(
      `/${testOrg}/${repo}/archive/refs/tags/${tag}.tar.gz`,
      releaseArchive
    );

    const response = await publishReleaseEvent(
      cloudFunctions.getBaseUrl(),
      secrets.webhookSecret,
      installationId,
      {
        owner: testOrg,
        repo,
        tag,
        releaser,
      }
    );
    expect(response.status).toEqual(200);

    const snapshot = await rollupEntryFiles();
    expect(snapshot).toMatchSnapshot();
  });
});

/**
 * Rollup the entry files in the latest branch pushed to the BCR fork
 * so that they can be easily diffed within a snapshot test.
 */
async function rollupEntryFiles(): Promise<string> {
  const git = simpleGit(
    path.join(PREPARED_FIXTURES_PATH, 'bazel-central-registry')
  );
  const branches = await git.branch(['--sort=-committerdate']);
  const entryBranch = branches.all[0];
  const diff = (await git.diff(['--name-only', entryBranch, 'HEAD'])).trim();

  const changedFiles = diff.split(os.EOL);

  let content = '';

  for (const filepath of changedFiles) {
    const fileContent = await git.show([`${entryBranch}:${filepath}`]);
    content += `\
----------------------------------------------------
${filepath}
----------------------------------------------------
${fileContent}
`;
  }

  return content;
}

function emailSnapshot(email: ParsedMail): string {
  return `\
TO: ${(Array.isArray(email.to) ? email.to : [email.to]).map((to) => to?.text)}
SUBJECT: ${email.subject}

${email.text}
`;
}

export function mockSecrets(
  fakeSecrets: FakeSecrets,
  emailAccount: TestAccount
) {
  const webhookSecret = randomBytes(4).toString('hex');
  const appPrivateKey = FakeSecrets.generateRsaPrivateKey();
  const appClientId = randomBytes(8).toString('hex');
  const appClientSecret = randomBytes(10).toString('hex');
  const botAppPrivateKey = FakeSecrets.generateRsaPrivateKey();
  const botAppClientId = randomBytes(8).toString('hex');
  const botAppClientSecret = randomBytes(10).toString('hex');

  fakeSecrets.mockSecret('github-app-webhook-secret', webhookSecret);
  fakeSecrets.mockSecret('github-app-private-key', appPrivateKey);
  fakeSecrets.mockSecret('github-app-client-id', appClientId);
  fakeSecrets.mockSecret('github-app-client-secret', appClientSecret);
  fakeSecrets.mockSecret('github-bot-app-private-key', botAppPrivateKey);
  fakeSecrets.mockSecret('github-bot-app-client-id', botAppClientId);
  fakeSecrets.mockSecret('github-bot-app-client-secret', botAppClientSecret);

  fakeSecrets.mockSecret('notifications-email-user', emailAccount.user);
  fakeSecrets.mockSecret('notifications-email-password', emailAccount.pass);

  return {
    webhookSecret,
    appPrivateKey,
    appClientId,
    appClientSecret,
    botAppPrivateKey,
    botAppClientId,
    botAppClientSecret,
  };
}

function releaseArchivePath(
  fixture: Fixture,
  stripPrefix: string,
  ext: 'tar.gz' | 'tar.xz' | 'zip'
) {
  return path.join('e2e', 'fixtures', `${fixture}-${stripPrefix}.${ext}`);
}

function mockAttestation(name: string): string {
  const tempDir = fs.mkdtempSync(
    path.join(process.env.TEST_TMPDIR, 'artifact-')
  );
  fs.mkdirSync(tempDir, { recursive: true });
  const filepath = path.join(tempDir, name);
  fs.writeFileSync(filepath, `{"foobar": "${name}"}`, 'utf8');
  return filepath;
}
