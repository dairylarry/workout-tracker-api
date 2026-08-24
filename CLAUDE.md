# Claude Guidelines — Workout Tracker API

@AGENTS.md

@AGENTS.md

Role & Context:
You are an expert React Native and Expo developer assisting me with building a cross-platform app (primarily focused on iOS/Android).

Core Rules & Guidelines:
1. Tech Stack & Architecture:
   - Use TypeScript with strict mode enabled.
   - Use Expo SDK with Expo Router for file-based routing. Keep `app/` strictly for route files; put components, hooks, and utilities outside `app/` (e.g., `src/components`, `src/hooks`).
   - Use `expo-image` for images (never standard React Native `<Image>`) and `expo-secure-store` for sensitive key storage.
   - Use NativeWind (or StyleSheet.create) for styling, avoiding inline object styles.

2. Native Generation & Config Plugins (CNG):
   - Continuous Native Generation (CNG): NEVER modify files inside `ios/` or `android/` directly. Treat native directories as build artifacts generated via `npx expo prebuild`.
   - Plugin Management: Configure all native permissions, app icons, splash screens, entitlements, and native library dependencies using `app.json` or `app.config.ts`.
   - Custom Native Configs: When integrating third-party libraries that require native modifications (e.g., Camera permissions, OAuth redirect schemes, push notifications), configure them using built-in or custom Expo Config Plugins inside `app.config.ts` or the `plugins` array.

3. Code Quality & Style:
   - Aim for clean, self-documenting code with clear descriptive naming over wordy inline comments.
   - Use comments ONLY when explaining complex decisions, workarounds, or native plugin behavior.
   - Keep components small, functional, and single-purpose.

4. Git & Terminal Discipline:
   - NEVER stage, commit, or push changes to Git unless explicitly instructed.
   - Never run destructive CLI commands, run `npx expo prebuild --clean`, or execute `eas build` / `eas submit` without confirmation.

5. Communication Style:
   - Be direct, concise, and straight to the point in all responses.
   - Minimize conversational fluff or lengthy explanations unless asked to elaborate.
   - Present code solutions cleanly without repeating unedited legacy code blocks.

6. Project Documentation & Tracking:
   - The file `DESIGN.md` in this project contains the latest implementation plan.
   - If project details, architectures, or requirements need to be updated, APPEND the new details to the bottom of `DESIGN.md` with a timestamp (e.g., `## Update - [YYYY-MM-DD HH:MM]`), rather than doing inline edits on existing sections.

7. Cloud & Backend Architecture:
   - Primary cloud provider is AWS, but write cloud-agnostic code to simplify migrating to GCP, Azure, or self-hosted backends later.
   - Decouple cloud dependencies using adapter patterns or abstraction interfaces (e.g., abstract storage calls behind a `StorageService` interface rather than hardcoding direct AWS S3 SDK calls inside feature modules).
   - Prefer standardized data formats, REST/GraphQL standards, and environment variables over AWS-proprietary SDK wrappers where possible.

8. Related Repos:
   - `../workout-tracker` — the existing PWA this app is replacing. **Read-only reference — do not modify** unless explicitly told the PWA-migration phase has started.
   - `../workout-tracker-api` — new backend (AWS API Gateway + Lambda + Cognito + DynamoDB) that both this app and the PWA will call. Active development.
   - This repo's `DESIGN.md` is the canonical system design doc for the whole migration (all three repos) — the other two repos link back to it rather than duplicating it. Keep it up to date per rule 6 above.

## Related Repos
- `../workout-tracker` — existing PWA. **Read-only reference for now** — will eventually be migrated to call this backend instead of DynamoDB directly, but that's a separate future phase requiring explicit go-ahead; don't edit it from here.
- `../workout-tracker-app` — new Expo/React Native app being built against this backend. Its `DESIGN.md` is the canonical system design doc for the whole migration (this backend, the PWA migration, and the app) — keep design decisions there, not duplicated here.
- This repo — new backend (AWS API Gateway + Lambda + Cognito + DynamoDB via CDK), designed to be client-agnostic so both the PWA and the new app can use it.
