import { useEffect, useMemo, useState } from "react";
import { apiClient, type Branch, type MenuCatalog } from "./api/client";
import { cartState, type CartItem } from "./state/cart";

const randomExternalOrderId = (): string => `ext-${Date.now()}-${Math.floor(Math.random() * 9999)}`;

const asCurrency = (amount: number): string =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(amount);

const readIntegrationConfig = (): { apiKey: string; slug: string } => {
  try {
    const raw = localStorage.getItem("pedimos.integration.v1");
    if (!raw) return { apiKey: "", slug: "" };
    const parsed = JSON.parse(raw) as { apiKey?: string; slug?: string };
    return { apiKey: parsed.apiKey ?? "", slug: parsed.slug ?? "" };
  } catch {
    return { apiKey: "", slug: "" };
  }
};

export function App() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchSlug, setSelectedBranchSlug] = useState("");
  const [menu, setMenu] = useState<MenuCatalog | null>(null);
  const [menuError, setMenuError] = useState("");
  const [loadingMenu, setLoadingMenu] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [lastOrderId, setLastOrderId] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(randomExternalOrderId());
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const [statusTimeline, setStatusTimeline] = useState<Array<{ at: string; status: string }>>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const cfg = readIntegrationConfig();
    setApiKey(cfg.apiKey);
    setSelectedBranchSlug(cfg.slug);
    setCart(cartState.read());
    void apiClient
      .getBranches()
      .then(setBranches)
      .catch(() => setBranches([]));
  }, []);

  useEffect(() => {
    if (!selectedBranchSlug) return;
    setLoadingMenu(true);
    setMenuError("");
    void apiClient
      .getMenuBySlug(selectedBranchSlug)
      .then(({ data, degraded }) => {
        setMenu(data);
        if (degraded) {
          setMenuError("El menu está en modo degradado. Verifica configuración de sucursal.");
        }
      })
      .catch((error) => {
        setMenu(null);
        setMenuError(error instanceof Error ? error.message : "No se pudo cargar menu.");
      })
      .finally(() => setLoadingMenu(false));
  }, [selectedBranchSlug]);

  const total = useMemo(() => cart.reduce((acc, item) => acc + item.qty * item.unitPrice, 0), [cart]);

  const addProduct = (productId: string, productName: string) => {
    const next = cartState.add({
      id: `${productId}-${Date.now()}`,
      productId,
      name: productName,
      qty: 1,
      unitPrice: 38
    });
    setCart(next);
  };

  const checkout = async () => {
    if (!apiKey.trim()) {
      setStatusLog(["Configura x-api-key para continuar."]);
      return;
    }
    if (!selectedBranchSlug) {
      setStatusLog(["Selecciona sucursal para continuar."]);
      return;
    }
    if (!cart.length) {
      setStatusLog(["Agrega productos al carrito."]);
      return;
    }

    setSubmitting(true);
    const currentIdempotency = idempotencyKey.trim() || randomExternalOrderId();
    try {
      const payload = {
        externalOrderId: currentIdempotency,
        tipoPedido: "DELIVERY" as const,
        canal: "EXTERNAL_APP" as const,
        cliente:
          customerName && customerPhone && customerAddress
            ? { nombre: customerName, telefono: customerPhone, direccion: customerAddress }
            : undefined,
        items: cart.map((item) => ({
          productoId: item.productId,
          cantidad: item.qty,
          modificadores: []
        }))
      };

      const created = await apiClient.createOrder({
        apiKey: apiKey.trim(),
        restauranteSlug: selectedBranchSlug,
        idempotencyKey: currentIdempotency,
        payload
      });

      const maybeOrderId = (created as { data?: { orderId?: string } }).data?.orderId ?? "";
      setLastOrderId(maybeOrderId);
      setStatusLog([
        "Pedido creado correctamente.",
        `Idempotency: ${currentIdempotency}`,
        JSON.stringify(created, null, 2),
        maybeOrderId ? `OrderId: ${maybeOrderId}` : "No se recibió orderId."
      ]);
      setStatusTimeline([]);
      cartState.clear();
      setCart([]);
      setIdempotencyKey(randomExternalOrderId());
    } catch (error) {
      setStatusLog([error instanceof Error ? error.message : "Error al crear pedido."]);
    } finally {
      setSubmitting(false);
    }
  };

  const pollStatus = async () => {
    if (!lastOrderId) {
      setStatusLog(["No hay orderId para consultar."]);
      return;
    }
    if (!apiKey.trim() || !selectedBranchSlug) {
      setStatusLog(["Faltan credenciales o sucursal."]);
      return;
    }

    const lines: string[] = [];
    const timeline: Array<{ at: string; status: string }> = [];
    for (let i = 0; i < 6; i++) {
      try {
        const response = await apiClient.getOrderStatus({
          apiKey: apiKey.trim(),
          restauranteSlug: selectedBranchSlug,
          orderId: lastOrderId,
          idempotencyKey: `poll-${Date.now()}-${i}`
        });
        const estado = (response as { data?: { estado?: string } }).data?.estado ?? "n/a";
        lines.push(`Intento ${i + 1}: estado ${estado}`);
        timeline.push({ at: new Date().toLocaleTimeString("es-MX"), status: estado });
      } catch (error) {
        lines.push(`Intento ${i + 1}: ${error instanceof Error ? error.message : "error"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    setStatusLog(lines);
    setStatusTimeline(timeline);
  };

  return (
    <div className="app-shell">
      <div className="bg-orbs" />
      <div className="layout">
        <main className="content">
          <section className="hero-card">
            <div className="hero-top">
              <div>
                <div className="badge">PedimOS</div>
                <h1>{menu?.restaurante?.nombre ?? "Canal cliente PedimOS"}</h1>
                <p>Pide rapido, sin friccion y con envio estructurado directo al flujo operativo del restaurante.</p>
              </div>
            </div>
            <div className="chips">
              <div className="chip">
                Sucursal:
                <select value={selectedBranchSlug} onChange={(event) => setSelectedBranchSlug(event.target.value)}>
                  <option value="">Selecciona</option>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.slug}>
                      {branch.nombre}
                    </option>
                  ))}
                </select>
              </div>
              <div className="chip">Productos: {menu?.productos.length ?? 0}</div>
              <div className="chip alert">{menuError ? menuError : "Pedido en linea activo"}</div>
            </div>
          </section>

          <section className="menu-card">
            <h2>Arma tu orden</h2>
            {loadingMenu ? <p>Cargando menu...</p> : null}
            <div className="products-grid">
              {(menu?.productos ?? []).map((product) => (
                <article key={product.id} className="product-card">
                  <div className="product-head">
                    <span className="icon">🍽️</span>
                    <span className="tag">Disponible</span>
                  </div>
                  <h3>{product.nombre}</h3>
                  <p>ID {product.id}</p>
                  <div className="product-actions">
                    <span>{asCurrency(38)}</span>
                    <button onClick={() => addProduct(product.id, product.nombre)}>Agregar</button>
                  </div>
                </article>
              ))}
              {!menu?.productos?.length ? <div className="empty-card">No hay menu cargado para esta sucursal.</div> : null}
            </div>
          </section>
        </main>

        <aside className="sidebar">
          <section className="cart-card">
            <h3>Tu carrito</h3>
            <p className="muted">Este pedido quedara ligado a la sucursal seleccionada.</p>
            <label>API key</label>
            <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="x-api-key" />
            <label>Idempotency key</label>
            <input value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} />
            <label>Nombre cliente</label>
            <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} />
            <label>Telefono</label>
            <input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} />
            <label>Direccion</label>
            <input value={customerAddress} onChange={(event) => setCustomerAddress(event.target.value)} />
            <div className="cart-items">
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
            <div className="actions">
              <button className="secondary" onClick={() => setCart(cartState.read())}>
                Refrescar
              </button>
              <button className="primary" disabled={submitting} onClick={checkout}>
                {submitting ? "Enviando..." : "Confirmar pedido"}
              </button>
            </div>
            <button className="secondary full" onClick={pollStatus}>
              Consultar estado
            </button>
            <div className="timeline">
              {statusTimeline.map((row, index) => (
                <div key={`${row.at}-${index}`} className="timeline-row">
                  <span>{row.at}</span>
                  <strong>{row.status}</strong>
                </div>
              ))}
            </div>
            <pre className="log">{statusLog.join("\n")}</pre>
          </section>
        </aside>
      </div>
    </div>
  );
}
