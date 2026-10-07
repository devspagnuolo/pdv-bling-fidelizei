import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const api = import.meta.env.VITE_API_URL || 'http://localhost:3333';
type Product = { id: string; sku: string; name: string; price: number; stock: number };
type Seller = { id: string; name: string };
type PaymentMethod = {
  id: string;
  name: string;
  type: string;
  active: boolean;
  isDefault?: boolean;
  source: 'BLING' | 'DEMO';
};
type CustomerLookup = {
  found: boolean;
  cpf: string;
  name?: string;
  bling?: { id: string; cpf: string; name: string; email?: string; phone?: string };
  fidelizei?: {
    id: string;
    cpf: string;
    name: string;
    tier: string;
    points: number;
    benefits: string[];
    coupons: { id: string; code: string; description: string; discount: number }[];
  };
  systems: {
    bling: 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE';
    fidelizei: 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE';
  };
};
type IntegrationStatus = {
  bling: { configured: boolean; connected: boolean; mode: string; expiresAt?: string };
  fidelizaPlus: { configured: boolean; connected: boolean; mode: string };
};
type Item = Product & { quantity: number };
type Step = 'product' | 'customer' | 'payment';
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const paymentIcon = (method: PaymentMethod) => {
  const value = `${method.type} ${method.name}`.toLowerCase();
  if (value.includes('pix')) return '◆';
  if (value.includes('dinheiro') || value.includes('cash')) return 'R$';
  if (value.includes('boleto')) return '▤';
  if (value.includes('crediário') || value.includes('crediario')) return '◫';
  if (value.includes('cart') || value.includes('credit') || value.includes('debit')) return '▰';
  return '●';
};

function App() {
  const [step, setStep] = useState<Step>('product');
  const [products, setProducts] = useState<Product[]>([]);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationStatus>();
  const [items, setItems] = useState<Item[]>([]);
  const [query, setQuery] = useState('');
  const [catalogSearchActive, setCatalogSearchActive] = useState(false);
  const [searchingCatalog, setSearchingCatalog] = useState(false);
  const [seller, setSeller] = useState('');
  const [cpf, setCpf] = useState('');
  const [customer, setCustomer] = useState<CustomerLookup>();
  const [coupon, setCoupon] = useState('');
  const [sale, setSale] = useState<any>();
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const load = async <T,>(path: string): Promise<T> => {
      const response = await fetch(`${api}${path}`);
      if (!response.ok) throw new Error(path);
      return response.json();
    };
    load<IntegrationStatus>('/integrations/status').then(setIntegrations).catch(() => undefined);
    if (new URLSearchParams(window.location.search).get('integration') === 'bling-connected') {
      setMessage('Bling conectado com sucesso.');
      window.history.replaceState({}, '', window.location.pathname);
    }
    Promise.all([
      load<Product[]>('/catalog/products'),
      load<Seller[]>('/catalog/sellers'),
      load<PaymentMethod[]>('/catalog/payment-methods')
    ]).then(([p, s, methods]) => {
      setProducts(p);
      setSellers(s);
      setPaymentMethods(methods);
      setSeller(s[0]?.id ?? '');
      setPaymentMethodId(methods.find(method => method.isDefault)?.id ?? methods[0]?.id ?? '');
    }).catch(() => setMessage('Não foi possível carregar os dados sincronizados do PDV.'));
  }, []);

  const subtotal = useMemo(() => items.reduce((n, x) => n + x.price * x.quantity, 0), [items]);
  const total = sale?.total ?? subtotal;
  const filtered = catalogSearchActive
    ? products
    : products.filter(p => `${p.name} ${p.sku} ${p.barcode ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const selectedPaymentMethod = paymentMethods.find(method => method.id === paymentMethodId);
  const paymentSource = paymentMethods[0]?.source;
  const loyaltyCustomer = customer?.fidelizei;

  const changeCart = (next: Item[]) => {
    setItems(next);
    setSale(undefined);
    setMessage('');
  };
  const add = (p: Product) => {
    const current = items.find(i => i.id === p.id);
    changeCart(current
      ? items.map(i => i.id === p.id ? { ...i, quantity: Math.min(i.stock, i.quantity + 1) } : i)
      : [...items, { ...p, quantity: 1 }]);
  };
  const quantity = (id: string, delta: number) => changeCart(items
    .map(i => i.id === id ? { ...i, quantity: Math.max(0, Math.min(i.stock, i.quantity + delta)) } : i)
    .filter(i => i.quantity > 0));

  const searchCatalog = async () => {
    const term = query.trim();
    setSearchingCatalog(true);
    setMessage('');
    try {
      const response = await fetch(`${api}/catalog/products?query=${encodeURIComponent(term)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível consultar os produtos.');
      setProducts(data);
      setCatalogSearchActive(true);
      if (!data.length) setMessage('Nenhum produto encontrado no Bling.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível consultar os produtos.');
    } finally {
      setSearchingCatalog(false);
    }
  };

  const lookup = async () => {
    setMessage('');
    setCustomer(undefined);
    const r = await fetch(`${api}/customers/${cpf}`);
    const data = await r.json().catch(() => undefined);
    if (!r.ok) return setMessage(data?.message ?? 'Não foi possível consultar o cliente.');
    setCustomer(data);
    if (!data.found) {
      const unavailable = Object.values(data.systems).includes('UNAVAILABLE');
      return setMessage(unavailable
        ? 'Cliente não localizado nas bases disponíveis. Uma integração está temporariamente indisponível.'
        : 'Cliente não localizado no Bling nem no Fidelizei.');
    }
    if (data.bling && data.fidelizei) return setMessage('Cliente localizado no Bling e no Fidelizei.');
    if (data.bling) return setMessage('Cliente localizado no Bling. Ainda não possui cadastro no Fidelizei.');
    setMessage('Cliente localizado no Fidelizei. Ainda não possui cadastro no Bling.');
  };
  const create = async () => {
    const r = await fetch(`${api}/sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operatorId: 'operator-demo',
        sellerId: seller,
        customerCpf: cpf,
        items: items.map(x => ({
          productId: x.id,
          sku: x.sku,
          name: x.name,
          quantity: x.quantity,
          unitPrice: x.price
        }))
      })
    });
    const data = await r.json();
    if (!r.ok) { setMessage(data.message); return; }
    setSale(data);
    return data;
  };
  const applyCoupon = async () => {
    const activeSale = sale ?? await create();
    if (!activeSale) return;
    const r = await fetch(`${api}/sales/${activeSale.id}/coupon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: coupon })
    });
    const data = await r.json();
    if (!r.ok) return setMessage(data.message);
    setSale(data);
    setMessage('Cupom validado e reservado por 10 minutos.');
  };
  const complete = async () => {
    const activeSale = sale ?? await create();
    if (!activeSale) return;
    const r = await fetch(`${api}/sales/${activeSale.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentMethodId })
    });
    const data = await r.json();
    if (!r.ok) return setMessage(data.message ?? 'Não foi possível concluir a venda.');
    setSale(data);
    setMessage(data.status === 'COMPLETED'
      ? `Venda concluída. Pedido Bling: ${data.blingOrderId}`
      : 'Pedido criado; a fidelidade exige reconciliação.');
  };

  return <main>
    <header>
      <div><small>PDV INDEPENDENTE</small><h1>Venda</h1></div>
      <div className="header-actions"><span>Operador: Caixa Demo</span><button className="secondary">Nova venda</button></div>
    </header>

    <section className="integration-strip" aria-label="Status das integrações">
      <div>
        <span className={integrations?.bling.connected ? 'integration-dot online' : 'integration-dot'} />
        <div><b>Bling</b><small>{integrations?.bling.connected ? 'Conectado ao PDV' : integrations?.bling.configured ? 'Pronto para autorizar' : 'Configuração pendente'}</small></div>
        {integrations?.bling.configured && !integrations.bling.connected && <a href={`${api}/integrations/bling/connect`}>Conectar</a>}
      </div>
      <div>
        <span className={integrations?.fidelizaPlus.connected ? 'integration-dot online' : 'integration-dot'} />
        <div><b>Fideliza+</b><small>{integrations?.fidelizaPlus.connected ? 'Conectado ao PDV' : 'Configuração pendente'}</small></div>
      </div>
      <span className="integration-note">Credenciais protegidas no servidor</span>
    </section>

    <nav className="steps">
      <button className={step === 'product' ? 'active' : ''} onClick={() => setStep('product')}>1 · Produto</button>
      <button className={step === 'customer' ? 'active' : ''} onClick={() => setStep('customer')}>2 · Cliente</button>
      <button className={step === 'payment' ? 'active' : ''} onClick={() => setStep('payment')}>3 · Pagamento</button>
    </nav>

    <section className="workspace">
      <article className="panel">
        {step === 'product' && <>
          <div className="section-title"><div><small>ETAPA 1</small><h2>Adicionar produtos</h2></div><span>{products.length} itens sincronizados</span></div>
          <div className="catalog-search">
            <input className="search" value={query} onChange={e => { setQuery(e.target.value); setCatalogSearchActive(false); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void searchCatalog(); } }} placeholder="Bipe o código de barras ou pesquise SKU / produto" autoFocus />
            <button className="search-action" onClick={() => void searchCatalog()} disabled={searchingCatalog}>{searchingCatalog ? 'Buscando…' : 'Buscar'}</button>
          </div>
          <p className="scanner-hint">Leitor de código de barras conectado? Basta bipar e pressionar Enter.</p>
          <div className="catalog">{filtered.map(p => <button className="product" disabled={!p.stock} onClick={() => add(p)} key={p.id}>
            <span><b>{p.name}</b><small>{p.sku}{p.barcode ? ` · ${p.barcode}` : ''} · {p.stock} em estoque</small></span><strong>{brl.format(p.price)}</strong>
          </button>)}</div>
          <button className="next" disabled={!items.length} onClick={() => setStep('customer')}>Continuar para cliente</button>
        </>}

        {step === 'customer' && <>
          <div className="section-title"><div><small>ETAPA 2</small><h2>Identificar cliente</h2></div><span>Bling + Fidelizei</span></div>
          <label>CPF<div className="row"><input value={cpf} onChange={e => { setCpf(e.target.value); setCustomer(undefined); setSale(undefined); setMessage(''); }} placeholder="000.000.000-00" /><button onClick={lookup}>Consultar</button></div></label>
          {customer?.found ? <div className="customer-card unified">
            <div className="customer-identity">
              <div className="source-badges">
                <span className={customer.systems.bling === 'FOUND' ? 'source-status found' : customer.systems.bling === 'UNAVAILABLE' ? 'source-status unavailable' : 'source-status missing'}>
                  {customer.systems.bling === 'FOUND' ? '✓ Bling' : customer.systems.bling === 'UNAVAILABLE' ? '! Bling indisponível' : '– Não está no Bling'}
                </span>
                <span className={customer.systems.fidelizei === 'FOUND' ? 'source-status found' : customer.systems.fidelizei === 'UNAVAILABLE' ? 'source-status unavailable' : 'source-status missing'}>
                  {customer.systems.fidelizei === 'FOUND' ? '✓ Fidelizei' : customer.systems.fidelizei === 'UNAVAILABLE' ? '! Fidelizei indisponível' : '– Não está no Fidelizei'}
                </span>
              </div>
              <h3>{customer.name}</h3>
              <p>CPF {customer.cpf}</p>
              {customer.bling?.email && <small>{customer.bling.email}</small>}
            </div>
            <div className="loyalty-panel">
              {loyaltyCustomer ? <>
                <span className="vip">VIP {loyaltyCustomer.tier}</span>
                <b>{loyaltyCustomer.points} pontos disponíveis</b>
                <div className="benefits">{loyaltyCustomer.benefits.map(benefit => <span key={benefit}>✓ {benefit}</span>)}</div>
              </> : <>
                <b>Sem cadastro de fidelidade</b>
                <p>A venda pode continuar normalmente. Pontos, benefícios e cupons não serão aplicados.</p>
              </>}
            </div>
          </div> : <div className="empty-state">Informe o CPF para consultar simultaneamente o Bling e o Fidelizei.</div>}
          <label>Cupom Fidelizei<div className="row"><input disabled={!loyaltyCustomer} value={coupon} onChange={e => setCoupon(e.target.value.toUpperCase())} placeholder={loyaltyCustomer ? 'Digite o código do cupom' : 'Disponível para clientes Fidelizei'} /><button disabled={!loyaltyCustomer || !coupon} onClick={applyCoupon}>Validar</button></div></label>
          <div className="nav-actions"><button className="secondary" onClick={() => setStep('product')}>Voltar</button><button className="next" disabled={!customer?.found} onClick={() => setStep('payment')}>Continuar para pagamento</button></div>
        </>}

        {step === 'payment' && <>
          <div className="section-title">
            <div><small>ETAPA 3</small><h2>Pagamento</h2></div>
            <span className="bling-badge">{paymentSource === 'BLING' ? 'Sincronizado do Bling' : 'Ambiente demonstrativo'}</span>
          </div>
          <div className="totals-grid">
            <div><small>Subtotal</small><b>{brl.format(subtotal)}</b></div>
            <div><small>Desconto</small><b>{brl.format(sale?.discount ?? 0)}</b></div>
            <div className="grand"><small>Total da venda</small><b>{brl.format(total)}</b></div>
          </div>

          <section className="payment-section">
            <div className="payment-heading">
              <div><h3>Como o cliente vai pagar?</h3><p>Escolha uma forma ativa cadastrada no financeiro do Bling.</p></div>
              <span>{paymentMethods.length} disponíveis</span>
            </div>
            <div className="payment-options" role="radiogroup" aria-label="Forma de pagamento">
              {paymentMethods.map(method => <button
                type="button"
                role="radio"
                aria-checked={paymentMethodId === method.id}
                className={paymentMethodId === method.id ? 'payment-option active' : 'payment-option'}
                onClick={() => setPaymentMethodId(method.id)}
                key={method.id}
              >
                <span className="payment-icon">{paymentIcon(method)}</span>
                <span><b>{method.name}</b><small>{method.type === 'OTHER' ? 'Bling' : method.type.replaceAll('_', ' ')}</small></span>
                <i>✓</i>
              </button>)}
            </div>
            {!paymentMethods.length && <div className="empty-state compact">Nenhuma forma de pagamento disponível.</div>}
          </section>

          <label>Vendedor<select value={seller} onChange={e => setSeller(e.target.value)}>
            <option value="">Selecione o vendedor</option>{sellers.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}
          </select></label>
          <div className="summary">
            <span>Cliente <b>{customer?.name ?? 'Não identificado'}</b></span>
            <span>Pagamento <b>{selectedPaymentMethod?.name ?? 'Selecione'}</b></span>
            <span>Vendedor <b>{sellers.find(item => item.id === seller)?.name ?? 'Selecione'}</b></span>
          </div>
          <div className="nav-actions"><button className="secondary" onClick={() => setStep('customer')}>Voltar</button><button className="finish" disabled={!items.length || !seller || !paymentMethodId} onClick={complete}>Finalizar venda · {brl.format(total)}</button></div>
        </>}
        {message && <p className={sale?.status === 'COMPLETED' ? 'message success' : 'message'}>{message}</p>}
      </article>

      <aside className="cart">
        <div className="cart-title"><div><small>PEDIDO ATUAL</small><h2>Itens da venda</h2></div><span>{items.reduce((n, i) => n + i.quantity, 0)}</span></div>
        <div className="cart-items">{items.length ? items.map(i => <div className="cart-item" key={i.id}>
          <div><b>{i.name}</b><small>{i.sku} · {brl.format(i.price)} un.</small></div>
          <div className="qty"><button onClick={() => quantity(i.id, -1)}>−</button><span>{i.quantity}</span><button onClick={() => quantity(i.id, 1)}>+</button></div>
          <strong>{brl.format(i.price * i.quantity)}</strong>
        </div>) : <div className="empty-cart"><span>🛍️</span><p>Nenhum produto adicionado</p></div>}</div>
        <div className="cart-total"><span>Total</span><strong>{brl.format(total)}</strong></div>
      </aside>
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
