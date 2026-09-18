import { Duration, RemovalPolicy } from 'aws-cdk-lib'
import type { Table } from 'aws-cdk-lib/aws-dynamodb'
import {
  AccountRecovery,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolOperation,
  VerificationEmailStyle,
} from 'aws-cdk-lib/aws-cognito'
import { Construct } from 'constructs'
import type { Stage } from '../types'
import { NodeHandler } from './node-handler'

export interface AuthProps {
  stage: Stage
  table: Table
  ownerEmail: string
}

const APP_NAME = "Barry's Workout Tracker"

/**
 * Cognito's own mailer sends these, so the From address stays
 * no-reply@verificationemail.com until a domain is verified in SES. The body is
 * plain text with a {####} placeholder Cognito substitutes with the code.
 */
const VERIFICATION_EMAIL_BODY = [
  `This is an email from ${APP_NAME}.`,
  '',
  'Your verification code is {####}',
  '',
  "If you didn't request this, you can safely ignore this email.",
].join('\n')

const INVITATION_EMAIL_BODY = [
  `You've been invited to ${APP_NAME}.`,
  '',
  'Username: {username}',
  'Temporary password: {####}',
  '',
  "You'll be asked to choose a new password when you first sign in.",
].join('\n')

/**
 * Cognito user pool plus the two platform app clients.
 *
 * Clients call Cognito directly for signup/login/refresh/reset — this API never
 * proxies those flows. Separate app clients per platform exist so token lifetimes
 * can diverge later without touching the API contract.
 */
export class Auth extends Construct {
  readonly userPool: UserPool
  readonly webClient: UserPoolClient
  readonly nativeClient: UserPoolClient

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id)

    const isProd = props.stage === 'prod'

    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: `workout-tracker-${props.stage}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        // Cognito's default. The character-class requirements below carry most of the
        // strength at this length; raising it is a product decision affecting every user.
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      userVerification: {
        emailSubject: `Verify your ${APP_NAME} account`,
        emailBody: VERIFICATION_EMAIL_BODY,
        // CODE rather than LINK: the native app has no web callback to land a link on,
        // and a code works identically from a browser and a phone.
        emailStyle: VerificationEmailStyle.CODE,
      },
      userInvitation: {
        emailSubject: `You've been invited to ${APP_NAME}`,
        emailBody: INVITATION_EMAIL_BODY,
      },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      deletionProtection: isProd,
    })

    const commonClientProps = {
      userPool: this.userPool,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.EMAIL, OAuthScope.OPENID, OAuthScope.PROFILE],
      },
    }

    this.webClient = new UserPoolClient(this, 'WebClient', {
      ...commonClientProps,
      userPoolClientName: `web-${props.stage}`,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    })

    this.nativeClient = new UserPoolClient(this, 'NativeClient', {
      ...commonClientProps,
      userPoolClientName: `native-${props.stage}`,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      // Native sessions are longer-lived: re-authenticating on a phone mid-gym is
      // far more disruptive than in a browser tab.
      refreshTokenValidity: Duration.days(90),
    })

    // Creates USER#<sub>/PROFILE on signup. The same logic is also invoked lazily by
    // GET /me — Cognito triggers fail without retry, and a confirmed user with no
    // profile would otherwise have every subsequent request fail.
    const postConfirmation = new NodeHandler(this, 'PostConfirmation', {
      entry: 'src/auth-triggers/post-confirmation.ts',
      table: props.table,
      stage: props.stage,
      environment: { OWNER_EMAIL: props.ownerEmail },
    })
    props.table.grantReadWriteData(postConfirmation.fn)

    this.userPool.addTrigger(UserPoolOperation.POST_CONFIRMATION, postConfirmation.fn)
  }
}
