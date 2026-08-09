import { Router, type Request, type Response } from 'express';
import { serializeOpenApiDocument } from '../openapi/document.js';

/**
 * M3 P4B Basic OpenAPI serving routes (spec §40):
 *
 *   GET /api/openapi.json   application/json
 *   GET /api/openapi.yaml   application/yaml
 *
 * Both endpoints serve the same deterministic serialization of the single
 * authoritative in-memory document; JSON is valid YAML 1.2, so the two
 * endpoints can never diverge. Zero new dependencies, no runtime file
 * reads, no Swagger UI.
 */
export function createOpenApiRoutes(): Router {
  const router = Router();
  const body = serializeOpenApiDocument();

  router.get('/openapi.json', (_req: Request, res: Response) => {
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(body);
  });

  router.get('/openapi.yaml', (_req: Request, res: Response) => {
    res.status(200);
    res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
    res.send(body);
  });

  return router;
}
