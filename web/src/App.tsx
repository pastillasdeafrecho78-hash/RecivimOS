import { useEffect, useMemo, useState } from "react";
import { apiClient, type AccountMe, type Branch, type MenuCatalog } from "./api/client";
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
  const [activeTab, setActiveTab] = useState<TabId>("Explorar");
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
  const [account, setAccount] = useState<AccountMe | null>(null);
  const [accountOrders, setAccountOrders] = useState<
    Array<{ orderId: string; numeroComanda: string; estado: string; total: number; createdAt: string }>
  >([]);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [accountRegisterMode, setAccountRegisterMode] = useState(false);
  const [accountNameDraft, setAccountNameDraft] = useState("");
  const [accountPhoneDraft, setAccountPhoneDraft] = useState("");
  const [accountEmailDraft, setAccountEmailDraft] = useState("");
  const [accountPasswordDraft, setAccountPasswordDraft] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountReservations, setAccountReservations] = useState<
    Array<{ id: string; reservedFor: string; durationMinutes: number; status: string; partySize: number; notes?: string | null }>
  >([]);
  const [reservationDateDraft, setReservationDateDraft] = useState("");
  const [reservationPartyDraft, setReservationPartyDraft] = useState("2");
  const [reservationDurationDraft, setReservationDurationDraft] = useState("90");
  const [reservationNotesDraft, setReservationNotesDraft] = useState("");
  const [uiNotice, setUiNotice] = useState("");

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

  const refreshAccount = async () => {
    setAccountLoading(true);
    setAccountError("");
    try {
      const me = await apiClient.accountMe();
      setAccount(me);
      setAccountNameDraft(me.nombreCompleto);
      setAccountPhoneDraft(me.telefono ?? "");
      const orders = await apiClient.accountOrders();
      setAccountOrders(orders);
      const reservations = await apiClient.accountReservations();
      setAccountReservations(reservations);
    } catch {
      setAccount(null);
      setAccountOrders([]);
      setAccountReservations([]);
    } finally {
      setAccountLoading(false);
    }
  };

  useEffect(() => {
    void refreshAccount();
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

  const submitAccount = async () => {
    if (!selectedBranchSlug) {
      setAccountError("Selecciona sucursal antes de iniciar sesion.");
      return;
    }
    if (!accountEmailDraft || !accountPasswordDraft) {
      setAccountError("Ingresa correo y contrasena.");
      return;
    }
    setAccountBusy(true);
    setAccountError("");
    try {
      if (accountRegisterMode) {
        await apiClient.accountRegister({
          slug: selectedBranchSlug,
          email: accountEmailDraft,
          password: accountPasswordDraft,
          nombreCompleto: accountNameDraft || "Cliente PedimOS",
          telefono: accountPhoneDraft || undefined
        });
      } else {
        await apiClient.accountLogin({
          slug: selectedBranchSlug,
          email: accountEmailDraft,
          password: accountPasswordDraft
        });
      }
      await refreshAccount();
      setAccountPasswordDraft("");
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "No fue posible autenticar.");
    } finally {
      setAccountBusy(false);
    }
  };

  const updateProfile = async () => {
    setAccountBusy(true);
    setAccountError("");
    try {
      await apiClient.accountUpdate({
        nombreCompleto: accountNameDraft,
        telefono: accountPhoneDraft
      });
      await refreshAccount();
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "No se pudo guardar perfil.");
    } finally {
      setAccountBusy(false);
    }
  };

  const logoutAccount = async () => {
    setAccountBusy(true);
    setAccountError("");
    try {
      await apiClient.accountLogout();
      setAccount(null);
      setAccountOrders([]);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "No se pudo cerrar sesion.");
    } finally {
      setAccountBusy(false);
    }
  };

  const claimGuestOrders = async () => {
    setAccountBusy(true);
    setAccountError("");
    try {
      const linked = await apiClient.accountClaimGuest({
        telefono: accountPhoneDraft || customerPhone || undefined,
        orderIds: lastOrderId ? [lastOrderId] : undefined
      });
      await refreshAccount();
      setStatusLog((prev) => [`Pedidos vinculados a tu cuenta: ${linked}`, ...prev]);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "No se pudieron vincular pedidos.");
    } finally {
      setAccountBusy(false);
    }
  };

  const loginWithMeta = async () => {
    if (!selectedBranchSlug) {
      setAccountError("Selecciona sucursal antes de usar Meta.");
      return;
    }
    setAccountError("");
    try {
      const authUrl = await apiClient.metaStart(selectedBranchSlug);
      if (!authUrl) {
        setAccountError("Meta login no esta disponible en este entorno.");
        return;
      }
      window.location.href = authUrl;
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "No se pudo iniciar Meta login.");
    }
  };

  const createReservation = async () => {
    if (!reservationDateDraft) {
      setAccountError("Selecciona fecha y hora para reservar.");
      return;
    }
    setAccountBusy(true);
    setAccountError("");
    try {
      await apiClient.createAccountReservation({
        partySize: Number(reservationPartyDraft),
        reservedFor: new Date(reservationDateDraft).toISOString(),
        durationMinutes: Number(reservationDurationDraft),
        notes: reservationNotesDraft || undefined
      });
      setReservationNotesDraft("");
      await refreshAccount();
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "No se pudo crear la reservacion.");
    } finally {
      setAccountBusy(false);
    }
  };

  const cancelReservation = async (id: string) => {
    setAccountBusy(true);
    setAccountError("");
    try {
      await apiClient.cancelAccountReservation(id);
      await refreshAccount();
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "No se pudo cancelar reservacion.");
    } finally {
      setAccountBusy(false);
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
                <strong className="brand-title">{menu?.restaurante?.nombre ?? "Pide lo que se te antoje"}</strong>
                <p className="brand-subtitle">Tu puerta digital para pedir, reservar y dar seguimiento</p>
              </div>
            </div>
            <div className="follow-chip">Cuenta+Reservas v2 activas · Siguenos y descubre promos del dia</div>
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
          <div className="top-nav-toolbar">
            <input
              className="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar sucursal o producto..."
            />
            <select
              className="branch-select"
              value={selectedBranchSlug}
              onChange={(event) => {
                setSelectedBranchSlug(event.target.value);
                setActiveTab("Menu");
              }}
            >
              <option value="">Sucursal</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.slug}>
                  {branch.nombre}
                </option>
              ))}
            </select>
          </div>
          {uiNotice ? <div className="ui-notice">{uiNotice}</div> : null}
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
                  <button
                    onClick={() => {
                      setSelectedBranchSlug(branch.slug);
                      setActiveTab("Menu");
                      setUiNotice(`Sucursal activa: ${branch.nombre}`);
                    }}
                  >
                    Entrar
                  </button>
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
                  <p className="muted">Desde {asCurrency(getProductPrice(product))}</p>
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
              <span className="muted">{account ? "Sesion activa" : "Invitado"}</span>
            </div>
            {accountLoading ? <p className="muted">Cargando cuenta...</p> : null}
            {accountError ? <p className="muted">{accountError}</p> : null}

            {!account ? (
              <div className="account-shell">
                <div className="account-form-card">
                  <p className="muted">Inicia sesion para guardar tu historial y reservar mesa.</p>
                  <div className="form-grid">
                    <input
                      value={accountNameDraft}
                      onChange={(event) => setAccountNameDraft(event.target.value)}
                      placeholder="Nombre completo"
                    />
                    <input
                      value={accountPhoneDraft}
                      onChange={(event) => setAccountPhoneDraft(event.target.value)}
                      placeholder="Telefono"
                    />
                    <input
                      value={accountEmailDraft}
                      onChange={(event) => setAccountEmailDraft(event.target.value)}
                      placeholder="Correo"
                    />
                    <input
                      type="password"
                      value={accountPasswordDraft}
                      onChange={(event) => setAccountPasswordDraft(event.target.value)}
                      placeholder="Contrasena"
                    />
                  </div>
                  <div className="actions">
                    <button className="secondary" onClick={loginWithMeta}>
                      Entrar con Meta
                    </button>
                    <button className="secondary" onClick={() => setAccountRegisterMode((prev) => !prev)}>
                      {accountRegisterMode ? "Tengo cuenta" : "Crear cuenta"}
                    </button>
                    <button className="primary" disabled={accountBusy} onClick={submitAccount}>
                      {accountBusy ? "Procesando..." : accountRegisterMode ? "Registrarme" : "Entrar"}
                    </button>
                  </div>
                </div>
                <div className="account-side-card">
                  <h3>Ventajas de tu cuenta</h3>
                  <ul>
                    <li>Historial de pedidos en segundos</li>
                    <li>Reservaciones sin volver a capturar datos</li>
                    <li>Vinculacion de pedidos de invitado</li>
                    <li>Acceso rapido con Meta cuando este configurado</li>
                  </ul>
                </div>
              </div>
            ) : (
              <div className="account-shell">
                <div className="account-form-card">
                  <p className="muted">
                    {account.nombreCompleto} ({account.email}) - {account.isCommissionFree ? "Sin comision" : "Cliente estandar"}
                  </p>
                  <div className="form-grid two-up">
                    <input
                      value={accountNameDraft}
                      onChange={(event) => setAccountNameDraft(event.target.value)}
                      placeholder="Nombre completo"
                    />
                    <input
                      value={accountPhoneDraft}
                      onChange={(event) => setAccountPhoneDraft(event.target.value)}
                      placeholder="Telefono"
                    />
                  </div>
                  <div className="actions">
                    <button className="secondary" disabled={accountBusy} onClick={updateProfile}>
                      Guardar perfil
                    </button>
                    <button className="secondary" disabled={accountBusy} onClick={claimGuestOrders}>
                      Vincular pedidos invitado
                    </button>
                    <button className="primary" disabled={accountBusy} onClick={logoutAccount}>
                      Cerrar sesion
                    </button>
                  </div>
                </div>
                <div className="account-side-card">
                  <h3>Resumen de actividad</h3>
                  <div className="timeline">
                    {accountOrders.map((row) => (
                      <div key={row.orderId} className="timeline-row">
                        <span>{new Date(row.createdAt).toLocaleString("es-MX")}</span>
                        <strong>
                          #{row.numeroComanda} - {row.estado} - {asCurrency(row.total)}
                        </strong>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="account-reservation-card">
                  <h3>Tus reservaciones</h3>
                  <div className="form-grid reservations-grid">
                    <input
                      type="datetime-local"
                      value={reservationDateDraft}
                      onChange={(event) => setReservationDateDraft(event.target.value)}
                    />
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={reservationPartyDraft}
                      onChange={(event) => setReservationPartyDraft(event.target.value)}
                      placeholder="Personas"
                    />
                    <input
                      type="number"
                      min={30}
                      max={360}
                      value={reservationDurationDraft}
                      onChange={(event) => setReservationDurationDraft(event.target.value)}
                      placeholder="Minutos"
                    />
                  </div>
                  <input
                    value={reservationNotesDraft}
                    onChange={(event) => setReservationNotesDraft(event.target.value)}
                    placeholder="Notas para la reservacion"
                  />
                  <div className="actions">
                    <button className="secondary" disabled={accountBusy} onClick={createReservation}>
                      Reservar mesa
                    </button>
                  </div>
                  <div className="timeline">
                    {accountReservations.map((reservation) => (
                      <div key={reservation.id} className="timeline-row">
                        <span>
                          {new Date(reservation.reservedFor).toLocaleString("es-MX")} · {reservation.partySize} personas
                        </span>
                        <div className="timeline-status">
                          <strong>{reservation.status}</strong>
                          {reservation.status !== "CANCELADA" && reservation.status !== "COMPLETADA" ? (
                            <button className="secondary" onClick={() => cancelReservation(reservation.id)}>
                              Cancelar
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
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
