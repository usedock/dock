import { Controller, Get } from '@nestjs/common';
import { ImagesService } from './images.service';

/** The Dockyard image catalog; any authenticated caller may read it. */
@Controller('images')
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  @Get()
  list() {
    return this.images.list();
  }
}
