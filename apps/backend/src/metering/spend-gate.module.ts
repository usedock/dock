import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { NoopSpendGate, SpendGate } from './spend-gate';

export interface SpendGateOptions {
  imports?: NonNullable<DynamicModule['imports']>;
  provider?: Provider;
}

/** Binds the SpendGate token globally; defaults to the no-op gate. */
@Global()
@Module({})
export class SpendGateModule {
  static forRoot(options: SpendGateOptions = {}): DynamicModule {
    const provider = options.provider ?? { provide: SpendGate, useClass: NoopSpendGate };
    return { module: SpendGateModule, imports: options.imports ?? [], providers: [provider], exports: [SpendGate] };
  }
}
