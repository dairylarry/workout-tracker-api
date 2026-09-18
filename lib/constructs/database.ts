import { RemovalPolicy } from 'aws-cdk-lib'
import { AttributeType, BillingMode, ProjectionType, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb'
import { Construct } from 'constructs'
import type { Stage } from '../types'

export interface DatabaseProps {
  stage: Stage
}

/**
 * Single-table store for all user-owned data.
 *
 * GSI1 uses deliberately generic key names: a GSI's key schema cannot be changed
 * after creation, so opaque GSI1PK/GSI1SK let any entity type opt into the index
 * later without provisioning a second one. Session items populate it initially
 * (USER#<sub> / DATE#<date>) to serve the calendar view.
 */
export class Database extends Construct {
  readonly table: Table

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id)

    const isProd = props.stage === 'prod'

    this.table = new Table(this, 'Table', {
      tableName: `workout-tracker-api-${props.stage}`,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Workout history is irreplaceable and this is the only copy once the legacy
      // table is retired — prod must survive a stack deletion.
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      deletionProtection: isProd,
    })

    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    })
  }
}
