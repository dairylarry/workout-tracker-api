import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { Api } from './constructs/api'
import { Auth } from './constructs/auth'
import { Database } from './constructs/database'
import type { Stage } from './types'

export interface WorkoutTrackerStackProps extends StackProps {
  stage: Stage
  ownerEmail: string
  corsOrigins: string[]
}

export class WorkoutTrackerStack extends Stack {
  constructor(scope: Construct, id: string, props: WorkoutTrackerStackProps) {
    super(scope, id, props)

    const database = new Database(this, 'Database', { stage: props.stage })

    const auth = new Auth(this, 'Auth', {
      stage: props.stage,
      table: database.table,
      ownerEmail: props.ownerEmail,
    })

    const api = new Api(this, 'Api', {
      stage: props.stage,
      table: database.table,
      userPool: auth.userPool,
      webClient: auth.webClient,
      nativeClient: auth.nativeClient,
      ownerEmail: props.ownerEmail,
      corsOrigins: props.corsOrigins,
    })

    new CfnOutput(this, 'ApiUrl', { value: api.httpApi.apiEndpoint })
    new CfnOutput(this, 'TableName', { value: database.table.tableName })
    new CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId })
    new CfnOutput(this, 'WebClientId', { value: auth.webClient.userPoolClientId })
    new CfnOutput(this, 'NativeClientId', { value: auth.nativeClient.userPoolClientId })
  }
}
