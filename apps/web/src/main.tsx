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
  const [items, setItems] = useState<Item[]>([]);
  const [query, setQuery] = useState('');
  const [seller, setSeller] = useState('');
  const [cpf, setCpf] = useState('');
  const [customer, setCustomer] = useState<any>();
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
  const filtered = products.filter(p => `${p.name} ${p.sku}`.toLowerCase().includes(query.toLowerCase()));
  const selectedPaymentMethod = paymentMethods.find(method => method.id === paymentMethodId);
  const paymentSource = paymentMethods[0]?.source;

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

  const lookup = async () => {
    setMessage('');
    const r = await fetch(`${api}/customers/${cpf}`);
    const data = await r.json().catch(() => undefined);
    setCustomer(data);
    setMessage(data ? '' : 'Cliente não localizado no Fidelizei.');
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

    <nav className="steps">
      <button className={step === 'product' ? 'active' : ''} onClick={() => setStep('product')}>1 · Produto</button>
      <button className={step === 'customer' ? 'active' : ''} onClick={() => setStep('customer')}>2 · Cliente</button>
      <button className={step === 'payment' ? 'active' : ''} onClick={() => setStep('payment')}>3 · Pagamento</button>
    </nav>

    <section className="workspace">
      <article className="panel">
        {step === 'product' && <>
          <div className="section-title"><div><small>ETAPA 1</small><h2>Adicionar produtos</h2></div><span>{products.length} itens sincronizados</span></div>
          <input className="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Pesquisar produto, descrição ou SKU" autoFocus />
          <div className="catalog">{filtered.map(p => <button className="product" disabled={!p.stock} onClick={() => add(p)} key={p.id}>
            <span><b>{p.name}</b><small>{p.sku} · {p.stock} em estoque</small></span><strong>{brl.format(p.price)}</strong>
          </button>)}</div>
          <button className="next" disabled={!items.length} onClick={() => setStep('customer')}>Continuar para cliente</button>
        </>}

        {step === 'customer' && <>
          <div className="section-title"><div><small>ETAPA 2</small><h2>Identificar cliente</h2></div><span>Fidelizei</span></div>
          <label>CPF<div className="row"><input value={cpf} onChange={e => { setCpf(e.target.value); setCustomer(undefined); setSale(undefined); }} placeholder="000.000.000-00" /><button onClick={lookup}>Consultar</button></div></label>
          {customer ? <div className="customer-card">
            <div><span className="vip">VIP {customer.tier}</span><h3>{customer.name}</h3><p>{customer.points} pontos disponíveis</p></div>
            <div><b>Benefícios</b>{customer.benefits.map((benefit: string) => <span key={benefit}>✓ {benefit}</span>)}</div>
          </div> : <div className="empty-state">Informe o CPF para consultar nível, pontos, benefícios e cupons.</div>}
          <label>Cupom Fidelizei<div className="row"><input value={coupon} onChange={e => setCoupon(e.target.value.toUpperCase())} placeholder="Digite o código do cupom" /><button disabled={!customer || !coupon} onClick={applyCoupon}>Validar</button></div></label>
          <div className="nav-actions"><button className="secondary" onClick={() => setStep('product')}>Voltar</button><button className="next" disabled={!customer} onClick={() => setStep('payment')}>Continuar para pagamento</button></div>
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
