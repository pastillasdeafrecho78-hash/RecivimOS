import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { PrismaClient, Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "../../../config/env.js";
import { canonicalError } from "../../../shared/errors/canonicalErrors.js";
import {
  accountClaimGuestSchema,
  accountLoginSchema,
  accountRegisterSchema,
  accountUpdateProfileSchema
} from "../contracts/account.contract.js";
import {
  clearAccountSessionCookie,
  createAccountSessionCookie,
  guestSessionFingerprint,
  hashPassword,
  readAccountSession,
  verifyPassword
} from "../accountSecurity.js";

const prisma = new PrismaClient();

const splitName = (fullName: string): { nombre: string; apellido: string } => {
  const cleaned = fullName.trim().replace(/\s+/g, " ");
  const parts = cleaned.split(" ");
  const nombre = parts.shift() ?? "Cliente";
  const apellido = parts.join(" ") || ".";
  return { nombre, apellido };
};

const ensureAccountTables = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(`
    create table if not exists "PedimosCuentaPerfil" (
      "usuarioId" text primary key,
      "restauranteId" text not null,
      "telefono" text,
      "isCommissionFree" boolean not null default false,
      "createdAt" timestamp without time zone not null default current_timestamp,
      "updatedAt" timestamp without time zone not null default current_timestamp
    )
  `);
  await prisma.$executeRawUnsafe(`
    create table if not exists "PedimosCuentaPedidoClaim" (
      "id" text primary key,
      "restauranteId" text not null,
      "usuarioId" text not null,
      "orderId" text not null,
      "source" text not null default 'manual',
      "createdAt" timestamp without time zone not null default current_timestamp,
      unique("restauranteId", "usuarioId", "orderId")
    )
  `);
  await prisma.$executeRawUnsafe(`
    create index if not exists "PedimosCuentaPedidoClaim_restauranteId_idx"
    on "PedimosCuentaPedidoClaim" ("restauranteId")
  `);
  await prisma.$executeRawUnsafe(`
    create index if not exists "PedimosCuentaPedidoClaim_usuarioId_idx"
    on "PedimosCuentaPedidoClaim" ("usuarioId")
  `);
};

const ensureReservationsTable = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(`
    create table if not exists "Reservacion" (
      "id" text primary key,
      "restauranteId" text not null,
      "mesaId" text null,
      "ownerUserId" text null,
      "createdByUserId" text not null,
      "clienteNombre" text not null,
      "clienteEmail" text null,
      "clienteTelefono" text null,
      "partySize" integer not null,
      "reservedFor" timestamp without time zone not null,
      "durationMinutes" integer not null default 90,
      "status" text not null default 'PENDIENTE',
      "notes" text null,
      "createdAt" timestamp without time zone not null default current_timestamp,
      "updatedAt" timestamp without time zone not null default current_timestamp
    )
  `);
  await prisma.$executeRawUnsafe(`
    create index if not exists "Reservacion_restauranteId_idx" on "Reservacion" ("restauranteId")
  `);
  await prisma.$executeRawUnsafe(`
    create index if not exists "Reservacion_ownerUserId_idx" on "Reservacion" ("ownerUserId")
  `);
  await prisma.$executeRawUnsafe(`
    create index if not exists "Reservacion_reservedFor_idx" on "Reservacion" ("reservedFor")
  `);
};

const getOrCreateCustomerRole = async (): Promise<{ id: string }> => {
  const existing = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    select "id"
    from "Rol"
    where "codigo" = 'CLIENTE_APP'
    limit 1
  `);
  if (existing[0]) return existing[0];

  const id = randomUUID();
  await prisma.$executeRaw(
    Prisma.sql`
      insert into "Rol" ("id", "nombre", "codigo", "descripcion", "permisos", "createdAt", "updatedAt")
      values (
        ${id},
        'Cliente App',
        'CLIENTE_APP',
        'Perfil cliente para PedimOS',
        ${JSON.stringify(["orders.view", "orders.manage"])}::jsonb,
        ${new Date()},
        ${new Date()}
      )
      on conflict ("codigo") do nothing
    `
  );
  const fallback = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    select "id"
    from "Rol"
    where "codigo" = 'CLIENTE_APP'
    limit 1
  `);
  if (!fallback[0]) throw new Error("No fue posible inicializar rol cliente");
  return fallback[0];
};

const requireAccountSession = async (request: FastifyRequest): Promise<{
  userId: string;
  restauranteId: string;
  restauranteSlug: string;
  email: string;
}> => {
  const session = readAccountSession(request);
  if (!session) {
    throw canonicalError("invalid_api_key", "Sesion de cuenta no valida");
  }
  const valid = await prisma.$queryRaw<
    Array<{ id: string; restauranteId: string; slug: string | null; email: string; activo: boolean }>
  >(Prisma.sql`
    select u."id", u."restauranteId", r."slug", u."email", u."activo"
    from "Usuario" u
    inner join "Restaurante" r on r."id" = u."restauranteId"
    where u."id" = ${session.userId}
      and u."restauranteId" = ${session.restauranteId}
    limit 1
  `);
  const row = valid[0];
  if (!row || !row.activo || !row.slug || row.slug !== session.restauranteSlug) {
    throw canonicalError("invalid_api_key", "Sesion de cuenta no valida");
  }
  return {
    userId: row.id,
    restauranteId: row.restauranteId,
    restauranteSlug: row.slug,
    email: row.email
  };
};

export const registerPublicAccountRoutes = (app: FastifyInstance): void => {
  app.post("/api/public/account/register", async (request, reply) => {
    await ensureAccountTables();
    const body = accountRegisterSchema.parse(request.body ?? {});
    const restaurante = await prisma.$queryRaw<
      Array<{ id: string; slug: string | null; nombre: string; activo: boolean }>
    >(Prisma.sql`
      select "id", "slug", "nombre", "activo"
      from "Restaurante"
      where "slug" = ${body.slug}
      limit 1
    `);
    const branch = restaurante[0];
    if (!branch || !branch.activo || !branch.slug) {
      throw canonicalError("branch_not_found", "Sucursal no encontrada");
    }

    const existing = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      select "id"
      from "Usuario"
      where "restauranteId" = ${branch.id}
        and lower("email") = lower(${body.email})
      limit 1
    `);
    if (existing[0]) {
      throw canonicalError("invalid_payload", "El correo ya esta registrado para esta sucursal");
    }

    const role = await getOrCreateCustomerRole();
    const password = await hashPassword(body.password);
    const { nombre, apellido } = splitName(body.nombreCompleto);
    const userId = randomUUID();
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`
          insert into "Usuario" (
            "id","email","nombre","apellido","password","rolId","restauranteId",
            "activeRestauranteId","activeOrganizacionId","activo","createdAt","updatedAt"
          )
          values (
            ${userId}, ${body.email.toLowerCase()}, ${nombre}, ${apellido}, ${password},
            ${role.id}, ${branch.id}, ${branch.id}, null, true, ${now}, ${now}
          )
        `
      );
      await tx.$executeRaw(
        Prisma.sql`
          insert into "SucursalMiembro" (
            "id","usuarioId","restauranteId","rolId","activo","esPrincipal","createdAt","updatedAt"
          )
          values (${randomUUID()}, ${userId}, ${branch.id}, ${role.id}, true, true, ${now}, ${now})
          on conflict ("usuarioId","restauranteId") do nothing
        `
      );
      await tx.$executeRaw(
        Prisma.sql`
          insert into "PedimosCuentaPerfil" ("usuarioId", "restauranteId", "telefono", "createdAt", "updatedAt")
          values (${userId}, ${branch.id}, ${body.telefono ?? null}, ${now}, ${now})
          on conflict ("usuarioId")
          do update set "telefono" = excluded."telefono", "updatedAt" = excluded."updatedAt"
        `
      );
      await tx.$executeRaw(
        Prisma.sql`
          insert into "Auditoria" ("id","restauranteId","usuarioId","accion","entidad","entidadId","detalles","fechaAccion")
          values (
            ${randomUUID()},
            ${branch.id},
            ${userId},
            'REGISTER_ACCOUNT',
            'Usuario',
            ${userId},
            ${JSON.stringify({ channel: "pedimos", email: body.email.toLowerCase() })}::jsonb,
            ${now}
          )
        `
      );
    });

    reply.header(
      "set-cookie",
      createAccountSessionCookie({
        userId,
        restauranteId: branch.id,
        restauranteSlug: branch.slug,
        email: body.email.toLowerCase()
      })
    );
    return reply.status(201).send({
      success: true,
      data: {
        userId,
        email: body.email.toLowerCase(),
        nombreCompleto: body.nombreCompleto,
        restauranteSlug: branch.slug
      }
    });
  });

  app.post("/api/public/account/login", async (request, reply) => {
    await ensureAccountTables();
    const body = accountLoginSchema.parse(request.body ?? {});
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        email: string;
        password: string | null;
        nombre: string;
        apellido: string;
        restauranteId: string;
        restauranteSlug: string | null;
        activo: boolean;
      }>
    >(Prisma.sql`
      select
        u."id",
        u."email",
        u."password",
        u."nombre",
        u."apellido",
        u."restauranteId",
        r."slug" as "restauranteSlug",
        u."activo"
      from "Usuario" u
      inner join "Restaurante" r on r."id" = u."restauranteId"
      where r."slug" = ${body.slug}
        and lower(u."email") = lower(${body.email})
      limit 1
    `);
    const user = rows[0];
    if (!user || !user.activo || !user.password || !user.restauranteSlug) {
      throw canonicalError("invalid_api_key", "Credenciales invalidas");
    }

    const ok = await verifyPassword(body.password, user.password);
    if (!ok) {
      throw canonicalError("invalid_api_key", "Credenciales invalidas");
    }

    const now = new Date();
    await prisma.$executeRaw(
      Prisma.sql`
        update "Usuario"
        set "ultimoAcceso" = ${now}, "updatedAt" = ${now}
        where "id" = ${user.id}
      `
    );
    await prisma.$executeRaw(
      Prisma.sql`
        insert into "Auditoria" ("id","restauranteId","usuarioId","accion","entidad","entidadId","detalles","fechaAccion")
        values (
          ${randomUUID()},
          ${user.restauranteId},
          ${user.id},
          'LOGIN_ACCOUNT',
          'Usuario',
          ${user.id},
          ${JSON.stringify({ channel: "pedimos" })}::jsonb,
          ${now}
        )
      `
    );

    reply.header(
      "set-cookie",
      createAccountSessionCookie({
        userId: user.id,
        restauranteId: user.restauranteId,
        restauranteSlug: user.restauranteSlug,
        email: user.email
      })
    );
    return reply.send({
      success: true,
      data: {
        userId: user.id,
        email: user.email,
        nombreCompleto: `${user.nombre} ${user.apellido}`.trim()
      }
    });
  });

  app.post("/api/public/account/logout", async (_request, reply) => {
    reply.header("set-cookie", clearAccountSessionCookie());
    return reply.status(200).send({ success: true });
  });

  app.get("/api/public/account/me", async (request, reply) => {
    await ensureAccountTables();
    const session = await requireAccountSession(request);
    const rows = await prisma.$queryRaw<
      Array<{
        userId: string;
        email: string;
        nombre: string;
        apellido: string;
        restauranteId: string;
        restauranteSlug: string | null;
        restauranteNombre: string;
        telefono: string | null;
        isCommissionFree: boolean | null;
      }>
    >(Prisma.sql`
      select
        u."id" as "userId",
        u."email",
        u."nombre",
        u."apellido",
        r."id" as "restauranteId",
        r."slug" as "restauranteSlug",
        r."nombre" as "restauranteNombre",
        p."telefono",
        p."isCommissionFree"
      from "Usuario" u
      inner join "Restaurante" r on r."id" = u."restauranteId"
      left join "PedimosCuentaPerfil" p on p."usuarioId" = u."id"
      where u."id" = ${session.userId}
      limit 1
    `);
    const me = rows[0];
    if (!me || !me.restauranteSlug) {
      throw canonicalError("invalid_api_key", "Sesion de cuenta no valida");
    }
    return reply.send({
      success: true,
      data: {
        userId: me.userId,
        email: me.email,
        nombreCompleto: `${me.nombre} ${me.apellido}`.trim(),
        telefono: me.telefono,
        restaurante: {
          id: me.restauranteId,
          slug: me.restauranteSlug,
          nombre: me.restauranteNombre
        },
        isCommissionFree: Boolean(me.isCommissionFree)
      }
    });
  });

  app.patch("/api/public/account/me", async (request, reply) => {
    await ensureAccountTables();
    const session = await requireAccountSession(request);
    const body = accountUpdateProfileSchema.parse(request.body ?? {});
    const updates: string[] = [];
    if (body.nombreCompleto) {
      const { nombre, apellido } = splitName(body.nombreCompleto);
      await prisma.$executeRaw(
        Prisma.sql`
          update "Usuario"
          set "nombre" = ${nombre}, "apellido" = ${apellido}, "updatedAt" = ${new Date()}
          where "id" = ${session.userId}
        `
      );
      updates.push("nombreCompleto");
    }
    if (typeof body.telefono !== "undefined") {
      await prisma.$executeRaw(
        Prisma.sql`
          insert into "PedimosCuentaPerfil" ("usuarioId", "restauranteId", "telefono", "updatedAt")
          values (${session.userId}, ${session.restauranteId}, ${body.telefono}, ${new Date()})
          on conflict ("usuarioId")
          do update set "telefono" = excluded."telefono", "updatedAt" = excluded."updatedAt"
        `
      );
      updates.push("telefono");
    }
    return reply.send({
      success: true,
      data: { updated: updates }
    });
  });

  app.get("/api/public/account/orders", async (request, reply) => {
    await ensureAccountTables();
    const session = await requireAccountSession(request);
    const rows = await prisma.$queryRaw<
      Array<{
        orderId: string;
        numeroComanda: string;
        estado: string;
        total: number;
        fechaCreacion: Date;
      }>
    >(Prisma.sql`
      select c."id" as "orderId", c."numeroComanda", c."estado"::text as "estado", c."total", c."fechaCreacion"
      from "Comanda" c
      where c."restauranteId" = ${session.restauranteId}
        and (
          c."creadoPorId" = ${session.userId}
          or exists (
            select 1
            from "PedimosCuentaPedidoClaim" pc
            where pc."restauranteId" = c."restauranteId"
              and pc."usuarioId" = ${session.userId}
              and pc."orderId" = c."id"
          )
        )
      order by c."fechaCreacion" desc
      limit 50
    `);
    return reply.send({
      success: true,
      data: rows.map((row) => ({
        orderId: row.orderId,
        numeroComanda: row.numeroComanda,
        estado: row.estado,
        total: row.total,
        createdAt: row.fechaCreacion.toISOString()
      }))
    });
  });

  app.post("/api/public/account/claim-guest", async (request, reply) => {
    await ensureAccountTables();
    const session = await requireAccountSession(request);
    const body = accountClaimGuestSchema.parse(request.body ?? {});
    const sessionFp = guestSessionFingerprint(request);
    const now = new Date();

    const matchedByPhone = body.telefono
      ? await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          select c."id"
          from "Comanda" c
          inner join "Cliente" cl on cl."id" = c."clienteId"
          where c."restauranteId" = ${session.restauranteId}
            and cl."telefono" = ${body.telefono}
          order by c."fechaCreacion" desc
          limit 30
        `)
      : [];

    const explicitIds = body.orderIds ?? [];
    const set = new Set<string>([...matchedByPhone.map((row) => row.id), ...explicitIds]);
    if (!set.size) {
      return reply.send({ success: true, data: { linked: 0 } });
    }

    let linked = 0;
    for (const orderId of set) {
      await prisma.$executeRaw(
        Prisma.sql`
          insert into "PedimosCuentaPedidoClaim" (
            "id","restauranteId","usuarioId","orderId","source","createdAt"
          )
          values (
            ${randomUUID()},
            ${session.restauranteId},
            ${session.userId},
            ${orderId},
            ${sessionFp ? "session_fingerprint" : "manual"},
            ${now}
          )
          on conflict ("restauranteId","usuarioId","orderId") do nothing
        `
      );
      linked++;
    }
    return reply.send({
      success: true,
      data: { linked }
    });
  });

  app.post("/api/public/account/benefits/commission-free", async (request, reply) => {
    await ensureAccountTables();
    const session = await requireAccountSession(request);
    const secret = String(request.headers["x-internal-benefits-secret"] ?? "");
    if (!env.BENEFITS_GRANT_SECRET || secret !== env.BENEFITS_GRANT_SECRET) {
      throw canonicalError("invalid_api_key", "Operacion no autorizada");
    }
    const actor = await prisma.$queryRaw<
      Array<{ userId: string; restauranteId: string; isOwner: boolean; permisos: unknown }>
    >(Prisma.sql`
      select
        u."id" as "userId",
        u."restauranteId",
        coalesce(om."esOwner", false) as "isOwner",
        ro."permisos"
      from "Usuario" u
      left join "Restaurante" r on r."id" = u."restauranteId"
      left join "OrganizacionMiembro" om
        on om."usuarioId" = u."id"
        and om."organizacionId" = r."organizacionId"
        and om."activo" = true
      left join "Rol" ro on ro."id" = u."rolId"
      where u."id" = ${session.userId}
      limit 1
    `);
    const row = actor[0];
    const permissions = Array.isArray(row?.permisos) ? (row.permisos as string[]) : [];
    const canGrant = Boolean(row?.isOwner) || permissions.includes("*") || permissions.includes("settings.manage");
    if (!row || row.restauranteId !== session.restauranteId || !canGrant) {
      throw canonicalError("branch_scope_mismatch", "Sin permisos para otorgar beneficio");
    }

    await prisma.$executeRaw(
      Prisma.sql`
        insert into "PedimosCuentaPerfil" ("usuarioId","restauranteId","isCommissionFree","updatedAt")
        values (${session.userId}, ${session.restauranteId}, true, ${new Date()})
        on conflict ("usuarioId")
        do update set "isCommissionFree" = true, "updatedAt" = excluded."updatedAt"
      `
    );
    await prisma.$executeRaw(
      Prisma.sql`
        insert into "Auditoria" ("id","restauranteId","usuarioId","accion","entidad","entidadId","detalles","fechaAccion")
        values (
          ${randomUUID()},
          ${session.restauranteId},
          ${session.userId},
          'GRANT_COMMISSION_FREE',
          'PedimosCuentaPerfil',
          ${session.userId},
          ${JSON.stringify({ via: "account_endpoint" })}::jsonb,
          ${new Date()}
        )
      `
    );
    return reply.send({ success: true });
  });

  app.get("/api/public/account/reservations", async (request, reply) => {
    await ensureReservationsTable();
    const session = await requireAccountSession(request);
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        reservedFor: Date;
        durationMinutes: number;
        status: string;
        partySize: number;
        mesaId: string | null;
        notes: string | null;
      }>
    >(Prisma.sql`
      select "id", "reservedFor", "durationMinutes", "status", "partySize", "mesaId", "notes"
      from "Reservacion"
      where "restauranteId" = ${session.restauranteId}
        and "ownerUserId" = ${session.userId}
      order by "reservedFor" desc
      limit 50
    `);
    return reply.send({
      success: true,
      data: rows.map((row) => ({
        ...row,
        reservedFor: row.reservedFor.toISOString()
      }))
    });
  });

  app.post("/api/public/account/reservations", async (request, reply) => {
    await ensureReservationsTable();
    const session = await requireAccountSession(request);
    const body = z
      .object({
        partySize: z.coerce.number().int().min(1).max(30),
        reservedFor: z.string().datetime(),
        durationMinutes: z.coerce.number().int().min(30).max(360).default(90),
        notes: z.string().trim().max(300).optional()
      })
      .parse(request.body ?? {});
    const profile = await prisma.$queryRaw<Array<{ telefono: string | null }>>(Prisma.sql`
      select "telefono"
      from "PedimosCuentaPerfil"
      where "usuarioId" = ${session.userId}
      limit 1
    `);
    const user = await prisma.$queryRaw<Array<{ nombre: string; apellido: string; email: string }>>(Prisma.sql`
      select "nombre", "apellido", "email"
      from "Usuario"
      where "id" = ${session.userId}
      limit 1
    `);
    const me = user[0];
    if (!me) throw canonicalError("invalid_api_key", "Sesion de cuenta no valida");

    const reservationId = randomUUID();
    await prisma.$executeRaw(
      Prisma.sql`
        insert into "Reservacion" (
          "id","restauranteId","mesaId","ownerUserId","createdByUserId",
          "clienteNombre","clienteEmail","clienteTelefono","partySize",
          "reservedFor","durationMinutes","status","notes","createdAt","updatedAt"
        )
        values (
          ${reservationId},
          ${session.restauranteId},
          null,
          ${session.userId},
          ${session.userId},
          ${`${me.nombre} ${me.apellido}`.trim()},
          ${me.email},
          ${profile[0]?.telefono ?? null},
          ${body.partySize},
          ${new Date(body.reservedFor)},
          ${body.durationMinutes},
          'PENDIENTE',
          ${body.notes ?? null},
          ${new Date()},
          ${new Date()}
        )
      `
    );
    return reply.status(201).send({ success: true, data: { id: reservationId } });
  });

  app.delete("/api/public/account/reservations/:id", async (request, reply) => {
    await ensureReservationsTable();
    const session = await requireAccountSession(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params ?? {});
    await prisma.$executeRaw(
      Prisma.sql`
        update "Reservacion"
        set "status" = 'CANCELADA', "updatedAt" = ${new Date()}
        where "id" = ${id}
          and "restauranteId" = ${session.restauranteId}
          and "ownerUserId" = ${session.userId}
      `
    );
    return reply.send({ success: true });
  });

  app.get("/api/public/account/oauth/meta/start", async (request, reply) => {
    const slug = z.object({ slug: z.string().min(1) }).parse(request.query ?? {}).slug;
    if (!env.META_CLIENT_ID || !env.META_CLIENT_SECRET || !env.META_REDIRECT_URI) {
      return reply.status(200).send({
        success: false,
        code: "meta_unavailable",
        error: "Meta login no esta configurado"
      });
    }
    const state = Buffer.from(JSON.stringify({ slug, nonce: randomUUID() }), "utf8").toString("base64url");
    const url = new URL("https://www.facebook.com/v19.0/dialog/oauth");
    url.searchParams.set("client_id", env.META_CLIENT_ID);
    url.searchParams.set("redirect_uri", env.META_REDIRECT_URI);
    url.searchParams.set("scope", "email,public_profile");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return reply.send({ success: true, data: { authUrl: url.toString() } });
  });

  app.get("/api/public/account/oauth/meta/callback", async (request, reply) => {
    await ensureAccountTables();
    const query = z
      .object({
        code: z.string().min(1),
        state: z.string().min(1)
      })
      .parse(request.query ?? {});
    if (!env.META_CLIENT_ID || !env.META_CLIENT_SECRET || !env.META_REDIRECT_URI) {
      throw canonicalError("invalid_payload", "Meta login no esta configurado");
    }

    const parsedState = JSON.parse(Buffer.from(query.state, "base64url").toString("utf8")) as { slug: string };
    const tokenUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id", env.META_CLIENT_ID);
    tokenUrl.searchParams.set("client_secret", env.META_CLIENT_SECRET);
    tokenUrl.searchParams.set("redirect_uri", env.META_REDIRECT_URI);
    tokenUrl.searchParams.set("code", query.code);
    const tokenRes = await fetch(tokenUrl.toString());
    if (!tokenRes.ok) throw canonicalError("invalid_api_key", "No fue posible autenticar con Meta");
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    if (!tokenJson.access_token) throw canonicalError("invalid_api_key", "No fue posible autenticar con Meta");

    const meUrl = new URL("https://graph.facebook.com/me");
    meUrl.searchParams.set("fields", "id,name,email");
    meUrl.searchParams.set("access_token", tokenJson.access_token);
    const meRes = await fetch(meUrl.toString());
    if (!meRes.ok) throw canonicalError("invalid_api_key", "No fue posible leer perfil de Meta");
    const me = (await meRes.json()) as { email?: string; name?: string };
    if (!me.email || !me.name) throw canonicalError("invalid_payload", "Meta no devolvio email valido");

    const branchRows = await prisma.$queryRaw<Array<{ id: string; slug: string | null; activo: boolean }>>(Prisma.sql`
      select "id", "slug", "activo"
      from "Restaurante"
      where "slug" = ${parsedState.slug}
      limit 1
    `);
    const branch = branchRows[0];
    if (!branch || !branch.slug || !branch.activo) {
      throw canonicalError("branch_not_found", "Sucursal no valida");
    }

    const userRows = await prisma.$queryRaw<
      Array<{ id: string; email: string; restauranteId: string; restauranteSlug: string | null; password: string | null }>
    >(Prisma.sql`
      select u."id", u."email", u."restauranteId", r."slug" as "restauranteSlug", u."password"
      from "Usuario" u
      inner join "Restaurante" r on r."id" = u."restauranteId"
      where r."slug" = ${branch.slug}
        and lower(u."email") = lower(${me.email})
      limit 1
    `);

    let userId = userRows[0]?.id;
    if (!userId) {
      const role = await getOrCreateCustomerRole();
      const { nombre, apellido } = splitName(me.name);
      userId = randomUUID();
      await prisma.$executeRaw(
        Prisma.sql`
          insert into "Usuario" (
            "id","email","nombre","apellido","password","rolId","restauranteId",
            "activeRestauranteId","activeOrganizacionId","activo","createdAt","updatedAt"
          )
          values (
            ${userId}, ${me.email.toLowerCase()}, ${nombre}, ${apellido}, null,
            ${role.id}, ${branch.id}, ${branch.id}, null, true, ${new Date()}, ${new Date()}
          )
        `
      );
      await prisma.$executeRaw(
        Prisma.sql`
          insert into "SucursalMiembro" (
            "id","usuarioId","restauranteId","rolId","activo","esPrincipal","createdAt","updatedAt"
          )
          values (${randomUUID()}, ${userId}, ${branch.id}, ${role.id}, true, true, ${new Date()}, ${new Date()})
          on conflict ("usuarioId","restauranteId") do nothing
        `
      );
    }

    reply.header(
      "set-cookie",
      createAccountSessionCookie({
        userId,
        restauranteId: branch.id,
        restauranteSlug: branch.slug,
        email: me.email.toLowerCase()
      })
    );
    return reply.redirect("/");
  });
};
