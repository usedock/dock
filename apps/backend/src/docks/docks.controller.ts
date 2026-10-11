import { AllowDockKey } from '../common/allow-dock-key.decorator';
import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { ApiHeader, ApiResponse } from '@nestjs/swagger';

const OPTIONAL_IDEMPOTENCY_KEY = { name: 'idempotency-key', required: false, description: 'Replays return the first result for the same key.' };
import type { RequestUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../common/public.decorator';
import { DockPortAccessService, type PortAuthResult } from './dock-port-access.service';
import { DockPortsService } from './dock-ports.service';
import { DockPortDto, ExposePortDto } from './dto/port.dto';
import { DockExecService } from './dock-exec.service';
import { DockTerminalService } from './dock-terminal.service';
import { DockTerminalTicketDto } from './dto/terminal.dto';
import { DocksService } from './docks.service';
import { dockView } from './dock-view';
import { DockExecResultDto, ExecDockDto } from './dto/exec-dock.dto';
import { BranchDockDto, ListDocksQuery, StopDockDto } from './dto/dock-actions.dto';
import { CreateDockDto } from './dto/create-dock.dto';
import { ResumeDockDto, UpdateDockDto } from './dto/update-dock.dto';

/** Dock lifecycle: thin validation-to-service routes with explicit statuses. */
@Controller()
export class DocksController {
  constructor(
    private readonly docks: DocksService,
    private readonly execs: DockExecService,
    private readonly terminals: DockTerminalService,
    private readonly ports: DockPortsService,
    private readonly portAccess: DockPortAccessService,
  ) {}

  @Post('docks')
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader(OPTIONAL_IDEMPOTENCY_KEY)
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateDockDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.docks.create(user.id, dto, key).then(dockView);
  }

  @Get('docks')
  list(@CurrentUser() user: RequestUser, @Query() query: ListDocksQuery) {
    return this.docks.list(user.id, query.filter, query.all).then((rows) => rows.map(dockView));
  }

  @AllowDockKey()
  @Get('docks/:id')
  getById(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.docks.getById(user.id, id).then(dockView);
  }

  @Patch('docks/:id')
  update(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: UpdateDockDto) {
    return this.docks.update(user.id, id, dto).then(dockView);
  }

  @Delete('docks/:id')
  @HttpCode(HttpStatus.ACCEPTED)
  remove(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Headers('x-confirm-delete') confirm?: string,
  ) {
    return this.docks.remove(user.id, id, confirm);
  }

  @Post('docks/:id/stop')
  @HttpCode(HttpStatus.ACCEPTED)
  stop(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: StopDockDto) {
    return this.docks.stop(user.id, id, dto);
  }

  @Post('docks/:id/resume')
  @HttpCode(HttpStatus.ACCEPTED)
  resume(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: ResumeDockDto) {
    return this.docks.resume(user.id, id, dto);
  }

  @Post('docks/:id/branch')
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader(OPTIONAL_IDEMPOTENCY_KEY)
  branch(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: BranchDockDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.docks.branch(user.id, id, dto, key).then(dockView);
  }

  /** Runs one command in a ready dock and returns its bounded output. */
  @Post('docks/:id/exec')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(OPTIONAL_IDEMPOTENCY_KEY)
  @ApiResponse({ status: HttpStatus.OK, type: DockExecResultDto })
  exec(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: ExecDockDto,
    @Headers('idempotency-key') key?: string,
  ): Promise<DockExecResultDto> {
    return this.execs.exec(user.id, id, dto, key);
  }

  /** Issues a 30s single-use ticket for the terminal WebSocket at GET /v1/docks/:id/terminal. */
  @Post('docks/:id/terminal')
  @HttpCode(HttpStatus.CREATED)
  @ApiResponse({ status: HttpStatus.CREATED, type: DockTerminalTicketDto })
  terminal(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<DockTerminalTicketDto> {
    return this.terminals.createTicket(user.id, id);
  }

  @AllowDockKey()
  @Get('docks/:id/ports')
  @ApiResponse({ status: HttpStatus.OK, type: [DockPortDto] })
  listPorts(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.ports.list(user.id, id);
  }

  /** Exposes a dock port (private by default); exposing it again returns the same URL. */
  @AllowDockKey()
  @Post('docks/:id/ports')
  @HttpCode(HttpStatus.CREATED)
  @ApiResponse({ status: HttpStatus.CREATED, type: DockPortDto })
  exposePort(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: ExposePortDto) {
    return this.ports.expose(user.id, id, dto.port, dto.visibility);
  }

  @AllowDockKey()
  @Delete('docks/:id/ports/:port')
  @HttpCode(HttpStatus.OK)
  removePort(@CurrentUser() user: RequestUser, @Param('id') id: string, @Param('port', ParseIntPipe) port: number) {
    return this.ports.remove(user.id, id, port);
  }

  /** Edge on-demand TLS check: 200 only for exposed port hostnames. */
  @Public()
  @Get('ports/tls-check')
  async portTlsCheck(@Query('domain') domain?: string) {
    if (!domain || !(await this.ports.hostnameExposed(domain))) {
      throw new NotFoundException({ code: 'port_not_found', message: 'No exposed port at this hostname' });
    }
    return { exposed: true };
  }

  /** Edge forward-auth: 200 lets the request through, 302 or 401 is relayed to the client. */
  @Public()
  @Get('ports/auth')
  async portAuth(
    @Headers('x-forwarded-host') host: string | undefined,
    @Headers('x-forwarded-uri') uri: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('accept') accept: string | undefined,
    @Res() res: Response,
  ) {
    const result = await this.portAccess.authorize({ host, uri, cookie, authorization, wantsHtml: (accept ?? '').includes('text/html') });
    return this.sendPortResult(res, result);
  }

  /** Browser landing for private ports: signed-in members are sent on to the port host. */
  @Public()
  @Get('ports/access')
  async portAccessLanding(
    @Query('host') host: string | undefined,
    @Query('next') next: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res() res: Response,
  ) {
    return this.sendPortResult(res, await this.portAccess.access(host, next, cookie));
  }

  private sendPortResult(res: Response, result: PortAuthResult): void {
    res.setHeader('Cache-Control', 'no-store');
    if (result.status === 404) throw new NotFoundException({ code: 'port_not_found', message: 'No private port at this hostname' });
    if (result.status === 401) throw new UnauthorizedException({ code: 'unauthorized', message: 'This port is private; sign in or use a dock API key' });
    if (result.status === 302) {
      if (result.setCookie) res.setHeader('Set-Cookie', result.setCookie);
      res.redirect(302, result.location);
      return;
    }
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    res.status(200).end();
  }
}
