import { useEffect, useMemo, useState } from "react";
import { apiClient, type Branch, type MenuCatalog } from "./api/client";
import { cartState, type CartItem } from "./state/cart";

const randomExternalOrderId = (): string => `ext-${Date.now()}-${Math.floor(Math.random() * 9999)}`;

const asCurrency = (amount: number): string =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(amount);

const tabs = ["Mapa", "Explorar", "Menu", "Cuenta", "Pedido", "Historial"] as const;
type TabId = (typeof tabs)[number];

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

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>("Mapa");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchSlug, setSelectedBranchSlug] = useState("");
  const [menu, setMenu] = useState<MenuCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [menuError, setMenuError] = useState("");
  const [loadingMenu, setLoadingMenu] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [sessionReadySlug, setSessionReadySlug] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
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
    setSelectedBranchSlug(cfg.slug);
    setCart(cartState.read());
    void apiClient
      .getBranches()
      .then((loaded) => {
        setBranches(loaded);
        if (!cfg.slug && loaded.length) {
          setSelectedBranchSlug(loaded[0]?.slug ?? "");
        }
      })
      .catch(() => setBranches([]));
  }, []);

  useEffect(() => {
    if (!selectedBranchSlug) return;
    setCreatingSession(true);
    setSessionReadySlug("");
    setLoadingMenu(true);
    setMenuError("");
    void apiClient
      .startPublicSession(selectedBranchSlug)
      .then(() => {
        setSessionReadySlug(selectedBranchSlug);
        return apiClient.getMenuBySlug(selectedBranchSlug);
      })
      .then(({ data, degraded }) => {
        setMenu(data);
        if (degraded) setMenuError("Algunos elementos del menú no están disponibles por ahora.");
      })
      .catch((error) => {
        setMenu(null);
        setMenuError(error instanceof Error ? error.message : "No se pudo cargar el menú.");
      })
      .finally(() => {
        setCreatingSession(false);
        setLoadingMenu(false);
      });
  }, [selectedBranchSlug]);

  const total = useMemo(() => cart.reduce((acc, item) => acc + item.qty * item.unitPrice, 0), [cart]);
  const filteredBranches = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return branches;
    return branches.filter((branch) => branch.nombre.toLowerCase().includes(term) || branch.slug.toLowerCase().includes(term));
  }, [branches, query]);
  const visibleProducts = useMemo(() => {
    const products = menu?.productos ?? [];
    const term = query.trim().toLowerCase();
    if (!term) return products;
    return products.filter((product) => product.nombre.toLowerCase().includes(term));
  }, [menu?.productos, query]);
  const selectedProduct = visibleProducts[0] ?? null;

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
    if (!selectedBranchSlug) {
      setStatusLog(["Selecciona sucursal para consultar estado."]);
      return;
    }

    const lines: string[] = [];
    const timeline: Array<{ at: string; status: string }> = [];
    for (let i = 0; i < 6; i++) {
      try {
        const response = await apiClient.getOrderStatus({
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
      <div className="layout-wide">
        <header className="top-nav">
          <div className="top-nav-row">
            <div className="brand-row">
              <div className="badge">PedimOS</div>
              <strong>{menu?.restaurante?.nombre ?? "Pide lo que se te antoje"}</strong>
            </div>
            <div className="follow-chip">Siguenos y descubre promos del día</div>
          </div>
          <nav className="tab-grid">
            {tabs.map((tab) => (
              <button
                key={tab}
                className={`tab-btn ${activeTab === tab ? "active" : ""}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </nav>
          <div className="top-nav-row">
            <input
              className="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar sucursal o producto..."
            />
            <select className="search" value={selectedBranchSlug} onChange={(event) => setSelectedBranchSlug(event.target.value)}>
              <option value="">Sucursal</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.slug}>
                  {branch.nombre}
                </option>
              ))}
            </select>
          </div>
        </header>

        {activeTab === "Mapa" ? (
          <section className="panel">
            <div className="panel-head">
              <h2>Mapa</h2>
              <span className="muted">{creatingSession ? "Conectando..." : "Listo"}</span>
            </div>
            <div className="map-box">Mapa de sucursales</div>
          </section>
        ) : null}

        {activeTab === "Explorar" ? (
          <section className="panel">
            <div className="panel-head">
              <h2>Explorar</h2>
              <span className="muted">Elige un local</span>
            </div>
            <div className="list">
              {filteredBranches.map((branch) => (
                <article key={branch.id} className={`branch-card ${selectedBranchSlug === branch.slug ? "active" : ""}`}>
                  <div>
                    <h3>{branch.nombre}</h3>
                    <p>{branch.slug}</p>
                  </div>
                  <button onClick={() => setSelectedBranchSlug(branch.slug)}>Entrar</button>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {activeTab === "Menu" ? (
          <section className="panel">
            <div className="panel-head">
              <h2>Menu</h2>
              <span className="muted">
                {loadingMenu ? "Cargando..." : `${visibleProducts.length} productos`}
              </span>
            </div>
            {menuError ? <p className="muted">{menuError}</p> : null}
            <div className="products-grid-lite">
              {visibleProducts.map((product) => (
                <article key={product.id} className="product-focus">
                  <img
                    src={product.imageUrl || "https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?q=80&w=1200"}
                    alt={product.nombre}
                  />
                  <h3>{product.nombre}</h3>
                  <button onClick={() => addProduct(product.id, product.nombre)}>Agregar</button>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {activeTab === "Cuenta" ? (
          <section className="panel">
            <div className="panel-head">
              <h2>Cuenta</h2>
              <span className="muted">Opcional después de pedir</span>
            </div>
            <p className="muted">
              Puedes pedir como invitado y crear tu cuenta después del pago para guardar historial y favoritos.
            </p>
          </section>
        ) : null}

        {activeTab === "Pedido" ? (
          <section className="cart-card">
            <h3>Tu pedido</h3>
            <p className="muted">Sesión: {sessionReadySlug || "sin sesión activa"}</p>
            <label>Idempotency key</label>
            <input value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} />
            <label>Nombre</label>
            <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} />
            <label>Teléfono</label>
            <input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} />
            <label>Dirección</label>
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
            <pre className="log">{statusLog.join("\n")}</pre>
          </section>
        ) : null}

        {activeTab === "Historial" ? (
          <section className="panel">
            <div className="panel-head">
              <h2>Historial</h2>
              <button className="secondary" onClick={pollStatus}>
                Consultar estado
              </button>
            </div>
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
        ) : null}
      </div>
    </div>
  );
}
