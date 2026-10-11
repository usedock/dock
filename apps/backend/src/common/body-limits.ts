import { json, raw } from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

type Handler = (req: Request, res: Response, next: NextFunction) => void;

// Nest skips its global JSON parser when a layer named `jsonParser` exists, so wrappers stay anonymous.
const anonymous = (parser: Handler): Handler => (req, res, next) => parser(req, res, next);

/**
 * Path-scoped body limits registered before Nest's parsers, which skip
 * already-parsed bodies: the LLM gateway forwards bytes untouched, run
 * completions carry file contents, exec bodies carry 64KB commands, and host
 * results carry up to 1 MiB per exec stream.
 */
export function registerBodyLimits(http: Pick<Express, 'use'>): void {
  http.use('/v1/llm', anonymous(raw({ type: () => true, limit: '32mb' })));
  http.use('/v1/connectors/gateway', anonymous(raw({ type: () => true, limit: '32mb' })));
  http.use('/v1/github/runs/:id/complete', anonymous(json({ limit: '16mb' })));
  http.use('/v1/docks/:id/exec', anonymous(json({ limit: '1mb' })));
  http.use('/v1/fleet/commands/:id/result', anonymous(json({ limit: '16mb' })));
}
