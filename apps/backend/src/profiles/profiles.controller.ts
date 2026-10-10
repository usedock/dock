import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequestUser } from '../auth/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfilesService } from './profiles.service';

@Controller('me/profile')
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get()
  getMine(@CurrentUser() user: RequestUser) {
    return this.profiles.getByUserId(user.id);
  }

  @Patch()
  updateMine(@CurrentUser() user: RequestUser, @Body() dto: UpdateProfileDto) {
    return this.profiles.update(user.id, dto);
  }
}
