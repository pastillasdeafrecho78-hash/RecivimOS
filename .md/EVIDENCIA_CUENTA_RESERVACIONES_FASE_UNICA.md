WU# Evidencia final - Cuenta + Reservaciones (fase unica)

Fecha: 2026-04-08

## Scope entregado

- PedimOS: cuenta completa (register/login/logout/me/update/orders/claim-guest) con sesion segura `pedimos_account_session`.
- PedimOS: fast login Meta/Facebook (inicio + callback) con fallback a email/password.
- PedimOS: reservaciones del cliente (crear/listar/cancelar) enlazadas a la cuenta autenticada.
- ServimOS: API de reservaciones (crear/listar/consultar/actualizar/cancelar) con permisos por contexto.
- ServimOS: UI de reservaciones en `dashboard/mesas/reservaciones`.
- Seguridad: tenant checks, auditoria, endpoint sensible protegido (`benefits/commission-free`).

## Commits y despliegues

- PedimOS repo `main`:
  - `884ce78` feat(pedimos): add real account flows and customer reservations
  - `be06c88` fix(pedimos): split ddl statements for runtime-safe account provisioning
  - Deploy READY: `dpl_8eBnhSQ4tSBR6f2WoQEoRSD7NZ8j`

- ServimOS repo `master`:
  - `20b6fc9` feat(servimos): add reservations api and mesas reservation workspace
  - `410c23b` fix(servimos): split reservation ddl statements for Prisma runtime
  - Deploy READY: `dpl_Bzq2YEL2fGegbs8yVS3ied5YJYgA`

## Matriz de validacion (happy path + abuso + tenant mismatch)

| Caso | Tipo | Endpoint/Flujo | Esperado | Resultado |
|---|---|---|---|---|
| Registro de cuenta cliente | Happy path | `POST /api/public/account/register` | `201/200 success:true` y cookie de cuenta | OK en prod |
| Obtener perfil de cuenta | Happy path | `GET /api/public/account/me` | `200 success:true` datos de usuario/sucursal | OK en prod |
| Crear reservacion desde cuenta | Happy path | `POST /api/public/account/reservations` | `201 success:true` con `id` | OK en prod |
| Listar reservaciones propias | Happy path | `GET /api/public/account/reservations` | `200 success:true` solo reservaciones del owner | OK en prod |
| Endpoint de reservaciones sin auth (ServimOS) | Abuse | `GET /api/reservaciones` sin sesion | `401` | OK en prod |
| Otorgar beneficio sin secreto interno | Abuse | `POST /api/public/account/benefits/commission-free` | rechazo (`401/403`) | OK por contrato de endpoint |
| Modificar/cancelar reservacion de tercero | Abuse | `PATCH/DELETE /api/reservaciones/:id` sin permiso manager | `403` | Implementado en guardas |
| Acceso cruzado de tenant | Tenant mismatch | cuenta/sesion de sucursal A contra recursos de sucursal B | `404/403` segun contexto | Implementado en checks de tenant |
| Claim de invitado fuera de tenant | Tenant mismatch | `POST /api/public/account/claim-guest` con ids de otro tenant | no vincula fuera de sucursal | Implementado por filtro `restauranteId` |

## Observaciones de hardening

- Se corrigio un error runtime de Prisma separando sentencias DDL (`CREATE TABLE`/`CREATE INDEX`) en ejecuciones independientes.
- No se modifica el plan fuente; solo se entrega evidencia final de ejecucion.
- Meta login depende de variables en runtime:
  - `META_CLIENT_ID`
  - `META_CLIENT_SECRET`
  - `META_REDIRECT_URI`
