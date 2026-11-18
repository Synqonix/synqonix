import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Socket.IO adapter that only accepts browsers from the configured web origin. With Redis, events
 * and room changes reach sockets connected to every API instance.
 */
export class SocketIoAdapter extends IoAdapter {
  private clients: Redis[] = [];

  constructor(app: INestApplicationContext, private readonly origin: string, private readonly redis?: { url: string; prefix: string }) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, { ...options, cors: { origin: [this.origin], credentials: true } } as ServerOptions);
    if (this.redis) {
      const pub = new Redis(this.redis.url);
      const sub = pub.duplicate();
      this.clients.push(pub, sub);
      server.adapter(createAdapter(pub, sub, { key: `${this.redis.prefix}socket.io` }));
    }
    return server;
  }

  override async close(server: Server) {
    // Let the Redis adapter unsubscribe before its connections go, or the pending unsubscribe fails.
    if (this.clients.length) await Promise.resolve(server.of('/').adapter.close()).catch(() => undefined);
    await super.close(server);
    await Promise.all(this.clients.map((c) => c.quit().catch(() => undefined)));
    this.clients = [];
  }
}
