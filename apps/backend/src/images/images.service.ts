import { Injectable } from '@nestjs/common';
import { DEFAULT_IMAGE } from '../database/schema/docks';
import { HostsService } from '../hosts/hosts.service';
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

  /** Hosts do not report images yet, so only the default image counts as served, and only while a host is online. */
  async list(): Promise<ImageView[]> {
    const anyOnline = (await this.hosts.listOnline()).length > 0;
    return DOCKYARD_CATALOG.map((image) => ({ ...image, arch: [...image.arch], available: anyOnline && image.name === DEFAULT_IMAGE }));
  }
}
