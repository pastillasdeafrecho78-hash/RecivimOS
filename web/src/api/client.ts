export type Branch = {
  id: string;
  slug: string;
  nombre: string;
};

export type MenuCatalog = {
  restaurante: Branch;
  productos: Array<{ id: string; nombre: string; imageUrl?: string | null }>;
  tamanos: Array<{ id: string; nombre: string }>;
  modificadores: Array<{ id: string; nombre: string }>;
};

export type CreateOrderPayload = {
  externalOrderId: string;
  tipoPedido: "LOCAL" | "DOMICILIO" | "DELIVERY";
  canal: "EXTERNAL_APP";
  notas?: string;
  cliente?: { nombre: string; telefono: string; direccion: string };
  items: Array<{
    productoId: string;
    tamanoId?: string;
    cantidad: number;
    notas?: string;
    modificadores: Array<{ modificadorId: string }>;
  }>;
  modoD?: {
    acceptQueueWhenSaturated?: boolean;
  };
};

export type AccountMe = {
  userId: string;
  email: string;
  nombreCompleto: string;
  telefono?: string | null;
  restaurante: { id: string; slug: string; nombre: string };
  isCommissionFree: boolean;
};

const parseJson = async <T>(response: Response): Promise<T> => {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const typed = json as { error?: string; code?: string };
    const message = typed.error ?? `HTTP ${response.status}`;
    const code = typed.code ? ` (${typed.code})` : "";
    throw new Error(`${message}${code}`);
  }
  return json as T;
};

export const apiClient = {
  async startPublicSession(slug: string): Promise<void> {
    const response = await fetch("/api/public/integraciones/pedidos/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug })
    });
    await parseJson<Record<string, unknown>>(response);
  },

  async getBranches(): Promise<Branch[]> {
    const response = await fetch("/api/public/integraciones/pedidos/restaurantes");
    const json = await parseJson<{ data: Branch[] }>(response);
    return json.data ?? [];
  },

  async getMenuBySlug(slug: string): Promise<{ data: MenuCatalog; degraded?: boolean }> {
    const response = await fetch(`/api/public/integraciones/pedidos/menu/${encodeURIComponent(slug)}`);
    const json = await parseJson<{ data: MenuCatalog; degraded?: boolean }>(response);
    return { data: json.data, degraded: json.degraded };
  },

  async createOrder(input: {
    restauranteSlug: string;
    idempotencyKey: string;
    payload: CreateOrderPayload;
  }): Promise<Record<string, unknown>> {
    const response = await fetch("/api/public/integraciones/pedidos/orders", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-restaurante-slug": input.restauranteSlug,
        "x-idempotency-key": input.idempotencyKey
      },
      body: JSON.stringify(input.payload)
    });
    return parseJson<Record<string, unknown>>(response);
  },

  async getOrderStatus(input: {
    restauranteSlug: string;
    orderId: string;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>> {
    const response = await fetch(`/api/public/integraciones/pedidos/orders/${encodeURIComponent(input.orderId)}`, {
      headers: {
        "x-restaurante-slug": input.restauranteSlug,
        "x-idempotency-key": input.idempotencyKey
      }
    });
    return parseJson<Record<string, unknown>>(response);
  },

  async accountRegister(input: {
    slug: string;
    email: string;
    password: string;
    nombreCompleto: string;
    telefono?: string;
  }): Promise<Record<string, unknown>> {
    const response = await fetch("/api/public/account/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    return parseJson<Record<string, unknown>>(response);
  },

  async accountLogin(input: { slug: string; email: string; password: string }): Promise<Record<string, unknown>> {
    const response = await fetch("/api/public/account/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    return parseJson<Record<string, unknown>>(response);
  },

  async accountLogout(): Promise<void> {
    const response = await fetch("/api/public/account/logout", { method: "POST" });
    await parseJson<Record<string, unknown>>(response);
  },

  async accountMe(): Promise<AccountMe> {
    const response = await fetch("/api/public/account/me");
    const json = await parseJson<{ data: AccountMe }>(response);
    return json.data;
  },

  async accountUpdate(input: { nombreCompleto?: string; telefono?: string }): Promise<void> {
    const response = await fetch("/api/public/account/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    await parseJson<Record<string, unknown>>(response);
  },

  async accountOrders(): Promise<Array<{ orderId: string; numeroComanda: string; estado: string; total: number; createdAt: string }>> {
    const response = await fetch("/api/public/account/orders");
    const json = await parseJson<{
      data: Array<{ orderId: string; numeroComanda: string; estado: string; total: number; createdAt: string }>;
    }>(response);
    return json.data ?? [];
  },

  async accountClaimGuest(input: { telefono?: string; orderIds?: string[] }): Promise<number> {
    const response = await fetch("/api/public/account/claim-guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    const json = await parseJson<{ data?: { linked?: number } }>(response);
    return json.data?.linked ?? 0;
  },

  async metaStart(slug: string): Promise<string | null> {
    const response = await fetch(`/api/public/account/oauth/meta/start?slug=${encodeURIComponent(slug)}`);
    const json = await parseJson<{ success?: boolean; data?: { authUrl?: string } }>(response);
    return json.data?.authUrl ?? null;
  },

  async accountReservations(): Promise<
    Array<{ id: string; reservedFor: string; durationMinutes: number; status: string; partySize: number; notes?: string | null }>
  > {
    const response = await fetch("/api/public/account/reservations");
    const json = await parseJson<{
      data: Array<{ id: string; reservedFor: string; durationMinutes: number; status: string; partySize: number; notes?: string | null }>;
    }>(response);
    return json.data ?? [];
  },

  async createAccountReservation(input: {
    partySize: number;
    reservedFor: string;
    durationMinutes: number;
    notes?: string;
  }): Promise<string> {
    const response = await fetch("/api/public/account/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    const json = await parseJson<{ data?: { id?: string } }>(response);
    return json.data?.id ?? "";
  },

  async cancelAccountReservation(id: string): Promise<void> {
    const response = await fetch(`/api/public/account/reservations/${encodeURIComponent(id)}`, { method: "DELETE" });
    await parseJson<Record<string, unknown>>(response);
  }
};
