import { Injectable } from '@nestjs/common';
import { HostsService, hostServesImage } from '../hosts/hosts.service';
import { DOCKYARD_CATALOG } from './catalog';

export interface ImageView {
  name: string;
  description: string;
  arch: string[];
  sizeMiB: number;
  contents: string;
  available: boolean;
}

/** The Dockyard catalog with per-image availability across the online fleet. */
@Injectable()
export class ImagesService {
  constructor(private readonly hosts: HostsService) {}

  /** An image is available when some online host serves it; a host that never reported images serves only the default. */
  async list(): Promise<ImageView[]> {
    const online = await this.hosts.listOnline();
    return DOCKYARD_CATALOG.map((image) => ({ ...image, arch: [...image.arch], available: online.some((h) => hostServesImage(h, image.name)) }));
  }
}
