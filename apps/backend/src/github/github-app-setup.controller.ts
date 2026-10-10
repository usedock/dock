import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { ConvertAppManifestDto, StartAppManifestDto } from './dto/github.dto';
import { GithubAppSetupService } from './github-app-setup.service';

/** Instance-admin GitHub App registration via the App Manifest flow. */
@Controller('github/app-setup')
export class GithubAppSetupController {
  constructor(private readonly setup: GithubAppSetupService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  start(@CurrentUser() user: RequestUser, @Body() dto: StartAppManifestDto) {
    return this.setup.start(user, dto.organization);
  }

  @Post('conversion')
  @HttpCode(HttpStatus.OK)
  convert(@CurrentUser() user: RequestUser, @Body() dto: ConvertAppManifestDto) {
    return this.setup.convert(user, dto.code, dto.state);
  }
}
