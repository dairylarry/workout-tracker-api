import { Duration } from 'aws-cdk-lib'
import {
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
  type IHttpRouteAuthorizer,
} from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import type { UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito'
import type { Table } from 'aws-cdk-lib/aws-dynamodb'
import { Construct } from 'constructs'
import type { Stage } from '../types'
import { NodeHandler } from './node-handler'

export interface ApiProps {
  stage: Stage
  table: Table
  userPool: UserPool
  webClient: UserPoolClient
  nativeClient: UserPoolClient
  ownerEmail: string
  corsOrigins: string[]
}

/** One Lambda per resource group; each routes internally by method + path. */
interface HandlerGroup {
  id: string
  entry: string
  routes: Array<{ path: string; methods: HttpMethod[] }>
}

const HANDLER_GROUPS: HandlerGroup[] = [
  {
    id: 'Profile',
    entry: 'src/profile/index.ts',
    routes: [{ path: '/me', methods: [HttpMethod.GET, HttpMethod.PATCH, HttpMethod.DELETE] }],
  },
  {
    id: 'Exercises',
    entry: 'src/exercises/index.ts',
    routes: [
      { path: '/exercises', methods: [HttpMethod.GET, HttpMethod.POST] },
      { path: '/exercises/{slug}', methods: [HttpMethod.PATCH, HttpMethod.DELETE] },
      { path: '/exercises/{slug}/history', methods: [HttpMethod.GET] },
    ],
  },
  {
    id: 'Programs',
    entry: 'src/programs/index.ts',
    routes: [
      { path: '/programs', methods: [HttpMethod.GET, HttpMethod.POST] },
      { path: '/programs/{id}', methods: [HttpMethod.PUT, HttpMethod.DELETE] },
      { path: '/programs/{id}/versions/{version}', methods: [HttpMethod.GET] },
    ],
  },
  {
    id: 'Sessions',
    entry: 'src/sessions/index.ts',
    routes: [
      { path: '/sessions', methods: [HttpMethod.GET] },
      { path: '/sessions/calendar', methods: [HttpMethod.GET] },
      {
        path: '/sessions/{type}/{date}',
        methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.PUT, HttpMethod.DELETE],
      },
    ],
  },
  {
    id: 'BodyweightTags',
    entry: 'src/bodyweight-tags/index.ts',
    routes: [
      { path: '/bodyweight', methods: [HttpMethod.GET, HttpMethod.POST] },
      { path: '/bodyweight/{date}/{timeOfDay}', methods: [HttpMethod.DELETE] },
      { path: '/tags', methods: [HttpMethod.GET, HttpMethod.PUT] },
    ],
  },
  {
    id: 'Owner',
    entry: 'src/owner/index.ts',
    routes: [
      { path: '/owner/exercises/{slug}', methods: [HttpMethod.PATCH, HttpMethod.DELETE] },
      { path: '/owner/531-config/{exercise}', methods: [HttpMethod.GET, HttpMethod.PUT] },
      { path: '/owner/plan', methods: [HttpMethod.GET, HttpMethod.PUT] },
      { path: '/owner/core-routines/completions', methods: [HttpMethod.GET] },
      { path: '/owner/core-routines/{routineId}/complete', methods: [HttpMethod.POST] },
    ],
  },
]

export class Api extends Construct {
  readonly httpApi: HttpApi

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id)

    // ID tokens, not access tokens: the ID token carries the `email` claim that
    // owner determination and lazy profile creation depend on. Audience is both
    // app clients so either platform's token is accepted identically.
    const authorizer: IHttpRouteAuthorizer = new HttpJwtAuthorizer(
      'JwtAuthorizer',
      props.userPool.userPoolProviderUrl,
      {
        jwtAudience: [props.webClient.userPoolClientId, props.nativeClient.userPoolClientId],
        identitySource: ['$request.header.Authorization'],
      },
    )

    this.httpApi = new HttpApi(this, 'HttpApi', {
      apiName: `workout-tracker-api-${props.stage}`,
      description: `Workout Tracker API (${props.stage})`,
      defaultAuthorizer: authorizer,
      corsPreflight: {
        // The PWA is browser-hosted and needs these; the RN app is not subject to CORS.
        allowOrigins: props.corsOrigins,
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Authorization', 'Content-Type'],
        allowCredentials: false,
        maxAge: Duration.hours(1),
      },
    })

    for (const group of HANDLER_GROUPS) {
      const handler = new NodeHandler(this, group.id, {
        entry: group.entry,
        table: props.table,
        stage: props.stage,
        environment: { OWNER_EMAIL: props.ownerEmail },
      })

      props.table.grantReadWriteData(handler.fn)

      const integration = new HttpLambdaIntegration(`${group.id}Integration`, handler.fn)

      for (const route of group.routes) {
        this.httpApi.addRoutes({
          path: route.path,
          methods: route.methods,
          integration,
        })
      }
    }
  }
}
