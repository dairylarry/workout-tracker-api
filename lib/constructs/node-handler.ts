import { Duration, RemovalPolicy } from 'aws-cdk-lib'
import type { Table } from 'aws-cdk-lib/aws-dynamodb'
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import { Construct } from 'constructs'
import type { Stage } from '../types'

export interface NodeHandlerProps {
  entry: string
  table: Table
  stage: Stage
  environment?: Record<string, string>
}

/** Shared bundling/runtime defaults so every Lambda in the stack is configured identically. */
export class NodeHandler extends Construct {
  readonly fn: NodejsFunction

  constructor(scope: Construct, id: string, props: NodeHandlerProps) {
    super(scope, id)

    const logGroup = new LogGroup(this, 'Logs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    this.fn = new NodejsFunction(this, 'Fn', {
      entry: props.entry,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(15),
      logGroup,
      environment: {
        TABLE_NAME: props.table.tableName,
        STAGE: props.stage,
        NODE_OPTIONS: '--enable-source-maps',
        ...props.environment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        // CommonJS, deliberately. esbuild's ESM output wraps bundled CJS dependencies
        // in a `__require` shim that throws "Dynamic require of ... is not supported"
        // the moment the AWS SDK reaches for node:https — at module load, before any
        // handler code runs, so it cannot be caught. Nothing here needs ESM.
        format: OutputFormat.CJS,
        target: 'node22',
        // The SDK v3 clients are bundled rather than taken from the runtime: the
        // provided version lags, and bundling keeps behaviour pinned to CI.
        externalModules: [],
      },
    })
  }
}
