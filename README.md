# PedimOS Backend (Vertical Slice v1)

Backend `Fastify + TypeScript + Prisma` con contrato `CreateExternalOrder v1` para flujo `Second App -> Main Backend`.

## Scripts

- `npm run dev`: inicia servidor en modo desarrollo.
- `npm test`: ejecuta pruebas de contrato e integración.
- `npm run typecheck`: validación TypeScript (`tsc --noEmit`).
- `npm run build`: compila a `dist/`.
- `npm run prisma:generate`: genera Prisma client.

## Variables de entorno

Basarse en `.env.example`:

- `DATABASE_URL`: PostgreSQL de Supabase.
- `PORT`: puerto HTTP.
- `IDEMPOTENCY_TTL_HOURS`: TTL de idempotencia.

## Contrato implementado

- `POST /api/public/integraciones/pedidos/orders`
  - headers obligatorios: `x-api-key`, `x-restaurante-slug`, `x-idempotency-key`.
  - idempotencia obligatoria por `x-idempotency-key`.
  - tenant routing estricto `key -> restaurante -> slug`.
  - errores canónicos con campo `code`.
- `GET /api/public/integraciones/pedidos/orders/:orderId`
  - polling de estado para segunda app con mismo auth/scope.

## Supabase + Vercel

1. Crear proyecto en Supabase y copiar `DATABASE_URL`.
2. Correr migraciones en entorno remoto:
   - `npm run prisma:generate`
   - `npx prisma migrate deploy`
3. Configurar variables en Vercel (`DATABASE_URL`, `PORT`, `IDEMPOTENCY_TTL_HOURS`).
4. En pipeline de deploy:
   - `npm ci`
   - `npm run prisma:generate`
   - `npm run build`
