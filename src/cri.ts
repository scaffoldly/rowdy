import { DescService } from '@bufbuild/protobuf';
import * as CRI from './cri-api/pkg/apis/runtime/v1/api_pb';
import CRIDocs from './cri-api/pkg/apis/runtime/v1/api.openapi.json';
import { Docs, Service, Services } from './router';
import { Client, createClient, Transport } from '@connectrpc/connect';

export class ImageService extends Service<typeof CRI.ImageService, CRIServices> {
  static client(transport: Transport): Client<typeof CRI.ImageService> {
    return createClient(CRI.ImageService, transport);
  }

  constructor(services: Services<CRIServices>) {
    super(services, CRI.ImageService);
  }
}

export class RuntimeService extends Service<typeof CRI.RuntimeService, CRIServices> {
  static client(transport: Transport): Client<typeof CRI.RuntimeService> {
    return createClient(CRI.RuntimeService, transport);
  }

  constructor(services: Services<CRIServices>) {
    super(services, CRI.RuntimeService);
  }
}

export class CRIServices extends Services<CRIServices> {
  public readonly Image: ImageService = new ImageService(this);
  public readonly Runtime: RuntimeService = new RuntimeService(this);

  get services(): Service<DescService, CRIServices>[] {
    return [this.Image, this.Runtime];
  }

  get docs(): Docs {
    return CRIDocs as unknown as Docs;
  }
}

export { CRI };
