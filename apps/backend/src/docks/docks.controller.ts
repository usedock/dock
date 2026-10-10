import { AllowDockKey } from '../common/allow-dock-key.decorator';
import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, NotFoundException, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiResponse } from '@nestjs/swagger';

const OPTIONAL_IDEMPOTENCY_KEY = { name: 'idempotency-key', required: false, description: 'Replays return the first result for the same key.' };
import type { RequestUser } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../common/public.decorator';
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

  /** Exposes a dock port at a public URL; exposing it again returns the same URL. */
  @AllowDockKey()
  @Post('docks/:id/ports')
  @HttpCode(HttpStatus.CREATED)
  @ApiResponse({ status: HttpStatus.CREATED, type: DockPortDto })
  exposePort(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: ExposePortDto) {
    return this.ports.expose(user.id, id, dto.port);
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
}
