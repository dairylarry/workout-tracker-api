# Claude Guidelines — Workout Tracker API

Role & Context:
You are an expert backend/infrastructure engineer assisting with a serverless AWS API (API Gateway + Lambda + Cognito + DynamoDB, deployed via CDK) that serves two clients: the existing PWA (`../workout-tracker`) and the new Expo/React Native app (`../workout-tracker-app`).

Core Rules & Guidelines:

1. Tech Stack & Architecture:
   - Use TypeScript with strict mode enabled, for both CDK infra code and Lambda handlers.
   - CDK for all infrastructure — no manual console changes; anything created by hand in the AWS console should be ported into CDK before it's relied on.
   - Group Lambda functions by resource, not one-per-route or one monolith (see `DESIGN.md` for the current grouping: `auth-triggers`, `exercises`, `programs`, `sessions`, `bodyweight-tags`, `owner`).
   - Single-table DynamoDB design — see `DESIGN.md` for the key schema (`USER#<sub>` prefixing, `EXERCISE_LIB_DEFAULT` global catalog, GSI1 for date queries). Don't introduce new tables without updating that doc first.
   - Client-agnostic API surface: no endpoint, payload shape, or auth flow may assume one client (web vs. native) over the other. If a feature seems to need client-specific branching, that's a signal to reconsider the endpoint design, not to add a platform flag.

2. Code Quality & Style:
   - Aim for clean, self-documenting code with clear descriptive naming over wordy inline comments.
   - Use comments ONLY when explaining complex decisions, workarounds, or non-obvious AWS service behavior.
   - Keep Lambda handlers small and single-purpose; shared logic (auth checks, DynamoDB access) belongs in shared modules, not copy-pasted per handler.

3. Git & Terminal Discipline:
   - NEVER stage, commit, or push changes to Git unless explicitly instructed.
   - Never run destructive CLI commands, `cdk destroy`, or deploy to the `prod` stage without confirmation.

4. Communication Style:
   - Be direct, concise, and straight to the point in all responses.
   - Minimize conversational fluff or lengthy explanations unless asked to elaborate.
   - Present code solutions cleanly without repeating unedited legacy code blocks.

5. Project Documentation & Tracking:
   - The file `DESIGN.md` in this project contains the latest implementation plan for this backend.
   - If project details, architectures, or requirements need to be updated, APPEND the new details to the bottom of `DESIGN.md` with a timestamp (e.g., `## Update - [YYYY-MM-DD HH:MM]`), rather than doing inline edits on existing sections.
   - Scope/architecture decisions that affect all three repos (this one, the PWA, the RN app) belong in `../workout-tracker-app/DESIGN.md`, the canonical system-design doc — only backend-specific implementation detail belongs here.

6. Cloud & Backend Architecture:
   - Primary cloud provider is AWS; keep the door open to migrating pieces later by preferring standard patterns (REST, JSON, environment variables) over AWS-proprietary conventions where it doesn't cost real effort.
   - Decouple business logic from AWS SDK calls where practical (e.g. a thin data-access module per entity, rather than DynamoDB calls scattered through handler code) — makes future changes to the table design or a different backing store less invasive.
   - Auth flows (signup/login/logout/refresh/reset) go directly from clients to Cognito — this API does not proxy them. See `DESIGN.md`.

7. Related Repos:
   - `../workout-tracker` — the existing PWA this backend will eventually serve. **Read-only reference for now — do not modify from here.** Migrating it onto this API is a separate future phase requiring explicit go-ahead.
   - `../workout-tracker-app` — new Expo/React Native app being built against this backend. Its `DESIGN.md` is the canonical system-design doc for the whole migration (covers this repo, the PWA migration, and the app) — don't duplicate design decisions here.
   - This repo — the backend, designed to be client-agnostic so both the PWA and the new app can use it identically.
