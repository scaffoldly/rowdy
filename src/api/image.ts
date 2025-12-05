import { defer, map, Observable, of, race } from 'rxjs';
import { AxiosInstance } from 'axios';
import { IApi, IImageApi, PullImageOptions, TPulledImage, TRegistry } from './types';
import { Logger } from '../log';
import { Transfer } from './internal/transfer';
import { AwsRegistry } from '../aws/registry';
import { LocalRegistry } from '../local/registry';

export class ImageApi implements IImageApi {
  constructor(private api: IApi) {}

  get http(): AxiosInstance {
    return this.api.http;
  }

  get log(): Logger {
    return this.api.log;
  }

  get registry(): Observable<TRegistry> {
    return defer(() => race([new AwsRegistry(this.api.environment).login(), new LocalRegistry().login()]));
  }

  pullImage(image: string, opts?: PullImageOptions): Observable<TPulledImage> {
    return defer(() =>
      of(image)
        .pipe(
          Transfer.normalize(opts?.authorization, opts?.registry),
          Transfer.collect(this.log, this.http, opts?.layersFrom),
          Transfer.prepare(this.log, this.http, this.registry),
          Transfer.upload(this.log, this.http),
          Transfer.denormalize(opts?.platform)
        )
        .pipe(
          map(({ imageRef, command, entrypoint, workdir, environment }) => ({
            Image: image,
            ImageUri: imageRef,
            Command: command,
            Entrypoint: entrypoint,
            WorkDir: workdir,
            Environment: environment,
          }))
        )
    );
  }
}

/*
TODO: Make logs match this
#34 [auth] scaffoldly/rowdy:pull,push token for ghcr.io
#34 DONE 0.0s
#33 exporting to image
#33 exporting manifest sha256:cf6ff12d727948dfd3a87fdd2fe148fff38ed6a76b26a0c4b43fc3208e10aec0 done
#33 exporting config sha256:44e47330ddb8b59c51c1440de7ab6ac4f9cd127da8f5074567104973043e10de done
#33 exporting attestation manifest sha256:de3f0ca9b8b8a197c715515493b8fa3adbddc78d42821bb9f9f73e8802535bbf done
#33 exporting manifest sha256:5d9251d573bdaa098fdaf7b5360198f89d725b5372a3bc6f311dac6811be8df8 done
#33 exporting config sha256:6390559d699de63fec1276846b9f0559da908a2d9da99b9ee364d06e190dfce4 done
#33 exporting attestation manifest sha256:e06eb88bceb1dbf9dd2202dce8d23a09a882253ddec86772eb9ca432fe425227 done
#33 exporting manifest list sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e done
#33 pushing layers
#33 pushing layers 2.9s done
#33 pushing manifest for ghcr.io/scaffoldly/rowdy:0.0.2-1-beta.20251028095209.ac8bae8@sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e
#33 pushing manifest for ghcr.io/scaffoldly/rowdy:0.0.2-1-beta.20251028095209.ac8bae8@sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e 2.4s done
#33 pushing layers 0.2s done
#33 pushing manifest for ghcr.io/scaffoldly/rowdy:beta@sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e
#33 pushing manifest for ghcr.io/scaffoldly/rowdy:beta@sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e 0.7s done
#33 pushing layers 0.3s done
#33 pushing manifest for ghcr.io/scaffoldly/rowdy:sha-ac8bae8@sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e
#33 pushing manifest for ghcr.io/scaffoldly/rowdy:sha-ac8bae8@sha256:269c3a453ed118e18dbf32bb7e0b6047fa98926eab5e077fbabc795a7ace532e 0.5s done
*/
