import { Inject, Injectable } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { HandlerFunction } from '@octokit/webhooks/dist-types/types';
import { ReleasePublishedEvent } from '@octokit/webhooks-types';

import { CreateEntryService } from '../domain/create-entry.js';
import { FindRegistryForkService } from '../domain/find-registry-fork.js';
import { Maintainer, MetadataFile } from '../domain/metadata-file.js';
import { PublishEntryService } from '../domain/publish-entry.js';
import { Repository } from '../domain/repository.js';
import {
  RulesetRepoError,
  RulesetRepository,
} from '../domain/ruleset-repository.js';
import { User, UserService } from '../domain/user.js';
import { GitHubClient } from '../infrastructure/github.js';
import { NotificationsService } from './notifications.js';

interface PublishAttempt {
  readonly successful: boolean;
  readonly bcrFork: Repository;
  readonly error?: Error;
}

@Injectable()
export class ReleaseEventHandler {
  constructor(
    @Inject('appOctokit') private appOctokit: Octokit,
    private readonly userService: UserService,
    private readonly findRegistryForkService: FindRegistryForkService,
    private readonly createEntryService: CreateEntryService,
    private readonly publishEntryService: PublishEntryService,
    private readonly notificationsService: NotificationsService
  ) {}

  public readonly handle: HandlerFunction<'release.published', unknown> =
    async (event) => {
      const repository = repositoryFromPayload(event.payload);
      const bcr = Repository.fromCanonicalName(
        process.env.BAZEL_CENTRAL_REGISTRY
      );

      let releaser = await this.userService.getUser(event.payload.sender.login);
      const releaseUrl = event.payload.release.html_url;

      const tag = event.payload.release.tag_name;

      const createRepoResult = await this.validateRulesetRepoOrNotifyFailure(
        repository,
        tag,
        releaser
      );
      if (!createRepoResult.successful) {
        return;
      }

      const rulesetRepo = createRepoResult.rulesetRepo!;
      console.error(
        `Release published: ${rulesetRepo.canonicalName}@${tag} by @${releaser.username}`
      );

      console.error(`Release author: ${releaser.username}`);
      releaser = await this.overrideReleaser(releaser, rulesetRepo);

      const moduleNames = [];
      let branch: string;
      const candidateBcrForks: Repository[] = [];
      try {
        await Promise.all([
          bcr.shallowCloneAndCheckout('main'),
          rulesetRepo.shallowCloneAndCheckout(tag),
        ]);

        for (const moduleRoot of rulesetRepo.config.moduleRoots) {
          console.error(`Creating BCR entry for module root '${moduleRoot}'`);

          const sourceTemplate = rulesetRepo.sourceTemplate(moduleRoot);
          const attestationsTemplate =
            rulesetRepo.attestationsTemplate(moduleRoot);
          const version = RulesetRepository.getVersionFromTag(tag);
          sourceTemplate.substitute({
            TAG: tag,
          });
          if (attestationsTemplate) {
            attestationsTemplate.substitute({
              TAG: tag,
            });
          }

          const { moduleName } = await this.createEntryService.createEntryFiles(
            rulesetRepo.metadataTemplate(moduleRoot),
            sourceTemplate,
            rulesetRepo.presubmitPath(moduleRoot),
            rulesetRepo.patchesPath(moduleRoot),
            bcr.diskPath,
            version,
            attestationsTemplate
          );
          moduleNames.push(moduleName);
        }

        branch = await this.publishEntryService.commitEntryToNewBranch(
          rulesetRepo,
          bcr,
          tag,
          releaser
        );

        candidateBcrForks.push(
          ...(await this.findRegistryForkService.findCandidateForks(
            rulesetRepo,
            releaser
          ))
        );

        console.error(
          `Found ${candidateBcrForks.length} candidate forks: ${JSON.stringify(
            candidateBcrForks.map((fork) => fork.canonicalName)
          )}.`
        );
      } catch (error) {
        console.error(error);
        await this.notificationsService.notifyError(
          releaser,
          rulesetRepo.getAllMaintainers(),
          rulesetRepo,
          tag,
          [error]
        );
        return;
      }

      const attempts: PublishAttempt[] = [];

      for (const bcrFork of candidateBcrForks) {
        const bcrForkGitHubClient = await GitHubClient.forRepoInstallation(
          this.appOctokit,
          bcrFork.owner,
          bcrFork.name
        );

        const attempt = await this.attemptPublish(
          bcrFork,
          bcr,
          tag,
          branch,
          moduleNames,
          releaseUrl,
          bcrForkGitHubClient
        );
        attempts.push(attempt);

        // No need to try other candidate bcr forks if this was successful
        if (attempt.successful) {
          break;
        }
      }

      // Send out error notifications if none of the attempts succeeded
      if (!attempts.some((a) => a.successful)) {
        await this.notificationsService.notifyError(
          releaser,
          rulesetRepo.getAllMaintainers(),
          rulesetRepo,
          tag,
          attempts.map((a) => a.error!)
        );
      }
    };

  private async validateRulesetRepoOrNotifyFailure(
    repository: Repository,
    tag: string,
    releaser: User
  ): Promise<{ rulesetRepo?: RulesetRepository; successful: boolean }> {
    try {
      const rulesetRepo = await RulesetRepository.create(
        repository.name,
        repository.owner,
        tag
      );

      return {
        rulesetRepo,
        successful: true,
      };
    } catch (error) {
      // If the ruleset repo was invalid, then we didn't get the chance to set the fixed releaser.
      // See see if we can scrounge a fixedReleaser from the configuration to send that user an email.
      if (
        error instanceof RulesetRepoError &&
        !!error.repository.config.fixedReleaser
      ) {
        releaser = {
          username: error.repository.config.fixedReleaser.login,
          email: error.repository.config.fixedReleaser.email,
        };
      }

      // Similarly, if there were validation issues with the ruleset repo, we may not have been able
      // to properly parse the maintainers. Do a last-ditch attempt to try to find maintainers so that
      // we can notify them.
      let maintainers: Maintainer[] = [];
      if (error instanceof RulesetRepoError && !!error.moduleRoot) {
        maintainers = MetadataFile.emergencyParseMaintainers(
          error.repository.metadataTemplatePath(error.moduleRoot)
        );
      }

      await this.notificationsService.notifyError(
        releaser,
        maintainers,
        repository,
        tag,
        [error]
      );

      return {
        rulesetRepo: error.repository,
        successful: false,
      };
    }
  }

  private async attemptPublish(
    bcrFork: Repository,
    bcr: Repository,
    tag: string,
    branch: string,
    moduleNames: string[],
    releaseUrl: string,
    bcrForkGitHubClient: GitHubClient
  ): Promise<PublishAttempt> {
    console.error(`Attempting publish to fork ${bcrFork.canonicalName}.`);

    try {
      await this.publishEntryService.pushEntryToFork(
        bcrFork,
        bcr,
        branch,
        bcrForkGitHubClient
      );

      if (moduleNames.length === 1) {
        console.error(
          `Pushed bcr entry for module '${moduleNames[0]}' to fork ${bcrFork.canonicalName} on branch ${branch}`
        );
      } else {
        console.error(
          `Pushed bcr entry for modules '${moduleNames.join(', ')}' to fork ${
            bcrFork.canonicalName
          } on branch ${branch}`
        );
      }

      await this.publishEntryService.publish(
        tag,
        bcrFork,
        bcr,
        branch,
        moduleNames,
        releaseUrl
      );

      console.error(`Created pull request against ${bcr.canonicalName}`);
    } catch (error) {
      console.error(
        `Failed to create pull request using fork ${bcrFork.canonicalName}`
      );

      console.error(error);

      return {
        successful: false,
        bcrFork,
        error,
      };
    }

    return {
      successful: true,
      bcrFork,
    };
  }

  private async overrideReleaser(
    releaser: User,
    rulesetRepo: RulesetRepository
  ): Promise<User> {
    // Use the release author unless a fixedReleaser is configured
    if (rulesetRepo.config.fixedReleaser) {
      console.error(
        `Overriding releaser to ${rulesetRepo.config.fixedReleaser.login}`
      );

      // Fetch the releaser to get their name
      const fixedReleaser = await this.userService.getUser(
        rulesetRepo.config.fixedReleaser.login
      );

      return {
        username: rulesetRepo.config.fixedReleaser.login,
        name: fixedReleaser.name,
        email: rulesetRepo.config.fixedReleaser.email,
      };
    }

    return releaser;
  }
}

function repositoryFromPayload(payload: ReleasePublishedEvent): Repository {
  return new Repository(
    payload.repository.name,
    payload.repository.owner.login
  );
}
