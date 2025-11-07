import { CriCollection } from '@scaffoldly/rowdy-grpc';
import { LambdaImageService } from './image';
import { LambdaRuntimeService } from './runtime';
import { Environment } from '../../environment';

export class LambdaCri extends CriCollection {
  private readonly image: LambdaImageService = new LambdaImageService(this.environment);
  private readonly runtime: LambdaRuntimeService = new LambdaRuntimeService(this.environment);

  constructor(private environment: Environment) {
    super();
    this.and().Image.with(this.image).and().Runtime.with(this.runtime);
  }
}
