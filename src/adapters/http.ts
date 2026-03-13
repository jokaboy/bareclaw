import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import type { Config } from '../config.js';
import type { ProcessManager } from '../core/process-manager.js';
import type { ChannelContext, PushMedia, SendMessageRequest } from '../core/types.js';
import type { PushRegistry } from '../core/push-registry.js';
import type { StartupHealthSnapshot } from '../startup-coordinator.js';

export function createHttpAdapter(
  config: Config,
  processManager: ProcessManager,
  restart: () => void | Promise<void>,
  pushRegistry: PushRegistry,
  getHealth: () => StartupHealthSnapshot
): Router {
  const router = express.Router();

  // Bearer token auth middleware — applied to all endpoints except /healthz.
  // When httpToken is not configured, privileged endpoints are rejected
  // to prevent unauthenticated access to Claude sessions and daemon control.
  router.use((req: Request, res: Response, next: NextFunction) => {
    // /healthz is always public so monitoring tools can check liveness
    if (req.path === '/healthz' && req.method === 'GET') {
      next();
      return;
    }

    if (!config.httpToken) {
      res.status(401).json({ error: 'HTTP auth not configured — set BARECLAW_HTTP_TOKEN' });
      return;
    }

    const header = req.headers.authorization;
    if (header !== `Bearer ${config.httpToken}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  router.post('/message', async (req, res) => {
    const { text, channel, content } = req.body as SendMessageRequest & { content?: unknown };

    // Accept either "text" (string) or "content" (ContentBlock[]) for multimodal
    const messageContent = content && Array.isArray(content) ? content : text;

    if (!messageContent || (typeof messageContent === 'string' && !messageContent.trim())) {
      res.status(400).json({ error: 'Missing "text" or "content" field' });
      return;
    }

    const ch = channel || 'http';
    const context: ChannelContext = { channel: ch, adapter: 'http' };
    const label = typeof messageContent === 'string'
      ? messageContent.substring(0, 80) + (messageContent.length > 80 ? '...' : '')
      : `[${(messageContent as unknown[]).length} content blocks]`;
    console.log(`[http] ← ${ch}: ${label}`);

    try {
      const response = await processManager.send(ch, messageContent, context);
      console.log(`[http] → ${ch}: ${response.duration_ms}ms`);
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[http] error on channel ${ch}: ${message}`);
      res.status(500).json({ error: message });
    }
  });

  router.post('/send', async (req, res) => {
    const { channel, text, media } = req.body as { channel?: string; text?: string; media?: PushMedia };

    if (!channel || typeof channel !== 'string') {
      res.status(400).json({ error: 'Missing "channel" field' });
      return;
    }
    if (media && (!media.filePath || typeof media.filePath !== 'string')) {
      res.status(400).json({ error: 'media.filePath must be a string' });
      return;
    }
    if (!text && !media) {
      res.status(400).json({ error: 'Missing "text" or "media" field' });
      return;
    }

    const label = text ? text.substring(0, 80) + (text.length > 80 ? '...' : '') : `[media: ${media!.filePath}]`;
    console.log(`[http] /send -> ${channel}: ${label}`);

    try {
      const sent = await pushRegistry.send(channel, text || '', media);
      if (sent) {
        res.json({ status: 'sent', channel });
      } else {
        res.status(404).json({
          error: `No push handler for channel: ${channel}`,
          registered_prefixes: pushRegistry.prefixes,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[http] /send error: ${message}`);
      res.status(500).json({ error: message });
    }
  });

  router.get('/healthz', (_req, res) => {
    res.json(getHealth());
  });

  router.post('/restart', (_req, res) => {
    console.log('[http] restart requested');
    res.json({ status: 'restarting' });
    // Delay to let the response flush
    setTimeout(() => {
      void restart();
    }, 100);
  });

  return router;
}
