import { z } from "zod";

export const externalOrderHeadersSchema = z.object({
  "x-api-key": z.string().min(1),
  "x-restaurante-slug": z.string().min(1),
  "x-idempotency-key": z.string().min(1),
  "x-api-version": z.string().optional(),
  "x-correlation-id": z.string().optional()
});

const modifierSchema = z.object({
  modificadorId: z.string().min(1)
});

const itemSchema = z.object({
  productoId: z.string().min(1),
  tamanoId: z.string().min(1).optional(),
  cantidad: z.number().int().positive(),
  notas: z.string().max(400).optional(),
  modificadores: z.array(modifierSchema).default([])
});

export const createExternalOrderBodySchema = z.object({
  externalOrderId: z.string().min(1).max(80),
  tipoPedido: z.enum(["LOCAL", "DOMICILIO", "DELIVERY"]),
  canal: z.literal("EXTERNAL_APP"),
  catalogVersion: z.string().optional(),
  cliente: z
    .object({
      nombre: z.string().min(1),
      telefono: z.string().min(1),
      direccion: z.string().min(1)
    })
    .optional(),
  notas: z.string().max(400).optional(),
  items: z.array(itemSchema).min(1),
  deliveryMetadata: z
    .object({
      mode: z.string().optional(),
      driverRef: z.string().optional(),
      vehicleNote: z.string().optional()
    })
    .optional()
});

export type ExternalOrderHeaders = z.infer<typeof externalOrderHeadersSchema>;
export type CreateExternalOrderBody = z.infer<typeof createExternalOrderBodySchema>;

export type CreateExternalOrderSuccess = {
  success: true;
  data: {
    orderId: string;
    numeroComanda: number;
    restauranteId: string;
    restauranteSlug: string;
    estado:
      | "SOLICITUD"
      | "EN_COLA"
      | "RECHAZADO"
      | "PENDIENTE"
      | "EN_PREPARACION"
      | "LISTO"
      | "SERVIDO"
      | "PAGADO"
      | "CANCELADO";
    origen: "EXTERNAL_API";
    idempotent: boolean;
    createdAt: string;
  };
};
