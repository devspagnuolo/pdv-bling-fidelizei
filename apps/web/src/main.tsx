import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const api = import.meta.env.VITE_API_URL || 'http://localhost:3333';
type Product = { id: string; sku: string; name: string; price: number; stock: number; barcode?: string };
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
  fiscal?: { configured: boolean; available: boolean; source: 'BLING' };
};
type Item = Product & { quantity: number; comment?: string };
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
  const [fidelizeiPhone, setFidelizeiPhone] = useState('');
  const [programConsent, setProgramConsent] = useState(false);
  const [customer, setCustomer] = useState<CustomerLookup>();
  const [coupon, setCoupon] = useState('');
  const [sale, setSale] = useState<any>();
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [discountMode, setDiscountMode] = useState<'value' | 'percent'>('value');
  const [discountInput, setDiscountInput] = useState('0');
  const [freightInput, setFreightInput] = useState('0');
  const [observations, setObservations] = useState('');
  const [emitFiscal, setEmitFiscal] = useState(true);
  const [message, setMessage] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.key === 'F2') { event.preventDefault(); searchInputRef.current?.focus(); }
      if (event.key === 'F4') { event.preventDefault(); setStep('customer'); }
      if (event.key === 'F10') { event.preventDefault(); setStep('payment'); }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

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
      load<Seller[]>('/catalog/sellers'),
      load<PaymentMethod[]>('/catalog/payment-methods')
    ]).then(([s, methods]) => {
      setSellers(s);
      setPaymentMethods(methods);
      setSeller(s[0]?.id ?? '');
      setPaymentMethodId(methods.find(method => method.isDefault)?.id ?? methods[0]?.id ?? '');
    }).catch(() => setMessage('Não foi possível carregar os dados sincronizados do PDV.'));
  }, []);

  const subtotal = useMemo(() => items.reduce((n, x) => n + x.price * x.quantity, 0), [items]);
  const numericDiscount = Math.max(0, Number(discountInput.replace(',', '.')) || 0);
  const manualDiscount = Math.min(subtotal, discountMode === 'percent' ? subtotal * Math.min(100, numericDiscount) / 100 : numericDiscount);
  const freight = Math.max(0, Number(freightInput.replace(',', '.')) || 0);
  const effectiveDiscount = sale?.discount ?? manualDiscount;
  const effectiveFreight = sale?.freight ?? freight;
  const total = sale?.total ?? Math.max(0, subtotal - manualDiscount + freight);
  const filtered = catalogSearchActive
    ? products
    : products.filter(p => `${p.name} ${p.sku} ${p.barcode ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const selectedPaymentMethod = paymentMethods.find(method => method.id === paymentMethodId);
  const paymentSource = paymentMethods[0]?.source;
  const loyaltyCustomer = customer?.fidelizei;

  const changeCart = (next: Item[]) => {
    if (sale?.coupon) {
      setMessage('O cupom Fidelizei já foi consumido. Finalize esta venda antes de alterar os itens.');
      return;
    }
    setItems(next);
    setSale(undefined);
    setMessage('');
  };
  const add = (p: Product) => {
    const current = items.find(i => i.id === p.id);
    changeCart(current
      ? items.map(i => i.id === p.id ? { ...i, quantity: i.quantity + 1 } : i)
      : [...items, { ...p, quantity: 1 }]);
  };
  const quantity = (id: string, delta: number) => changeCart(items
    .map(i => i.id === id ? { ...i, quantity: Math.max(0, i.quantity + delta) } : i)
    .filter(i => i.quantity > 0));
  const commentItem = (id: string, comment: string) => changeCart(items.map(i => i.id === id ? { ...i, comment } : i));

  const searchCatalog = async () => {
    const term = query.trim();
    if (!term) {
      setMessage('Digite o nome, SKU ou código de barras do produto.');
      return;
    }
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
    if (data.bling?.phone) setFidelizeiPhone(data.bling.phone);
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
  const newSale = () => {
    setStep('product');
    setItems([]);
    setQuery('');
    setProducts([]);
    setCatalogSearchActive(false);
    setCpf('');
    setFidelizeiPhone('');
    setProgramConsent(false);
    setCustomer(undefined);
    setCoupon('');
    setSale(undefined);
    setDiscountMode('value');
    setDiscountInput('0');
    setFreightInput('0');
    setObservations('');
    setEmitFiscal(true);
    setMessage('');
    searchInputRef.current?.focus();
  };

  const enrollFidelizei = async () => {
    if (!customer?.bling || !programConsent) return;
    setMessage('');
    const response = await fetch(`${api}/customers/fidelizei`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: customer.bling.name,
        cpf: customer.cpf,
        phone: fidelizeiPhone,
        email: customer.bling.email,
        programConsent: true
      })
    });
    const data = await response.json().catch(() => undefined);
    if (!response.ok) return setMessage(data?.message ?? 'Não foi possível cadastrar a cliente no Fidelizei.');
    await lookup();
    setProgramConsent(false);
    setMessage('Adesão ao Fidelizei registrada com consentimento.');
  };

  const create = async () => {
    const r = await fetch(`${api}/sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operatorId: seller,
        sellerId: seller,
        customerCpf: customer?.found ? customer.cpf : undefined,
        manualDiscount,
        freight,
        observations,
        emitFiscal,
        items: items.map(x => ({
          productId: x.id,
          sku: x.sku,
          name: x.name,
          quantity: x.quantity,
          unitPrice: x.price,
          comment: x.comment
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
    setMessage('Cupom Fidelizei consumido e aplicado à venda.');
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
      ? `Venda concluída. Pedido Bling: ${data.blingOrderId}${data.fiscalStatus === 'REQUESTED' ? ' · NFC-e solicitada ao Bling.' : data.fiscalStatus === 'FAILED' ? ' · Pedido salvo, mas a NFC-e precisa ser verificada no Bling.' : ''}`
      : 'Pedido criado; a fidelidade exige reconciliação automática.');
  };

  return <main>
    <header className="pos-header">
      <div className="brand-block"><span className="brand-mark">V</span><div><small>VIVI MODA · CAIXA 01</small><h1>Frente de caixa</h1><p>Venda integrada ao Bling e Fidelizei</p></div></div>
      <div className="header-actions">
        <label className="operator-select"><span>Operador / vendedor</span><select value={seller} onChange={e => setSeller(e.target.value)}>
          <option value="">Selecione no Bling</option>{sellers.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}
        </select></label>
        <span className={integrations?.bling.connected ? 'status-pill online' : 'status-pill offline'}>Bling {integrations?.bling.connected ? 'online' : 'offline'}</span>
        <span className={integrations?.fidelizaPlus.connected ? 'status-pill online' : 'status-pill offline'}>Fidelizei {integrations?.fidelizaPlus.connected ? 'online' : 'offline'}</span>
        <button className="secondary" onClick={newSale}>Nova venda</button>
      </div>
    </header>

    <section className="integration-strip" aria-label="Status das integrações">
      <div>
        <span className={integrations?.bling.connected ? 'integration-dot online' : 'integration-dot'} />
        <div><b>Bling</b><small>{integrations?.bling.connected ? 'Conectado ao PDV' : integrations?.bling.configured ? 'Pronto para autorizar' : 'Configuração pendente'}</small></div>
        {integrations?.bling.configured && !integrations.bling.connected && <a href={`${api}/integrations/bling/connect`}>Conectar</a>}
      </div>
      <div>
        <span className={integrations?.fidelizaPlus.connected ? 'integration-dot online' : 'integration-dot'} />
        <div><b>Fidelizei</b><small>{integrations?.fidelizaPlus.connected ? 'Conectado ao PDV' : 'Configuração pendente'}</small></div>
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
          <div className="section-title"><div><small>ETAPA 1</small><h2>Adicionar produtos</h2></div><span>Busca direta no Bling</span></div>
          <div className="catalog-search">
            <div className="search-field"><span className="scan-icon">⌁</span><input ref={searchInputRef} id="product-search" className="search" value={query} onChange={e => { setQuery(e.target.value); setCatalogSearchActive(false); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void searchCatalog(); } }} placeholder="Bipe o código de barras ou pesquise SKU / produto" autoFocus /><kbd>F2</kbd></div>
            <button className="search-action" onClick={() => void searchCatalog()} disabled={searchingCatalog}>{searchingCatalog ? 'Buscando…' : 'Buscar'}</button>
          </div>
          <p className="scanner-hint">Leitor de código de barras conectado? Basta bipar e pressionar Enter.</p>
          <div className="catalog">{filtered.map(p => <button className={p.stock <= 0 ? "product out-of-stock" : "product"} onClick={() => add(p)} key={p.id}>
            <span><b>{p.name}</b><small>{p.sku}{p.barcode ? ` · ${p.barcode}` : ''} · <em className={p.stock <= 0 ? "stock zero" : "stock"}>{p.stock <= 0 ? "Sem estoque" : `${p.stock} em estoque`}</em></small></span><strong>{brl.format(p.price)}</strong>
          </button>)}</div>
          {catalogSearchActive && <div className="catalog-result-count">{products.length} produto(s) encontrado(s)</div>}
          {!catalogSearchActive && <div className="empty-state product-empty">Pesquise um produto para começar. O catálogo completo não é carregado no caixa.</div>}
          {catalogSearchActive && !filtered.length && <div className="empty-state product-empty">Nenhum produto encontrado para essa busca.</div>}
          <button className="next" disabled={!items.length} onClick={() => setStep('customer')}>Continuar para cliente</button>
        </>}

        {step === 'customer' && <>
          <div className="section-title"><div><small>ETAPA 2</small><h2>Identificar cliente</h2></div><span>Bling + Fidelizei</span></div>
          <label>CPF<div className="row"><input value={cpf} onChange={e => { setCpf(e.target.value); setCustomer(undefined); setSale(undefined); setMessage(''); }} placeholder="000.000.000-00" /><button onClick={lookup}>Consultar</button></div></label>
          {!customer && <div className="customer-card final-consumer"><div><span className="vip">PADRÃO BLING</span><h3>Consumidor Final</h3><p>Identificação opcional. A venda pode seguir normalmente sem CPF.</p></div><button onClick={() => setStep('payment')}>Continuar sem identificar</button></div>}
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
                <b>Sem cadastro no Fidelizei</b>
                <p>A venda pode continuar sem pontuação. A adesão exige consentimento explícito da cliente.</p>
                {customer.bling && <div className="enrollment-box">
                  <input value={fidelizeiPhone} onChange={e => setFidelizeiPhone(e.target.value)} placeholder="Celular com DDD" />
                  <label className="consent-check"><input type="checkbox" checked={programConsent} onChange={e => setProgramConsent(e.target.checked)} /><span>A cliente aceita participar do programa Fidelizei.</span></label>
                  <button disabled={!programConsent || !fidelizeiPhone} onClick={() => void enrollFidelizei()}>Cadastrar no Fidelizei</button>
                </div>}
              </>}
            </div>
          </div> : customer ? <div className="empty-state">Cliente não localizado. Continue como Consumidor Final ou revise o CPF.</div> : null}
          <label>Cupom Fidelizei<div className="row"><input disabled={!loyaltyCustomer} value={coupon} onChange={e => setCoupon(e.target.value.toUpperCase())} placeholder={loyaltyCustomer ? 'Digite o código do cupom' : 'Disponível para clientes Fidelizei'} /><button disabled={!loyaltyCustomer || !coupon} onClick={applyCoupon}>Aplicar cupom</button></div></label>
          <div className="nav-actions"><button className="secondary" onClick={() => setStep('product')}>Voltar</button><button className="next" disabled={!items.length} onClick={() => setStep('payment')}>{customer?.found ? 'Continuar para pagamento' : 'Continuar como Consumidor Final'}</button></div>
        </>}

        {step === 'payment' && <>
          <div className="section-title">
            <div><small>ETAPA 3</small><h2>Pagamento</h2></div>
            <span className="bling-badge">{paymentSource === 'BLING' ? 'Sincronizado do Bling' : 'Ambiente demonstrativo'}</span>
          </div>
          <div className="totals-grid">
            <div><small>Subtotal</small><b>{brl.format(subtotal)}</b></div>
            <div><small>Desconto</small><b>{brl.format(effectiveDiscount)}</b></div>
            <div><small>Frete / adicional</small><b>{brl.format(effectiveFreight)}</b></div>
            <div className="grand"><small>Total da venda</small><b>{brl.format(total)}</b></div>
          </div>
          <section className="commercial-terms">
            <div className="field-group"><label>Desconto manual</label><div className="discount-control"><select value={discountMode} disabled={Boolean(sale?.coupon)} onChange={e => { setDiscountMode(e.target.value as 'value' | 'percent'); setSale(undefined); }}><option value="value">R$ valor</option><option value="percent">% percentual</option></select><input value={discountInput} disabled={Boolean(sale?.coupon)} inputMode="decimal" onChange={e => { setDiscountInput(e.target.value); setSale(undefined); }} /></div></div>
            <div className="field-group"><label>Frete / valor adicional</label><input value={freightInput} disabled={Boolean(sale?.coupon)} inputMode="decimal" onChange={e => { setFreightInput(e.target.value); setSale(undefined); }} /></div>
          </section>

          <section className="payment-section">
            <div className="payment-heading">
              <div><h3>Como o cliente vai pagar?</h3><p>Escolha uma forma ativa cadastrada no financeiro do Bling.</p></div>
              <span>{paymentMethods.length} disponíveis</span>
            </div>
            <label className="payment-select-label">Forma de pagamento<select value={paymentMethodId} onChange={e => setPaymentMethodId(e.target.value)} aria-label="Forma de pagamento">
              <option value="">Selecione uma forma cadastrada no Bling</option>
              {paymentMethods.map(method => <option value={method.id} key={method.id}>{paymentIcon(method)} {method.name}</option>)}
            </select></label>
            {!paymentMethods.length && <div className="empty-state compact">Nenhuma forma de pagamento disponível.</div>}
          </section>

          <section className="sale-details">
            <label>Vendedor do Bling<select value={seller} onChange={e => { setSeller(e.target.value); setSale(undefined); }}><option value="">Selecione o vendedor responsável</option>{sellers.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
            {!sellers.length && <p className="inline-warning">Nenhum vendedor retornado pelo Bling. Reconecte a integração e atualize a página.</p>}
            <label>Observações da venda<textarea value={observations} onChange={e => { setObservations(e.target.value); setSale(undefined); }} placeholder="Ex.: venda online, retirada, instruções de troca ou entrega" /></label>
            <label className="fiscal-check"><input type="checkbox" checked={emitFiscal} onChange={e => { setEmitFiscal(e.target.checked); setSale(undefined); }} /><span><b>Gerar NFC-e ao finalizar</b><small>Usa a configuração fiscal cadastrada no Bling.</small></span></label>
            {emitFiscal && integrations?.fiscal && !integrations.fiscal.available && <p className="inline-warning">O acesso fiscal do Bling não está disponível para esta conexão.</p>}
          </section>
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
          <div className="cart-product-info"><b>{i.name}</b><small>{i.sku} · {brl.format(i.price)} un.</small><input className="item-comment" value={i.comment ?? ''} onChange={e => commentItem(i.id, e.target.value)} placeholder="Comentário do item (opcional)" /></div>
          <div className="qty"><button onClick={() => quantity(i.id, -1)}>−</button><span>{i.quantity}</span><button onClick={() => quantity(i.id, 1)}>+</button></div>
          <strong>{brl.format(i.price * i.quantity)}</strong>
        </div>) : <div className="empty-cart"><span>🛍️</span><p>Nenhum produto adicionado</p></div>}</div>
        <div className="cart-summary-card">
          <div><span>Subtotal</span><b>{brl.format(subtotal)}</b></div>
          {effectiveDiscount > 0 && <div className="discount-line"><span>Desconto</span><b>− {brl.format(effectiveDiscount)}</b></div>}
          {effectiveFreight > 0 && <div><span>Frete / adicional</span><b>+ {brl.format(effectiveFreight)}</b></div>}
          <div className="cart-total"><span>Total</span><strong>{brl.format(total)}</strong></div>
          {step === 'product' && <button className="cart-primary" disabled={!items.length} onClick={() => setStep('customer')}>Identificar cliente <kbd>F4</kbd></button>}
          {step === 'customer' && <button className="cart-primary" disabled={!items.length} onClick={() => setStep('payment')}>Ir para pagamento <kbd>F10</kbd></button>}
          {step === 'payment' && <button className="cart-primary" disabled={!items.length || !seller || !paymentMethodId} onClick={complete}>Finalizar · {brl.format(total)}</button>}
        </div>
      </aside>
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
