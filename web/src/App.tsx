import { useEffect, useMemo, useState } from "react";
import { apiClient, type Branch, type MenuCatalog } from "./api/client";
import { cartState, type CartItem } from "./state/cart";

const randomExternalOrderId = (): string => `ext-${Date.now()}-${Math.floor(Math.random() * 9999)}`;

const asCurrency = (amount: number): string =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(amount);

const explainOrderStatus = (status: string | undefined): string => {
  if (!status) return "Estado no informado";
  switch (status) {
    case "SOLICITUD":
      return "Tu pedido quedó como solicitud. El equipo lo revisará en breve.";
    case "EN_COLA":
      return "Tu pedido entró a la cola por saturación. Se procesará por prioridad.";
    case "RECHAZADO":
      return "Tu solicitud fue rechazada.";
    case "PENDIENTE":
      return "Tu pedido fue aceptado y está pendiente de preparación.";
    default:
      return `Estado actual: ${status}`;
  }
};

/** Enlace directo: ?sucursal=mi-slug o ?slug=mi-slug (mismo valor que en ServimOS / API). */
function readSlugFromLocationSearch(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    return (params.get("sucursal") ?? params.get("slug") ?? "").trim();
  } catch {
    return "";
  }
}

const readIntegrationConfig = (): { slug: string } => {
  try {
    const raw = localStorage.getItem("pedimos.integration.v1");
    if (!raw) return { slug: "" };
    const parsed = JSON.parse(raw) as { slug?: string };
    return { slug: parsed.slug ?? "" };
  } catch {
    return { slug: "" };
  }
};

const writeIntegrationSlug = (slug: string): void => {
  try {
    localStorage.setItem("pedimos.integration.v1", JSON.stringify({ slug }));
  } catch {
    /* ignore */
  }
};

export function App() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchSlug, setSelectedBranchSlug] = useState("");
  const [menu, setMenu] = useState<MenuCatalog | null>(null);
  const [menuQuery, setMenuQuery] = useState("");
  const [menuDegraded, setMenuDegraded] = useState(false);
  const [menuError, setMenuError] = useState("");
  const [loadingMenu, setLoadingMenu] = useState(false);
  const [sessionReadySlug, setSessionReadySlug] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [customerFirstName, setCustomerFirstName] = useState("");
  const [customerLastName, setCustomerLastName] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [lastOrderId, setLastOrderId] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(randomExternalOrderId());
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uiNotice, setUiNotice] = useState("");
  const [manualSlugDraft, setManualSlugDraft] = useState("");
  const [linkError, setLinkError] = useState("");

  useEffect(() => {
    setCart(cartState.read());
    const urlSlugRaw = readSlugFromLocationSearch();
    const urlSlugNorm = urlSlugRaw.toLowerCase();

    void apiClient
      .getBranches()
      .then((loaded) => {
        setBranches(loaded);
        let chosen = "";

        if (urlSlugNorm) {
          const fromUrl = loaded.find((b) => b.slug.toLowerCase() === urlSlugNorm);
          if (fromUrl) {
            chosen = fromUrl.slug;
            writeIntegrationSlug(fromUrl.slug);
            setUiNotice(`Menú: ${fromUrl.nombre}`);
            try {
              const next = new URLSearchParams(window.location.search);
              next.set("sucursal", fromUrl.slug);
              next.delete("slug");
              const qs = next.toString();
              window.history.replaceState({}, "", qs ? `?${qs}` : window.location.pathname);
            } catch {
              /* ignore */
            }
          } else {
            setLinkError(
              `No hay sucursal con slug «${urlSlugRaw}». Pide el enlace correcto al restaurante o escribe el slug abajo.`
            );
          }
        }

        if (!chosen) {
          const cfg = readIntegrationConfig();
          if (cfg.slug) {
            const hit = loaded.find((b) => b.slug === cfg.slug);
            if (hit) chosen = hit.slug;
          }
        }

        setSelectedBranchSlug(chosen);
      })
      .catch(() => setBranches([]));
  }, []);

  useEffect(() => {
    setMenuQuery("");
  }, [selectedBranchSlug]);

  useEffect(() => {
    if (!selectedBranchSlug) return;
    setLinkError("");
    setSessionReadySlug("");
    setLoadingMenu(true);
    setMenuError("");
    setMenuDegraded(false);
    void apiClient
      .startPublicSession(selectedBranchSlug)
      .then(() => {
        setSessionReadySlug(selectedBranchSlug);
        return apiClient.getMenuBySlug(selectedBranchSlug);
      })
      .then(({ data, degraded }) => {
        setMenu(data);
        const isDegraded = Boolean(degraded);
        setMenuDegraded(isDegraded);
        if (isDegraded) {
          setMenuError("No pudimos cargar el menú completo. Intenta de nuevo en un momento.");
        } else {
          setMenuError("");
        }
      })
      .catch((error) => {
        setMenu(null);
        setMenuDegraded(false);
        setMenuError(error instanceof Error ? error.message : "No se pudo cargar el menú.");
      })
      .finally(() => {
        setLoadingMenu(false);
      });
  }, [selectedBranchSlug]);

  const total = useMemo(() => cart.reduce((acc, item) => acc + item.qty * item.unitPrice, 0), [cart]);
  const catalogProducts = menu?.productos ?? [];
  const visibleProducts = useMemo(() => {
    const term = menuQuery.trim().toLowerCase();
    if (!term) return catalogProducts;
    return catalogProducts.filter((product) => product.nombre.toLowerCase().includes(term));
  }, [catalogProducts, menuQuery]);
  const branchDisplayName = useMemo(() => {
    if (!selectedBranchSlug) return "";
    return (
      branches.find((b) => b.slug === selectedBranchSlug)?.nombre ??
      menu?.restaurante?.nombre ??
      selectedBranchSlug
    );
  }, [branches, menu?.restaurante?.nombre, selectedBranchSlug]);

  const applySlug = (raw: string): void => {
    const norm = raw.trim().toLowerCase();
    setLinkError("");
    if (!norm) {
      setLinkError("Escribe el slug de la sucursal (ej. principal).");
      return;
    }
    const hit = branches.find((b) => b.slug.toLowerCase() === norm);
    if (!hit) {
      setLinkError(`No encontramos «${raw.trim()}». Revisa el slug o vuelve a cargar la página.`);
      return;
    }
    writeIntegrationSlug(hit.slug);
    setSelectedBranchSlug(hit.slug);
    setUiNotice(`Menú: ${hit.nombre}`);
    try {
      const next = new URLSearchParams(window.location.search);
      next.set("sucursal", hit.slug);
      next.delete("slug");
      const qs = next.toString();
      window.history.replaceState({}, "", qs ? `?${qs}` : window.location.pathname);
    } catch {
      /* ignore */
    }
  };

  const getProductPrice = (product: (typeof visibleProducts)[number]): number => {
    const firstSize = product.tamanos?.[0];
    return firstSize?.precio ?? 38;
  };

  const addProduct = (productId: string, productName: string) => {
    const product = visibleProducts.find((item) => item.id === productId);
    const unitPrice = product ? getProductPrice(product) : 38;
    const next = cartState.add({
      id: `${productId}-${Date.now()}`,
      productId,
      name: productName,
      qty: 1,
      unitPrice
    });
    setCart(next);
    setUiNotice(`${productName} se agrego al pedido`);
  };

  const checkout = async () => {
    if (!selectedBranchSlug) {
      setStatusLog(["Indica la sucursal (enlace o slug) para continuar."]);
      return;
    }
    if (!cart.length) {
      setStatusLog(["Agrega productos al carrito."]);
      return;
    }
    const first = customerFirstName.trim();
    const last = customerLastName.trim();
    const addrTrim = customerAddress.trim();
    if (!first || !last || !addrTrim) {
      setStatusLog(["Completa nombre, apellido y dirección de entrega para confirmar."]);
      return;
    }

    const fullName = `${first} ${last}`.trim();

    setSubmitting(true);
    const currentIdempotency = idempotencyKey.trim() || randomExternalOrderId();
    try {
      const payload = {
        externalOrderId: currentIdempotency,
        tipoPedido: "DELIVERY" as const,
        canal: "EXTERNAL_APP" as const,
        cliente: {
          nombre: fullName,
          telefono: "sin telefono",
          direccion: addrTrim
        },
        items: cart.map((item) => ({
          productoId: item.productId,
          cantidad: item.qty,
          modificadores: []
        })),
      };

      let created: Record<string, unknown>;
      try {
        created = await apiClient.createOrder({
          restauranteSlug: selectedBranchSlug,
          idempotencyKey: currentIdempotency,
          payload,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        const saturated = message.includes("restaurant_saturated");
        if (!saturated) throw err;
        const confirmQueue = window.confirm(
          "El restaurante está saturado y tu pedido no entró directo a cocina.\n\n¿Quieres enviarlo a cola para que se prepare cuando haya capacidad?"
        );
        if (!confirmQueue) {
          setStatusLog([
            "Pedido cancelado por saturación.",
            "Si cambias de opinión, puedes intentarlo nuevamente y aceptar entrar en cola.",
          ]);
          return;
        }
        created = await apiClient.createOrder({
          restauranteSlug: selectedBranchSlug,
          idempotencyKey: currentIdempotency,
          payload: {
            ...payload,
            modoD: { acceptQueueWhenSaturated: true },
          },
        });
      }

      const maybeOrderId = (created as { data?: { orderId?: string } }).data?.orderId ?? "";
      const orderStatus = (created as { data?: { estado?: string } }).data?.estado;
      setLastOrderId(maybeOrderId);
      setStatusLog([
        "Pedido enviado correctamente.",
        explainOrderStatus(orderStatus),
        `Idempotency: ${currentIdempotency}`,
        JSON.stringify(created, null, 2),
        maybeOrderId ? `OrderId: ${maybeOrderId}` : "No se recibió orderId."
      ]);
      cartState.clear();
      setCart([]);
      setIdempotencyKey(randomExternalOrderId());
    } catch (error) {
      setStatusLog([error instanceof Error ? error.message : "Error al crear pedido."]);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="app-shell">
      <div className="bg-orbs" />
      <div className="layout-wide">
        <header className="top-nav">
          <div className="top-nav-header">
            <div className="brand-row">
              <div className="badge">PedimOS</div>
              <div>
                <strong className="brand-title">
                  {branchDisplayName || menu?.restaurante?.nombre || "Menú y pedido"}
                </strong>
                <p className="brand-subtitle">
                  Enlace directo: añade <code className="inline-code">?sucursal=slug-de-sucursal</code> a la URL
                </p>
              </div>
            </div>
            <div className="follow-chip">Pedidos a domicilio · Un menú por enlace o slug</div>
          </div>
          <div className="top-nav-branch-bar">
            {selectedBranchSlug ? (
              <span className="branch-context-label">
                En: <strong>{branchDisplayName}</strong>
              </span>
            ) : (
              <p className="muted branch-context-hint">Abre el menú con el enlace de tu sucursal o escribe el slug.</p>
            )}
          </div>
          {uiNotice ? <div className="ui-notice">{uiNotice}</div> : null}
        </header>

        <section className="panel">
          {!selectedBranchSlug ? (
            <>
              <div className="panel-head">
                <h2>Menú</h2>
                <span className="muted">Necesitamos saber qué sucursal</span>
              </div>
              {linkError ? <p className="menu-alert link-error">{linkError}</p> : null}
              <p className="muted menu-link-help">
                El restaurante puede compartirte un enlace como:{" "}
                <strong>
                  {typeof window !== "undefined" ? window.location.origin + window.location.pathname : ""}
                  ?sucursal=<em>tu-slug</em>
                </strong>
                . El slug es el mismo que usa la sucursal en ServimOS (ej. <code className="inline-code">principal</code>
                ).
              </p>
              <div className="manual-slug-card">
                <label htmlFor="manual-slug">Slug de la sucursal</label>
                <div className="manual-slug-row">
                  <input
                    id="manual-slug"
                    className="search"
                    value={manualSlugDraft}
                    onChange={(e) => setManualSlugDraft(e.target.value)}
                    placeholder="ej. principal"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="primary"
                    disabled={!branches.length}
                    onClick={() => applySlug(manualSlugDraft)}
                  >
                    Ver menú
                  </button>
                </div>
                {!branches.length ? (
                  <p className="muted">No se pudieron cargar las sucursales. Revisa la conexión o vuelve más tarde.</p>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="panel-head menu-panel-head">
                <div>
                  <h2>Menú</h2>
                  <span className="muted">
                    {loadingMenu ? "Cargando..." : `${visibleProducts.length} productos mostrados`}
                    {!loadingMenu && catalogProducts.length !== visibleProducts.length && menuQuery.trim()
                      ? ` · ${catalogProducts.length} en la carta`
                      : null}
                  </span>
                </div>
                <input
                  className="search menu-search"
                  value={menuQuery}
                  onChange={(event) => setMenuQuery(event.target.value)}
                  placeholder="Buscar en el menú..."
                />
              </div>
              <p className="muted session-line">Sesión: {sessionReadySlug || "sin sesión activa"}</p>
              {lastOrderId ? (
                <div className="last-order-banner">
                  <p className="muted">
                    <strong>Último pedido:</strong> {lastOrderId}
                  </p>
                </div>
              ) : null}
              {menuError ? <p className="muted menu-alert">{menuError}</p> : null}
              {!loadingMenu && catalogProducts.length === 0 && !menuDegraded && !menuError ? (
                <p className="muted">Este local aún no tiene productos activos en la carta.</p>
              ) : null}
              {!loadingMenu &&
              catalogProducts.length > 0 &&
              visibleProducts.length === 0 &&
              menuQuery.trim() ? (
                <p className="muted">
                  Ningún producto coincide con tu búsqueda. Prueba otro término o borra el filtro del menú.
                </p>
              ) : null}
              <div className="products-grid-lite">
                {visibleProducts.map((product) => (
                  <article key={product.id} className="product-focus">
                    <img
                      src={product.imageUrl || "https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?q=80&w=1200"}
                      alt={product.nombre}
                    />
                    <h3>{product.nombre}</h3>
                    <p className="muted">Desde {asCurrency(getProductPrice(product))}</p>
                    <button type="button" onClick={() => addProduct(product.id, product.nombre)}>
                      Agregar
                    </button>
                  </article>
                ))}
              </div>

              <div className="menu-cart-block">
                <h3 className="pedido-subtitle">Tu carrito</h3>
                <div className="cart-items">
                  {cart.length === 0 ? <p className="muted">Aún no hay productos.</p> : null}
                  {cart.map((item) => (
                    <div key={item.id} className="cart-item">
                      <div>
                        <strong>{item.name}</strong>
                        <p>Cantidad {item.qty}</p>
                      </div>
                      <span>{asCurrency(item.qty * item.unitPrice)}</span>
                    </div>
                  ))}
                </div>
                <div className="total">Total {asCurrency(total)}</div>

                {cart.length > 0 ? (
                  <div className="delivery-confirm-card">
                    <h4 className="pedido-subtitle">Datos de entrega</h4>
                    <p className="muted confirm-hint">Nombre, apellido y dirección donde llevamos tu pedido.</p>
                    <label>Nombre</label>
                    <input
                      value={customerFirstName}
                      onChange={(event) => setCustomerFirstName(event.target.value)}
                      placeholder="Ej. María"
                      autoComplete="given-name"
                    />
                    <label>Apellido</label>
                    <input
                      value={customerLastName}
                      onChange={(event) => setCustomerLastName(event.target.value)}
                      placeholder="Ej. López"
                      autoComplete="family-name"
                    />
                    <label>Dirección</label>
                    <input
                      value={customerAddress}
                      onChange={(event) => setCustomerAddress(event.target.value)}
                      placeholder="Calle, número, colonia, referencias"
                      autoComplete="street-address"
                    />
                  </div>
                ) : null}

                <details className="pedido-advanced">
                  <summary>Avanzado (idempotency)</summary>
                  <label>Idempotency key</label>
                  <input value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} />
                </details>

                <div className="actions">
                  <button type="button" className="secondary" onClick={() => setCart(cartState.read())}>
                    Refrescar carrito
                  </button>
                  <button type="button" className="primary" disabled={submitting} onClick={checkout}>
                    {submitting ? "Enviando..." : "Confirmar pedido"}
                  </button>
                </div>
                <pre className="log">{statusLog.join("\n")}</pre>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
