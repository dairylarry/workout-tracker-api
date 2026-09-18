import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { WorkoutTrackerStack } from '../lib/workout-tracker-stack'

const synth = (stage: 'dev' | 'prod') =>
  Template.fromStack(
    new WorkoutTrackerStack(new App(), `Test-${stage}`, {
      env: { account: '111111111111', region: 'us-east-1' },
      stage,
      ownerEmail: 'owner@example.com',
      corsOrigins: ['https://example.com'],
    }),
  )

describe('table', () => {
  it('uses opaque GSI1 keys so other entities can join the index later', () => {
    synth('dev').hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
        }),
      ]),
    })
  })

  it('enables point-in-time recovery on both stages', () => {
    for (const stage of ['dev', 'prod'] as const) {
      synth(stage).hasResourceProperties('AWS::DynamoDB::Table', {
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      })
    }
  })

  it('names the table per stage so dev and prod data never mix', () => {
    synth('dev').hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'workout-tracker-api-dev',
    })
    synth('prod').hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'workout-tracker-api-prod',
    })
  })
})

describe('production safeguards', () => {
  /** Workout history is irreplaceable; a stack deletion must not take it with it. */
  it('retains the prod table and turns on deletion protection', () => {
    synth('prod').hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: Match.objectLike({ DeletionProtectionEnabled: true }),
    })
  })

  it('retains the prod user pool, so identities survive too', () => {
    synth('prod').hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain' })
  })

  it('lets dev be torn down freely', () => {
    synth('dev').hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' })
  })
})

describe('auth', () => {
  it('accepts tokens from both platform clients on one authorizer', () => {
    const template = synth('dev')
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 2)
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: Match.objectLike({ Audience: Match.anyValue() }),
    })
  })

  it('wires the post-confirmation trigger to the pool', () => {
    synth('dev').hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: Match.objectLike({ PostConfirmation: Match.anyValue() }),
    })
  })

  it('enforces a password policy with mixed character classes', () => {
    synth('dev').hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: Match.objectLike({
        PasswordPolicy: Match.objectLike({
          MinimumLength: 8,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
        }),
      }),
    })
  })
})

describe('api', () => {
  it('groups handlers by resource rather than one Lambda per route', () => {
    const template = synth('dev')
    const routes = Object.keys(template.findResources('AWS::ApiGatewayV2::Route')).length
    const functions = Object.keys(template.findResources('AWS::Lambda::Function')).length

    expect(routes).toBeGreaterThan(20)
    // Six resource groups plus the Cognito trigger; log-retention helpers would add more.
    expect(functions).toBeLessThanOrEqual(8)
  })

  it('exposes every documented route', () => {
    const template = synth('dev')
    const declared = new Set(
      Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map(
        (r) => (r.Properties as { RouteKey: string }).RouteKey,
      ),
    )

    for (const route of [
      'GET /me',
      'PATCH /me',
      'DELETE /me',
      'GET /exercises',
      'POST /exercises',
      'PATCH /exercises/{slug}',
      'DELETE /exercises/{slug}',
      'GET /exercises/{slug}/history',
      'GET /programs',
      'POST /programs',
      'PUT /programs/{id}',
      'DELETE /programs/{id}',
      'GET /programs/{id}/versions/{version}',
      'GET /sessions',
      'GET /sessions/calendar',
      'GET /sessions/{type}/{date}',
      'POST /sessions/{type}/{date}',
      'PUT /sessions/{type}/{date}',
      'DELETE /sessions/{type}/{date}',
      'GET /bodyweight',
      'POST /bodyweight',
      'DELETE /bodyweight/{date}/{timeOfDay}',
      'GET /tags',
      'PUT /tags',
      'PATCH /owner/exercises/{slug}',
      'DELETE /owner/exercises/{slug}',
      'GET /owner/531-config/{exercise}',
      'PUT /owner/531-config/{exercise}',
      'GET /owner/plan',
      'PUT /owner/plan',
      'POST /owner/core-routines/{routineId}/complete',
      'GET /owner/core-routines/completions',
    ]) {
      expect(declared, `missing route ${route}`).toContain(route)
    }
  })

  it('enables CORS for the browser client', () => {
    synth('dev').hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ['https://example.com'],
        AllowHeaders: ['Authorization', 'Content-Type'],
      }),
    })
  })

  it('passes the owner email to the handlers that need it', () => {
    synth('dev').hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({ OWNER_EMAIL: 'owner@example.com' }),
      }),
    })
  })
})
