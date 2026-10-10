import { Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import type { Response } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../common/public.decorator';
import { FleetObjectAccess } from './fleet-object-access';
import { FleetObjectsService } from './fleet-objects.service';
import { FleetService } from './fleet.service';
import { bearer, HostCommandQueue } from './host-command-queue';
import { EnrollDto, FleetHeartbeatDto, FleetRegisterDto, HostCommandResultDto, ObjectPartQueryDto, ObjectUrlDto } from './dto/fleet.dto';

/**
 * Fleet control channel for hosts. Every host connects outbound to
 * this API; nothing here is reachable by a host-specific port or address.
 * Enroll and register take the shared enrollment token; every other call is
 * authenticated by the calling host's own credential, which also fixes its hostId.
 */
@Public()
@ApiExcludeController()
@Controller('fleet')
export class FleetController {
  constructor(
    private readonly fleet: FleetService,
    private readonly queue: HostCommandQueue,
    private readonly objects: FleetObjectsService,
    private readonly access: FleetObjectAccess,
  ) {}

  /** Bootstrap: identity and one-time credential for a fresh machine; refuses a host that is already enrolled. */
  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  enroll(@Headers('authorization') auth: string | undefined, @Body() dto: EnrollDto) {
    this.queue.assertToken(bearer(auth));
    return this.fleet.enroll(dto);
  }

  /**
   * The shared token may only register a host that has no credential yet (and
   * issues it to docklets that accept one); an enrolled host re-registers with
   * its own credential.
   */
  @Post('register')
  @HttpCode(HttpStatus.OK)
  async register(@Headers('authorization') auth: string | undefined, @Body() dto: FleetRegisterDto) {
    const token = bearer(auth);
    if (this.queue.isEnrollToken(token)) return this.fleet.register(dto, true);
    this.assertSameHost(await this.queue.authenticateHost(token), dto.hostId);
    return this.fleet.register(dto, false);
  }

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  async heartbeat(@Headers('authorization') auth: string | undefined, @Body() dto: FleetHeartbeatDto) {
    const hostId = await this.queue.authenticateHost(bearer(auth), dto.hostId);
    this.assertSameHost(hostId, dto.hostId);
    return this.fleet.heartbeat({ ...dto, hostId });
  }

  /** Long poll for the next queued operation; null when the wait elapses. */
  @Get('commands')
  async commands(
    @Headers('authorization') auth: string | undefined,
    @Query('hostId') claimedHostId: string | undefined,
    @Query('wait') wait?: string,
  ) {
    const hostId = await this.queue.authenticateHost(bearer(auth), claimedHostId);
    this.assertSameHost(hostId, claimedHostId);
    const seconds = Number(wait ?? 25);
    return { command: await this.queue.poll(hostId, Number.isFinite(seconds) ? seconds : 25) };
  }

  @Post('commands/:id/result')
  @HttpCode(HttpStatus.OK)
  async result(
    @Headers('authorization') auth: string | undefined,
    @Param('id') id: string,
    @Body() dto: HostCommandResultDto,
  ) {
    const hostId = await this.queue.authenticateHost(bearer(auth), dto.hostId);
    this.assertSameHost(hostId, dto.hostId);
    return this.queue.recordResult(hostId, id, dto);
  }

  /**
   * Stores one raw part of a generation object. Bound to the request stream
   * (not a body DTO): the bytes are piped straight into the store, so a 16MiB
   * part is never buffered whole and no JSON parser touches it.
   */
  @Put('objects/:snapshotId/:name')
  @HttpCode(HttpStatus.OK)
  async putObject(
    @Headers('authorization') auth: string | undefined,
    @Param('snapshotId') snapshotId: string,
    @Param('name') name: string,
    @Query() query: ObjectPartQueryDto,
    @Req() request: IncomingMessage,
  ) {
    await this.access.assertWrite(await this.queue.authenticateHost(bearer(auth)), snapshotId);
    return this.objects.putPart(snapshotId, name, query.part, query.parts, query.size, request);
  }

  /**
   * Coordinates for one object so a host can move it straight to the store at
   * full link speed; `proxy` means the host keeps using the part routes.
   */
  @Post('objects/:snapshotId/:name/url')
  @HttpCode(HttpStatus.OK)
  async objectUrl(
    @Headers('authorization') auth: string | undefined,
    @Param('snapshotId') snapshotId: string,
    @Param('name') name: string,
    @Body() dto: ObjectUrlDto,
  ) {
    const hostId = await this.queue.authenticateHost(bearer(auth));
    await (dto.op === 'put' ? this.access.assertWrite(hostId, snapshotId) : this.access.assertRead(hostId, snapshotId));
    return this.objects.presignObject(snapshotId, name, dto.op, dto.size);
  }

  /** Streams one assembled object; the JSON envelope would corrupt the bytes. */
  @Get('objects/:snapshotId/:name')
  async getObject(
    @Headers('authorization') auth: string | undefined,
    @Param('snapshotId') snapshotId: string,
    @Param('name') name: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.access.assertRead(await this.queue.authenticateHost(bearer(auth)), snapshotId);
    const object = await this.objects.getObject(snapshotId, name);
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', object.size);
    // A host that hangs up mid-download must stop pulling from the store, and
    // a store fault must end the response instead of leaving it hanging.
    res.on('close', () => object.stream.destroy());
    object.stream.on('error', () => res.destroy());
    object.stream.pipe(res);
  }

  /** Drops every object of a generation, staging parts included. */
  @Delete('objects/:snapshotId')
  @HttpCode(HttpStatus.OK)
  async deleteGeneration(
    @Headers('authorization') auth: string | undefined,
    @Param('snapshotId') snapshotId: string,
  ) {
    await this.access.assertWrite(await this.queue.authenticateHost(bearer(auth)), snapshotId);
    return this.objects.deleteGeneration(snapshotId);
  }

  /**
   * Lists a generation. Deliberately returns the bare `{files:[...]}` rather
   * than the docklet envelope: hosts parse this one shape on both sides.
   */
  @Get('objects/:snapshotId')
  async listGeneration(
    @Headers('authorization') auth: string | undefined,
    @Param('snapshotId') snapshotId: string,
  ) {
    await this.access.assertRead(await this.queue.authenticateHost(bearer(auth)), snapshotId);
    return this.objects.listGeneration(snapshotId);
  }

  /** A client-supplied hostId is informational only; one naming another host is refused. */
  private assertSameHost(authenticated: string, claimed: string | undefined): void {
    if (claimed !== undefined && claimed !== authenticated) {
      throw new ForbiddenException({ code: 'host_mismatch', message: 'hostId does not match the host credential' });
    }
  }
}
