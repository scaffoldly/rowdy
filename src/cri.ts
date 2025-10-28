import { DescService } from '@bufbuild/protobuf';
import * as CRI from './cri-api/pkg/apis/runtime/v1/api_pb';
import CRIDocs from './cri-api/pkg/apis/runtime/v1/api.openapi.json';
import { Docs, GrpcService, GrpcCollection } from './router';
import { Client, createClient, Transport } from '@connectrpc/connect';

export class ImageService extends GrpcService<typeof CRI.ImageService, CriCollection> {
  static client(transport: Transport): Client<typeof CRI.ImageService> {
    return createClient(CRI.ImageService, transport);
  }

  constructor(services: GrpcCollection<CriCollection>) {
    super(services, CRI.ImageService);
  }
}

export class RuntimeService extends GrpcService<typeof CRI.RuntimeService, CriCollection> {
  static client(transport: Transport): Client<typeof CRI.RuntimeService> {
    return createClient(CRI.RuntimeService, transport);
  }

  constructor(services: GrpcCollection<CriCollection>) {
    super(services, CRI.RuntimeService);
  }
}

export class CriCollection extends GrpcCollection<CriCollection> {
  public readonly Image: ImageService = new ImageService(this);
  public readonly Runtime: RuntimeService = new RuntimeService(this);

  get services(): GrpcService<DescService, CriCollection>[] {
    return [this.Image, this.Runtime];
  }

  get docs(): Docs | undefined {
    return CRIDocs as unknown as Docs;
  }
}

export { CRI };
