import { Module } from '@nestjs/common';
import { HostsModule } from '../hosts/hosts.module';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';

/** Dockyard image catalog. */
@Module({
  imports: [HostsModule],
  controllers: [ImagesController],
  providers: [ImagesService],
})
export class ImagesModule {}
