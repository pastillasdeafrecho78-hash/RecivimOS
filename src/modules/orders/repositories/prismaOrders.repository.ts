import { PrismaClient, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type {
  ApiKeyRecord,
  CreateOrderParams,
  CreatedOrderRecord,
  IdempotencyRecord,
  OrdersRepository,
  PublicCatalogRecord,
  PublicRestauranteRecord,
  ProductScopeRecord,
  RestauranteRecord
} from "./orders.repository.js";
import { externalOrderActorEmail } from "../lib/externalOrderActorEmail.js";

const mapRestaurante = (row: {
  id: string;
  slug: string;
  nombre: string;
  isActive: boolean;
  isSuspended: boolean;
}): RestauranteRecord => row;

const mapApiKey = (row: {
  id: string;
  restauranteId: string;
  keyHash: string;
  isActive: boolean;
  scopes: ("orders_create" | "orders_read")[];
}): ApiKeyRecord => ({
  ...row,
  scopes: row.scopes.map((scope) => (scope === "orders_create" ? "orders:create" : "orders:read"))
});

const mapScopeEntity = (row: { id: string; restauranteId: string; isActive: boolean }): ProductScopeRecord => row;

const mapOrder = (row: {
  id: string;
  restauranteId: string;
  numeroComanda: string | number;
  estado: CreatedOrderRecord["estado"];
  createdAt: Date | string;
  restauranteSlug: string;
}): CreatedOrderRecord => ({
  id: row.id,
  restauranteId: row.restauranteId,
  restauranteSlug: row.restauranteSlug,
  numeroComanda:
    typeof row.numeroComanda === "number"
      ? row.numeroComanda
      : Number.parseInt(String(row.numeroComanda).replace(/[^\d]/g, ""), 10) || 0,
  estado: row.estado,
  createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)
});

const mapIdempotency = (row: {
  id: string;
  idempotencyKey: string;
  restauranteId: string;
  apiKeyId: string;
  payloadHash: string;
  status: string;
  responseSnapshot: unknown;
  expiresAt: Date;
  createdAt: Date;
}): IdempotencyRecord => ({
  ...row,
  status: row.status === "completed" ? "completed" : "processing",
  responseSnapshot: row.responseSnapshot ?? null
});

export class PrismaOrdersRepository implements OrdersRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listActiveRestaurantes(): Promise<PublicRestauranteRecord[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; slug: string | null; nombre: string }>>(Prisma.sql`
      select "id", "slug", "nombre"
      from "Restaurante"
      where "activo" = true
        and "slug" is not null
        and length(trim("slug")) > 0
      order by "nombre" asc
    `);
    return rows.map((row) => ({ id: row.id, slug: row.slug ?? "", nombre: row.nombre })).filter((row) => row.slug.length > 0);
  }

  async getPublicCatalogByRestauranteSlug(slug: string): Promise<PublicCatalogRecord | null> {
    const restaurante = await this.findRestauranteBySlug(slug);
    if (!restaurante || !restaurante.isActive || restaurante.isSuspended) {
      return null;
    }

    const [productos, tamanos, modificadores] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string; nombre: string; imageUrl: string | null }>>(Prisma.sql`
        select p."id", p."nombre", p."imagenUrl" as "imageUrl"
        from "Producto" p
        inner join "Categoria" c on c."id" = p."categoriaId"
        where c."restauranteId" = ${restaurante.id}
          and c."activa" = true
          and p."activo" = true
        order by p."nombre" asc
      `),
      this.prisma.$queryRaw<Array<{ id: string; nombre: string }>>(Prisma.sql`
        select distinct t."id", t."nombre"
        from "ProductoTamano" t
        inner join "Producto" p on p."id" = t."productoId"
        inner join "Categoria" c on c."id" = p."categoriaId"
        where c."restauranteId" = ${restaurante.id}
          and c."activa" = true
          and p."activo" = true
        order by t."nombre" asc
      `),
      this.prisma.$queryRaw<Array<{ id: string; nombre: string }>>(Prisma.sql`
        select m."id", m."nombre"
        from "Modificador" m
        where m."restauranteId" = ${restaurante.id}
          and m."activo" = true
        order by m."nombre" asc
      `)
    ]);

    return {
      restaurante: { id: restaurante.id, slug: restaurante.slug, nombre: restaurante.nombre },
      productos: productos.map((p) => ({ id: p.id, nombre: p.nombre, imageUrl: p.imageUrl })),
      tamanos,
      modificadores
    };
  }

  async findRestauranteBySlug(slug: string): Promise<RestauranteRecord | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; slug: string | null; nombre: string; isActive: boolean }>
    >(Prisma.sql`
      select "id", "slug", "nombre", "activo" as "isActive"
      from "Restaurante"
      where "slug" = ${slug}
      limit 1
    `);
    const row = rows[0];
    if (!row || !row.slug) return null;
    return mapRestaurante({
      id: row.id,
      slug: row.slug,
      nombre: row.nombre,
      isActive: row.isActive,
      isSuspended: false
    });
  }

  async findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; restauranteId: string; keyHash: string; isActive: boolean }>
    >(Prisma.sql`
      select "id", "restauranteId", "apiKeyHash" as "keyHash", "activo" as "isActive"
      from "IntegracionPedidosApi"
      where "apiKeyHash" = ${hash}
      limit 1
    `);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      restauranteId: row.restauranteId,
      keyHash: row.keyHash,
      isActive: row.isActive,
      scopes: ["orders:create", "orders:read"]
    };
  }

  async findAnyActiveApiKeyForRestaurante(restauranteId: string): Promise<ApiKeyRecord | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; restauranteId: string; keyHash: string; isActive: boolean }>
    >(Prisma.sql`
      select "id", "restauranteId", "apiKeyHash" as "keyHash", "activo" as "isActive"
      from "IntegracionPedidosApi"
      where "restauranteId" = ${restauranteId}
        and "activo" = true
      limit 1
    `);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      restauranteId: row.restauranteId,
      keyHash: row.keyHash,
      isActive: row.isActive,
      scopes: ["orders:create", "orders:read"]
    };
  }

  async findProductsByIds(productIds: string[]): Promise<ProductScopeRecord[]> {
    if (!productIds.length) return [];
    const rows = await this.prisma.$queryRaw<Array<{ id: string; restauranteId: string; isActive: boolean }>>(Prisma.sql`
      select p."id", c."restauranteId", p."activo" as "isActive"
      from "Producto" p
      inner join "Categoria" c on c."id" = p."categoriaId"
      where p."id" in (${Prisma.join(productIds)})
    `);
    return rows.map(mapScopeEntity);
  }

  async findTamanosByIds(tamanoIds: string[]): Promise<ProductScopeRecord[]> {
    if (!tamanoIds.length) return [];
    const rows = await this.prisma.$queryRaw<Array<{ id: string; restauranteId: string; isActive: boolean }>>(Prisma.sql`
      select t."id", c."restauranteId", p."activo" as "isActive"
      from "ProductoTamano" t
      inner join "Producto" p on p."id" = t."productoId"
      inner join "Categoria" c on c."id" = p."categoriaId"
      where t."id" in (${Prisma.join(tamanoIds)})
    `);
    return rows.map(mapScopeEntity);
  }

  async findModificadoresByIds(modificadorIds: string[]): Promise<ProductScopeRecord[]> {
    if (!modificadorIds.length) return [];
    const rows = await this.prisma.$queryRaw<Array<{ id: string; restauranteId: string; isActive: boolean }>>(Prisma.sql`
      select "id", "restauranteId", "activo" as "isActive"
      from "Modificador"
      where "id" in (${Prisma.join(modificadorIds)})
    `);
    return rows.map(mapScopeEntity);
  }

  async findOrderByExternalId(restauranteId: string, externalOrderId: string): Promise<CreatedOrderRecord | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        restauranteId: string;
        numeroComanda: string;
        estado: CreatedOrderRecord["estado"];
        createdAt: Date;
        restauranteSlug: string;
      }>
    >(Prisma.sql`
      select c."id", c."restauranteId", c."numeroComanda", c."estado", c."fechaCreacion" as "createdAt", r."slug" as "restauranteSlug"
      from "Comanda" c
      inner join "Restaurante" r on r."id" = c."restauranteId"
      where c."restauranteId" = ${restauranteId}
        and c."externalOrderId" = ${externalOrderId}
      limit 1
    `);
    const row = rows[0];
    return row ? mapOrder(row) : null;
  }

  async getNextNumeroComanda(restauranteId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ next: bigint | number | string }>>(Prisma.sql`
      select coalesce(max(nullif(regexp_replace("numeroComanda", '[^0-9]', '', 'g'), '')::bigint), 0) + 1 as next
      from "Comanda"
    `);
    const nextRaw = rows[0]?.next;
    return nextRaw ? Number(nextRaw) : 1;
  }

  async createOrder(params: CreateOrderParams): Promise<CreatedOrderRecord> {
    return this.prisma.$transaction(async (tx) => {
      let createdById = params.createdByUserId;
      if (createdById) {
        const scoped = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          select "id"
          from "Usuario"
          where "id" = ${createdById}
            and "restauranteId" = ${params.restaurante.id}
            and "activo" = true
          limit 1
        `);
        createdById = scoped[0]?.id;
      }
      if (!createdById) {
        const integrationEmail = externalOrderActorEmail(params.restaurante.id);
        const integrationRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          select "id"
          from "Usuario"
          where "restauranteId" = ${params.restaurante.id}
            and "email" = ${integrationEmail}
            and "activo" = true
          limit 1
        `);
        createdById = integrationRows[0]?.id;
      }
      if (!createdById) {
        const userRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          select "id"
          from "Usuario"
          where "restauranteId" = ${params.restaurante.id}
            and "activo" = true
          order by "createdAt" asc
          limit 1
        `);
        createdById = userRows[0]?.id;
      }
      if (!createdById) {
        throw new Error("No hay usuario activo para crear comandas en esta sucursal");
      }

      const nextNumeroRows = await tx.$queryRaw<Array<{ next: bigint | number | string }>>(Prisma.sql`
        select coalesce(max(nullif(regexp_replace("numeroComanda", '[^0-9]', '', 'g'), '')::bigint), 0) + 1 as next
        from "Comanda"
      `);
      const nextNumero = nextNumeroRows[0]?.next ? Number(nextNumeroRows[0].next) : 1;
      const now = new Date();

      let clienteId: string | null = null;
      if (params.payload.cliente?.nombre) {
        clienteId = randomUUID();
        await tx.$executeRaw(
          Prisma.sql`
            insert into "Cliente" ("id", "nombre", "telefono", "direccion", "notas", "createdAt", "updatedAt", "restauranteId")
            values (
              ${clienteId},
              ${params.payload.cliente.nombre},
              ${params.payload.cliente.telefono ?? null},
              ${params.payload.cliente.direccion ?? null},
              ${params.payload.notas ?? null},
              ${now},
              ${now},
              ${params.restaurante.id}
            )
          `
        );
      }

      const comandaId = randomUUID();
      const tipoPedido =
        params.payload.tipoPedido === "LOCAL"
          ? "EN_MESA"
          : params.payload.tipoPedido === "DOMICILIO"
            ? "A_DOMICILIO"
            : "WHATSAPP";

      await tx.$executeRaw(
        Prisma.sql`
          insert into "Comanda" (
            "id",
            "numeroComanda",
            "clienteId",
            "tipoPedido",
            "estado",
            "total",
            "observaciones",
            "fechaCreacion",
            "creadoPorId",
            "restauranteId",
            "origen",
            "externalOrderId",
            "externalSource"
          )
          values (
            ${comandaId},
            ${String(nextNumero)},
            ${clienteId},
            ${tipoPedido}::"TipoPedido",
            'PENDIENTE'::"EstadoComanda",
            0,
            ${params.payload.notas ?? null},
            ${now},
            ${createdById},
            ${params.restaurante.id},
            'EXTERNAL_API'::"OrigenComanda",
            ${params.payload.externalOrderId},
            ${params.payload.canal}
          )
        `
      );

      let total = 0;
      for (const item of params.payload.items) {
        const productRows = await tx.$queryRaw<
          Array<{ id: string; precio: number; categoriaTipo: string | null }>
        >(Prisma.sql`
          select p."id", p."precio", c."tipo"::text as "categoriaTipo"
          from "Producto" p
          inner join "Categoria" c on c."id" = p."categoriaId"
          where p."id" = ${item.productoId}
            and p."activo" = true
            and c."activa" = true
            and c."restauranteId" = ${params.restaurante.id}
          limit 1
        `);
        const product = productRows[0];
        if (!product) {
          throw new Error(`Producto fuera de alcance: ${item.productoId}`);
        }

        let unitPrice = product.precio;
        if (item.tamanoId) {
          const tamanoRows = await tx.$queryRaw<Array<{ precio: number }>>(Prisma.sql`
            select t."precio"
            from "ProductoTamano" t
            where t."id" = ${item.tamanoId}
              and t."productoId" = ${item.productoId}
            limit 1
          `);
          if (tamanoRows[0]) {
            unitPrice = tamanoRows[0].precio;
          }
        }

        const destino = product.categoriaTipo === "BEBIDA" ? "BARRA" : "COCINA";
        const subtotal = unitPrice * item.cantidad;
        total += subtotal;

        const comandaItemId = randomUUID();
        await tx.$executeRaw(
          Prisma.sql`
            insert into "ComandaItem" (
              "id",
              "comandaId",
              "productoId",
              "tamanoId",
              "cantidad",
              "precioUnitario",
              "subtotal",
              "notas",
              "estado",
              "destino",
              "createdAt",
              "updatedAt"
            )
            values (
              ${comandaItemId},
              ${comandaId},
              ${item.productoId},
              ${item.tamanoId ?? null},
              ${item.cantidad},
              ${unitPrice},
              ${subtotal},
              ${item.notas ?? null},
              'PENDIENTE'::"EstadoItem",
              ${destino}::"DestinoItem",
              ${now},
              ${now}
            )
          `
        );

        for (const mod of item.modificadores ?? []) {
          const modRows = await tx.$queryRaw<Array<{ precioExtra: number | null }>>(Prisma.sql`
            select m."precioExtra"
            from "Modificador" m
            where m."id" = ${mod.modificadorId}
              and m."activo" = true
              and m."restauranteId" = ${params.restaurante.id}
            limit 1
          `);
          if (!modRows[0]) continue;
          const precioExtra = modRows[0].precioExtra ?? 0;
          total += precioExtra * item.cantidad;
          await tx.$executeRaw(
            Prisma.sql`
              insert into "ItemModificador" ("id", "comandaItemId", "modificadorId", "precioExtra")
              values (${randomUUID()}, ${comandaItemId}, ${mod.modificadorId}, ${precioExtra})
            `
          );
        }
      }

      await tx.$executeRaw(
        Prisma.sql`
          update "Comanda"
          set "total" = ${total}
          where "id" = ${comandaId}
        `
      );

      return {
        id: comandaId,
        restauranteId: params.restaurante.id,
        restauranteSlug: params.restaurante.slug,
        numeroComanda: nextNumero,
        estado: "PENDIENTE",
        createdAt: now
      };
    });
  }

  async findIdempotencyKey(restauranteId: string, key: string): Promise<IdempotencyRecord | null> {
    const row = await this.prisma.externalIdempotencyKey.findUnique({
      where: { idempotencyKey_restauranteId: { idempotencyKey: key, restauranteId } }
    });
    return row ? mapIdempotency(row) : null;
  }

  async createIdempotencyKey(input: {
    idempotencyKey: string;
    restauranteId: string;
    apiKeyId: string;
    payloadHash: string;
    status: "processing" | "completed";
    expiresAt: Date;
  }): Promise<IdempotencyRecord> {
    const row = await this.prisma.externalIdempotencyKey.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        restauranteId: input.restauranteId,
        apiKeyId: input.apiKeyId,
        payloadHash: input.payloadHash,
        status: input.status,
        expiresAt: input.expiresAt
      }
    });
    return mapIdempotency(row);
  }

  async updateIdempotencyKey(input: { id: string; status: "processing" | "completed"; responseSnapshot: unknown }): Promise<void> {
    await this.prisma.externalIdempotencyKey.update({
      where: { id: input.id },
      data: {
        status: input.status,
        responseSnapshot: input.responseSnapshot as Prisma.InputJsonValue
      }
    });
  }

  async findOrderById(orderId: string): Promise<CreatedOrderRecord | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        restauranteId: string;
        numeroComanda: string;
        estado: CreatedOrderRecord["estado"];
        createdAt: Date;
        restauranteSlug: string;
      }>
    >(Prisma.sql`
      select c."id", c."restauranteId", c."numeroComanda", c."estado", c."fechaCreacion" as "createdAt", r."slug" as "restauranteSlug"
      from "Comanda" c
      inner join "Restaurante" r on r."id" = c."restauranteId"
      where c."id" = ${orderId}
      limit 1
    `);
    const row = rows[0];
    return row ? mapOrder(row) : null;
  }
}
