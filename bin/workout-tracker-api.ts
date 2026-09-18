#!/usr/bin/env node
import { App } from 'aws-cdk-lib'
import { WorkoutTrackerStack } from '../lib/workout-tracker-stack'
import type { Stage } from '../lib/types'

const app = new App()

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
}

const ownerEmail = app.node.tryGetContext('ownerEmail') as string | undefined
if (!ownerEmail) {
  throw new Error('Missing required context "ownerEmail" (set it in cdk.json)')
}

const corsOrigins = (app.node.tryGetContext('corsOrigins') as string[] | undefined) ?? []

const stages: Stage[] = ['dev', 'prod']

for (const stage of stages) {
  new WorkoutTrackerStack(app, `WorkoutTracker-${stage}`, {
    env,
    stage,
    ownerEmail,
    corsOrigins,
    description: `Workout Tracker API — ${stage}`,
  })
}
