export class DockTerminalTicketDto {
  /** Single-use credential for `GET /v1/docks/:id/terminal?ticket=` (WebSocket upgrade). */
  ticket!: string;

  /** The ticket is refused after this instant. */
  expiresAt!: string;
}
