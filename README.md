# MYASS

**Mike's Yodelling Audial String Synthesizer**

A Raspberry Pi-based programmable guitar effects platform with a web/iPhone control surface.

## Current architecture

```text
Browser / iPhone
      |
      v
Next.js Web App
      |
      | HTTP + WebSocket
      v
NestJS API
      |
      +---- MySQL / Drizzle
      |
      +---- Device Protocol
                 |
                 +---- MYASS Simulator (now)
                 |
                 +---- Raspberry Pi Agent (later)
```

The audio signal never travels through the API. The Pi will eventually process:

```text
Guitar -> UMC22 -> Raspberry Pi DSP -> UMC22 -> Amp
```

## Stack

- Next.js 16 + React 19
- TanStack Query
- NestJS 12 + Fastify
- Zod
- MySQL
- Drizzle ORM
- WebSocket
- pnpm + Turborepo
- Vitest
- C++ DSP on Raspberry Pi
- TypeScript simulator during hardware-free development

## Requirements

- Node.js 20.11+
- pnpm 10+
- MySQL 8+
- Git

## Quick start

```bash
cp .env.example .env
pnpm install
pnpm db:push
pnpm dev
```

Apps:

- Web: http://localhost:3000
- API: http://localhost:3001
- Simulator WebSocket: ws://localhost:3002

## Useful commands

```bash
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test

pnpm db:push
pnpm db:generate
pnpm db:migrate
pnpm db:studio
```

## First vertical slice

The first software milestone is:

1. Open the web app.
2. See a simulated MYASS device.
3. See its online status.
4. Select an effect.
5. Change an effect parameter.
6. Send the parameter update over WebSocket.
7. See the simulator acknowledge the change.

The simulator implements the same protocol the future Raspberry Pi agent will implement.
