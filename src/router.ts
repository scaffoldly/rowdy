import { ConnectRouter, createConnectRouter, ServiceImpl } from '@connectrpc/connect';
import { compressionBrotli, compressionGzip } from '@connectrpc/connect-node';
import {
  UniversalHandler,
  UniversalHandlerOptions,
  UniversalServerRequest,
  UniversalServerResponse,
  uResponseNotFound,
} from '@connectrpc/connect/protocol';
import { DescService } from '@bufbuild/protobuf';

export type Request = UniversalServerRequest;
export type Response = UniversalServerResponse;

export class Router {
  private _router: ConnectRouter;
  private _paths?: Map<string, UniversalHandler>;

  constructor(public readonly signal: AbortSignal) {
    this._router = createConnectRouter({
      acceptCompression: [compressionGzip, compressionBrotli],
      grpc: true,
      grpcWeb: true,
      connect: true,
      shutdownSignal: signal,
    });
  }

  withService<T extends DescService>(
    service: T,
    implementation: Partial<ServiceImpl<T>>,
    options?: Partial<UniversalHandlerOptions>
  ): this {
    this._router.service(service, implementation, options);
    delete this._paths;
    return this;
  }

  get paths(): Map<string, UniversalHandler> {
    if (this._paths) {
      return this._paths;
    }
    this._paths = new Map();
    for (const handler of this._router.handlers) {
      this.paths.set(handler.requestPath, handler);
    }
    return this._paths;
  }

  async route(req: Request): Promise<Response> {
    const handler = this.paths.get(new URL(req.url).pathname);
    if (!handler) {
      return uResponseNotFound;
    }
    return handler(req);
  }
}
