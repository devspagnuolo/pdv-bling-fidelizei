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
type PaymentEntry = { key: string; paymentMethodId: string; amount: string; receivedAmount: string; touched?: boolean };
type CashAccount = { id: string; name: string; type: string; active: boolean };
type FinancialCategory = { id: string; name: string; type: number; active: boolean; isDefault?: boolean };
type SalesChannel = { id: string; name: string; businessUnitId?: string; businessUnitName?: string; active: boolean };
type CashSession = { id: string; operatorId: string; sellerId: string; accountId: string; accountName: string; channelId?: string; channelName?: string; businessUnitId?: string; businessUnitName?: string; status: 'OPEN' | 'CLOSED'; openingAmount: number; openedAt: string; closedAt?: string; closingSummary?: any; salesCount?: number; salesTotal?: number };
type CashDay = {
  date: string;
  salesCount: number;
  salesTotal: number;
  paymentTotals: { name: string; amount: number }[];
  blingEntries: { id: string; direction: string; amount: number; description: string; accountName?: string }[];
  operations: { id: string; type: string; amount: number; createdAt: string; data?: { notes?: string; syncStatus?: string; lastError?: string } }[];
  expectedCash: number;
  pendingSales: number;
  canClose?: boolean;
};
type OperationModal = 'open' | 'withdrawal' | 'supply' | 'close' | 'control' | 'orders' | 'return' | 'pending';
type Step = 'product' | 'customer' | 'payment';
type AuthPrincipal = { operatorId: string; operatorName: string; role: 'OPERATOR' | 'MANAGER' };
const storedPrincipal = (): Partial<AuthPrincipal> => {
  try { return JSON.parse(sessionStorage.getItem('pdv-auth-principal') ?? '{}'); } catch { return {}; }
};
const newPaymentKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const numberValue = (value: string) => Math.max(0, Number(value.replace(',', '.')) || 0);
const roundMoney = (value: number) => Math.round(value * 100) / 100;
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const localDate = () => new Date().toLocaleDateString('sv-SE');
const storeReceipt = {
  legalName: import.meta.env.VITE_STORE_LEGAL_NAME || 'VIVI MODA PLUS SIZE COMÉRCIO VAREJISTA E ACESSÓRIOS LTDA - ME',
  cnpj: import.meta.env.VITE_STORE_CNPJ || '35.405.822/0001-37',
  stateRegistration: import.meta.env.VITE_STORE_STATE_REGISTRATION || '121.138.953.114',
  phone: import.meta.env.VITE_STORE_PHONE || '(11) 98600-7779',
  address: import.meta.env.VITE_STORE_ADDRESS || 'Avenida Sapopemba, 700, Loja 10',
  district: import.meta.env.VITE_STORE_DISTRICT || 'Jardim Utinga',
  cityStateZip: import.meta.env.VITE_STORE_CITY_STATE_ZIP || 'Santo André - SP · CEP 09250-301'
};

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
  const [operatorId, setOperatorId] = useState(() => String(storedPrincipal().operatorId ?? ''));
  const [operatorName, setOperatorName] = useState(() => String(storedPrincipal().operatorName ?? ''));
  const [authRole, setAuthRole] = useState<'OPERATOR' | 'MANAGER' | undefined>(() => storedPrincipal().role);
  const [authEnabled, setAuthEnabled] = useState<boolean>();
  const [authToken, setAuthToken] = useState(() => sessionStorage.getItem('pdv-auth-token') ?? '');
  const [loginOperator, setLoginOperator] = useState('');
  const [loginPin, setLoginPin] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [cpf, setCpf] = useState('');
  const [fidelizeiPhone, setFidelizeiPhone] = useState('');
  const [programConsent, setProgramConsent] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerSaving, setCustomerSaving] = useState(false);
  const [customer, setCustomer] = useState<CustomerLookup>();
  const [coupon, setCoupon] = useState('');
  const [sale, setSale] = useState<any>();
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([]);
  const [financialCategories, setFinancialCategories] = useState<FinancialCategory[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [salesChannels, setSalesChannels] = useState<SalesChannel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [selectedBusinessUnit, setSelectedBusinessUnit] = useState('');
  const [cashSession, setCashSession] = useState<CashSession>();
  const [operationModal, setOperationModal] = useState<OperationModal>();
  const [operationAmount, setOperationAmount] = useState('');
  const [operationNotes, setOperationNotes] = useState('');
  const [selectedAccount, setSelectedAccount] = useState('');
  const [dayHistory, setDayHistory] = useState<CashDay>();
  const [countedValues, setCountedValues] = useState<Record<string, string>>({});
  const [operationBusy, setOperationBusy] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [recentSales, setRecentSales] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [ordersSummary, setOrdersSummary] = useState({ count: 0, total: 0, cancelled: 0, deleted: 0 });
  const [orderFrom, setOrderFrom] = useState(localDate());
  const [orderTo, setOrderTo] = useState(localDate());
  const [orderSearch, setOrderSearch] = useState('');
  const [orderScope, setOrderScope] = useState<'all' | 'active' | 'deleted' | 'cancelled'>('active');
  const [pendingOperations, setPendingOperations] = useState<any>();
  const [cashControl, setCashControl] = useState<any>();
  const [cashSessions, setCashSessions] = useState<CashSession[]>([]);
  const [cashFrom, setCashFrom] = useState(localDate());
  const [cashTo, setCashTo] = useState(localDate());
  const [cashSearch, setCashSearch] = useState('');
  const [receipt, setReceipt] = useState<any>();
  const autoOutputId = useRef('');
  const [discountMode, setDiscountMode] = useState<'value' | 'percent'>('value');
  const [discountInput, setDiscountInput] = useState('0');
  const [freightInput, setFreightInput] = useState('0');
  const [observations, setObservations] = useState('');
  const [emitFiscal, setEmitFiscal] = useState(false);
  const [message, setMessage] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scanTimerRef = useRef<number | undefined>(undefined);
  const scanStartedAtRef = useRef(0);
  const scanLastAtRef = useRef(0);
  const scanKeysRef = useRef(0);
  const apiFetch = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) }
    });
    if (response.status === 401 && !url.endsWith('/auth/login')) {
      sessionStorage.removeItem('pdv-auth-token');
    sessionStorage.removeItem('pdv-auth-principal');
      setAuthToken('');
      setOperatorId('');
      setOperatorName('');
      setAuthRole(undefined);
      setMessage('Sua sessão expirou. Entre novamente.');
    }
    return response;
  };


  useEffect(() => {
    apiFetch(`${api}/auth/status`).then(response => response.json()).then(data => setAuthEnabled(data.enabled === true)).catch(() => setAuthEnabled(false));
  }, []);

  useEffect(() => {
    if (!receipt?.id || autoOutputId.current === receipt.id) return;
    autoOutputId.current = receipt.id;
    const timer = window.setTimeout(() => {
      if (receipt.emitFiscal && receipt.fiscalDocumentUrl) {
        window.open(receipt.fiscalDocumentUrl, '_blank', 'noopener,noreferrer');
      } else if (!receipt.emitFiscal) {
        window.print();
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [receipt]);

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
      const response = await apiFetch(`${api}${path}`);
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
      setLoginOperator(s[0]?.id ?? '');
      if (!authToken) setOperatorId(s[0]?.id ?? '');
      const defaultId = methods.find(method => method.isDefault)?.id ?? methods[0]?.id ?? '';
      setPayments(defaultId ? [{ key: newPaymentKey(), paymentMethodId: defaultId, amount: '0', receivedAmount: '' }] : []);
    }).catch(() => setMessage('Não foi possível carregar os dados sincronizados do PDV.'));
    load<FinancialCategory[]>('/catalog/financial-categories').then(categories => {
      setFinancialCategories(categories);
      setCategoryId(categories.find(category => category.isDefault)?.id ?? categories.find(category => /vendas? de mercadorias/i.test(category.name))?.id ?? categories[0]?.id ?? '');
    }).catch(() => setMessage('Autorize no aplicativo Bling o acesso às categorias financeiras para registrar Vendas de mercadorias.'));
  }, []);

  useEffect(() => {
    if (!operatorId) return;
    Promise.all([
      apiFetch(`${api}/cash/configuration`).then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message ?? 'Não foi possível carregar a configuração de caixa do Bling.');
        return data as { accounts: CashAccount[]; channels: SalesChannel[] };
      }),
      apiFetch(`${api}/cash/sessions/current?operatorId=${encodeURIComponent(operatorId)}`).then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message ?? 'Não foi possível consultar o caixa.');
        return data.session as CashSession | undefined;
      })
    ]).then(([configuration, session]) => {
      const accounts = configuration.accounts;
      const channels = configuration.channels;
      setCashAccounts(accounts);
      setSalesChannels(channels);
      setCashSession(session);
      setSelectedAccount(session?.accountId ?? accounts[0]?.id ?? '');
      const channel = channels.find(item => item.id === session?.channelId) ?? channels[0];
      setSelectedChannel(session?.channelId ?? channel?.id ?? '');
      setSelectedBusinessUnit(session?.businessUnitId ?? channel?.businessUnitId ?? '');
    }).catch(error => setMessage(error instanceof Error ? error.message : 'Não foi possível consultar o caixa.'));
  }, [operatorId]);

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
  const paymentSource = paymentMethods[0]?.source;
  const loyaltyCustomer = customer?.fidelizei;
  const paymentTotal = roundMoney(payments.reduce((sum, payment) => sum + numberValue(payment.amount), 0));
  const remainingPayment = roundMoney(total - paymentTotal);
  const isCashMethod = (id: string) => {
    const method = paymentMethods.find(item => item.id === id);
    return Boolean(method && /dinheiro|cash/i.test(`${method.name} ${method.type}`));
  };
  const cashReceived = roundMoney(payments.reduce((sum, payment) => sum + (isCashMethod(payment.paymentMethodId) ? numberValue(payment.receivedAmount) : 0), 0));
  const change = roundMoney(payments.reduce((sum, payment) => {
    if (!isCashMethod(payment.paymentMethodId)) return sum;
    return sum + Math.max(0, numberValue(payment.receivedAmount) - numberValue(payment.amount));
  }, 0));
  const paymentsValid = payments.length > 0
    && Math.abs(remainingPayment) < .01
    && payments.every(payment => payment.paymentMethodId && numberValue(payment.amount) > 0
      && (!isCashMethod(payment.paymentMethodId) || numberValue(payment.receivedAmount) >= numberValue(payment.amount)));

  useEffect(() => {
    setPayments(current => {
      if (!current.length) return current;
      const distributed = roundMoney(current.reduce((sum, payment) => sum + numberValue(payment.amount), 0));
      const difference = roundMoney(total - distributed);
      if (Math.abs(difference) < .01) return current;
      const lastIndex = current.length - 1;
      const adjusted = roundMoney(numberValue(current[lastIndex].amount) + difference);
      if (adjusted < 0) return current;
      return current.map((payment, index) => index === lastIndex
        ? { ...payment, amount: adjusted.toFixed(2) }
        : payment);
    });
  }, [total]);

  const updatePayment = (key: string, patch: Partial<PaymentEntry>) => {
    setPayments(current => current.map(payment => payment.key === key ? { ...payment, ...patch, touched: true } : payment));
  };
  const addPayment = () => {
    const defaultId = paymentMethods.find(method => method.isDefault)?.id ?? paymentMethods[0]?.id ?? '';
    setPayments(current => [...current, {
      key: newPaymentKey(),
      paymentMethodId: defaultId,
      amount: Math.max(0, remainingPayment).toFixed(2),
      receivedAmount: '',
      touched: true
    }]);
  };
  const removePayment = (key: string) => {
    setPayments(current => current.filter(payment => payment.key !== key));
  };
  const fillPaymentBalance = (key: string) => {
    setPayments(current => current.map(payment => payment.key === key
      ? { ...payment, amount: roundMoney(numberValue(payment.amount) + remainingPayment).toFixed(2), touched: true }
      : payment));
  };

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

  const searchCatalog = async (forcedTerm?: string) => {
    const term = (forcedTerm ?? query).trim();
    if (!term) {
      setMessage('Digite o nome, SKU ou código de barras do produto.');
      return;
    }
    setSearchingCatalog(true);
    setMessage('');
    try {
      const response = await apiFetch(`${api}/catalog/products?query=${encodeURIComponent(term)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível consultar os produtos.');
      const normalized = term.toLowerCase();
      const exact = (data as Product[]).find(product =>
        product.sku.toLowerCase() === normalized || product.barcode?.toLowerCase() === normalized
      );
      if (exact) {
        add(exact);
        setQuery('');
        setProducts([]);
        setCatalogSearchActive(false);
        setMessage(`${exact.name} adicionado ao carrinho.`);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
        return;
      }
      setProducts(data);
      setCatalogSearchActive(true);
      if (!data.length) setMessage('Nenhum produto encontrado no Bling.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível consultar os produtos.');
    } finally {
      setSearchingCatalog(false);
    }
  };
  const handleProductInput = (value: string) => {
    const now = performance.now();
    const previousLength = query.length;
    const rapid = scanLastAtRef.current > 0 && now - scanLastAtRef.current < 55;
    if (!rapid || value.length <= previousLength) {
      scanStartedAtRef.current = now;
      scanKeysRef.current = 1;
    } else {
      scanKeysRef.current += Math.max(1, value.length - previousLength);
    }
    scanLastAtRef.current = now;
    setQuery(value);
    setCatalogSearchActive(false);
    if (scanTimerRef.current) window.clearTimeout(scanTimerRef.current);
    const insertedAtOnce = value.length - previousLength >= 4;
    scanTimerRef.current = window.setTimeout(() => {
      const elapsed = scanLastAtRef.current - scanStartedAtRef.current;
      const scannerSpeed = scanKeysRef.current >= 4 && elapsed / Math.max(1, scanKeysRef.current - 1) < 55;
      if (value.trim().length >= 4 && (insertedAtOnce || scannerSpeed)) void searchCatalog(value);
    }, 85);
  };

  const lookup = async () => {
    setMessage('');
    setCustomer(undefined);
    const r = await apiFetch(`${api}/customers/${cpf}`);
    const data = await r.json().catch(() => undefined);
    if (!r.ok) return setMessage(data?.message ?? 'Não foi possível consultar o cliente.');
    setCustomer(data);
    setCustomerName(data.name ?? '');
    setCustomerPhone(data.bling?.phone ?? '');
    setCustomerEmail(data.bling?.email ?? '');
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
    setCustomerName('');
    setCustomerPhone('');
    setCustomerEmail('');
    setCustomer(undefined);
    setCoupon('');
    setSale(undefined);
    setDiscountMode('value');
    setDiscountInput('0');
    setFreightInput('0');
    setObservations('');
    const defaultId = paymentMethods.find(method => method.isDefault)?.id ?? paymentMethods[0]?.id ?? '';
    setPayments(defaultId ? [{ key: newPaymentKey(), paymentMethodId: defaultId, amount: '0', receivedAmount: '' }] : []);
    setEmitFiscal(false);
    setReceipt(undefined);
    setMenuOpen(false);
    setMessage('');
    searchInputRef.current?.focus();
  };

  const enrollFidelizei = async () => {
    if (!customer?.bling || !programConsent) return;
    setMessage('');
    const response = await apiFetch(`${api}/customers/fidelizei`, {
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
  const registerBlingCustomer = async () => {
    if (!customerName.trim() || cpf.replace(/\D/g, '').length !== 11) return setMessage('Informe nome e CPF válido para cadastrar no Bling.');
    setCustomerSaving(true);
    setMessage('');
    try {
      const response = await apiFetch(`${api}/customers/bling`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: customerName, cpf, phone: customerPhone, email: customerEmail })
      });
      const data = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(data?.message ?? 'Não foi possível cadastrar o cliente no Bling.');
      await lookup();
      setMessage(data.idempotent ? 'Cliente já estava cadastrado no Bling.' : 'Cliente cadastrado no Bling e vinculado à venda.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Falha ao cadastrar o cliente no Bling.');
    } finally {
      setCustomerSaving(false);
    }
  };

  const create = async () => {
    if (!cashSession) {
      setMessage('Abra o caixa antes de iniciar a venda.');
      return;
    }
    const r = await apiFetch(`${api}/sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cashSessionId: cashSession.id,
        operatorId,
        sellerId: seller,
        categoryId,
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
    const r = await apiFetch(`${api}/sales/${activeSale.id}/coupon`, {
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
    if (completing) return;
    if (!cashSession) return setMessage('Abra o caixa antes de finalizar a venda.');
    const fiscalPrintWindow = emitFiscal ? window.open('about:blank', '_blank') : null;
    setCompleting(true);
    try {
      const activeSale = sale ?? await create();
      if (!activeSale) return;
      const r = await apiFetch(`${api}/sales/${activeSale.id}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payments: payments.map(payment => ({
            paymentMethodId: payment.paymentMethodId,
            amount: numberValue(payment.amount),
            receivedAmount: isCashMethod(payment.paymentMethodId) ? numberValue(payment.receivedAmount) : undefined
          }))
        })
      });
      const data = await r.json();
      if (!r.ok) return setMessage(data.message ?? 'Não foi possível concluir a venda.');
      const completionMessage = data.status === 'COMPLETED'
        ? `Venda concluída. Pedido Bling nº ${data.blingOrderNumber ?? data.blingOrderId}${data.fiscalStatus === 'REQUESTED' ? data.fiscalDocumentUrl ? ' · Documento fiscal aberto para impressão.' : ' · NFC-e solicitada; aguarde a autorização no Bling para imprimir o documento fiscal.' : data.fiscalStatus === 'FAILED' ? ' · Pedido salvo, mas a NFC-e precisa ser verificada no Bling.' : ' · Impressão do comprovante não fiscal aberta.'}`
        : 'Pedido criado; estoque, financeiro ou situação no Bling exigem conferência.';
      if (emitFiscal && data.fiscalDocumentUrl && fiscalPrintWindow) fiscalPrintWindow.location.replace(data.fiscalDocumentUrl);
      else if (emitFiscal) fiscalPrintWindow?.close();
      newSale();
      if (!emitFiscal) setReceipt(data);
      setMessage(completionMessage);
    } finally {
      setCompleting(false);
    }
  };

  const login = async () => {
    if (!loginOperator || !loginPin) return setMessage('Selecione o operador e informe o PIN.');
    setLoginBusy(true);
    try {
      const response = await fetch(`${api}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operatorId: loginOperator, pin: loginPin })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível entrar.');
      const principal = data.principal as AuthPrincipal;
      sessionStorage.setItem('pdv-auth-token', data.token);
      sessionStorage.setItem('pdv-auth-principal', JSON.stringify(principal));
      setAuthToken(data.token);
      setOperatorId(principal.operatorId);
      setOperatorName(principal.operatorName);
      setAuthRole(principal.role);
      setSeller(current => current || principal.operatorId);
      setLoginPin('');
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Falha no login.');
    } finally {
      setLoginBusy(false);
    }
  };
  const logout = () => {
    sessionStorage.removeItem('pdv-auth-token');
    setAuthToken('');
    setOperatorId('');
    setOperatorName('');
    setAuthRole(undefined);
    setCashSession(undefined);
  };

  const printReceipt = (data: any = receipt ?? sale) => {
    if (!data) return setMessage('Finalize uma venda para imprimir o comprovante.');
    setReceipt(data);
    setMenuOpen(false);
    window.setTimeout(() => window.print(), 120);
  };
  const reprintLast = async () => {
    setMenuOpen(false);
    const response = await apiFetch(`${api}/sales/recent?limit=1`);
    const data = await response.json().catch(() => []);
    if (!response.ok || !data?.[0]) return setMessage('Nenhuma venda concluída disponível para reimpressão.');
    setReceipt(data[0]);
    window.setTimeout(() => window.print(), 120);
  };

  const refreshCashSession = async () => {
    if (!operatorId) return;
    const response = await apiFetch(`${api}/cash/sessions/current?operatorId=${encodeURIComponent(operatorId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? 'Não foi possível atualizar o caixa.');
    setCashSession(data.session ?? undefined);
  };
  const loadCashDay = async () => {
    if (!cashSession) return;
    setOperationBusy(true);
    try {
      const response = await apiFetch(`${api}/cash/day?date=${new Date().toLocaleDateString('sv-SE')}&accountId=${encodeURIComponent(cashSession.accountId)}&sessionId=${encodeURIComponent(cashSession.id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível consultar o movimento do dia no Bling.');
      const paymentTotals = [...data.paymentTotals];
      if (!paymentTotals.some((item: { name: string }) => /dinheiro|cash/i.test(item.name))) {
        paymentTotals.push({ name: 'Dinheiro', amount: data.expectedCash });
      }
      setDayHistory({ ...data, paymentTotals });
      setCountedValues(Object.fromEntries(paymentTotals.map((item: { name: string; amount: number }) => [
        item.name,
        String(/dinheiro|cash/i.test(item.name) ? data.expectedCash : item.amount).replace('.', ',')
      ])));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Falha ao consultar o movimento do dia.');
      setOperationModal(undefined);
    } finally {
      setOperationBusy(false);
    }
  };
  const loadOrders = async (scope = orderScope) => {
    setOperationBusy(true);
    try {
      const params = new URLSearchParams({ limit: '200', from: orderFrom, to: orderTo, scope });
      if (orderSearch.trim()) params.set('search', orderSearch.trim());
      const response = await apiFetch(`${api}/sales/orders?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível consultar os pedidos.');
      setOrders(Array.isArray(data) ? data : data.orders ?? []);
      setOrdersSummary(data.summary ?? { count: 0, total: 0, cancelled: 0, deleted: 0 });
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao consultar pedidos.'); }
    finally { setOperationBusy(false); }
  };
  const loadCashSessions = async () => {
    setOperationBusy(true);
    try {
      const params = new URLSearchParams({ from: cashFrom, to: cashTo, limit: '200' });
      if (cashSearch.trim()) params.set('search', cashSearch.trim());
      const response = await apiFetch(`${api}/cash/sessions?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível consultar os caixas.');
      setCashSessions(data.sessions ?? []);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao consultar os caixas.'); }
    finally { setOperationBusy(false); }
  };
  const loadCashControl = async (sessionId: string) => {
    setOperationBusy(true);
    try {
      const response = await apiFetch(`${api}/cash/control?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível consultar o controle do caixa.');
      setCashControl(data);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao consultar o controle do caixa.'); }
    finally { setOperationBusy(false); }
  };
  const reopenCash = async (session: CashSession) => {
    if (!window.confirm('Reabrir este caixa para realizar ajustes?')) return;
    setOperationBusy(true);
    try {
      const response = await apiFetch(`${api}/cash/sessions/${session.id}/reopen`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível reabrir o caixa.');
      setCashSession(data.session);
      setCashControl(undefined);
      await loadCashSessions();
      setMessage('Caixa reaberto. O evento ficou registrado apenas no controle interno do PDV.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao reabrir o caixa.'); }
    finally { setOperationBusy(false); }
  };
  const deleteCash = async (session: CashSession) => {
    if (!window.confirm('Excluir esta abertura de caixa? Apenas caixas sem vendas, sangrias ou suprimentos podem ser excluídos.')) return;
    setOperationBusy(true);
    try {
      const response = await apiFetch(`${api}/cash/sessions/${session.id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível excluir o caixa.');
      if (cashSession?.id === session.id) setCashSession(undefined);
      setCashControl(undefined);
      await loadCashSessions();
      setMessage('Abertura de teste excluída do controle interno.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao excluir o caixa.'); }
    finally { setOperationBusy(false); }
  };
  const openOperation = (type: OperationModal) => {
    setMenuOpen(false);
    setOperationAmount('');
    setOperationNotes('');
    setOperationModal(type);
    if (type === 'close') void loadCashDay();
    if (type === 'return') {
      apiFetch(`${api}/sales/recent?limit=15`).then(response => response.json()).then(setRecentSales).catch(() => setRecentSales([]));
    }
    if (type === 'orders') {
      setOrders([]);
      void loadOrders();
    }
    if (type === 'control') {
      setCashControl(undefined);
      setCashSessions([]);
      void loadCashSessions();
    }
    if (type === 'pending') {
      setPendingOperations(undefined);
      apiFetch(`${api}/operations/pending`).then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message ?? 'Não foi possível consultar pendências.');
        return data;
      }).then(setPendingOperations).catch(error => setMessage(error instanceof Error ? error.message : 'Falha ao consultar pendências.'));
    }
  };
  const openCash = async () => {
    if (!operatorId || !selectedAccount || !selectedChannel || (selectedChannel !== 'DEFAULT' && !selectedBusinessUnit)) return setMessage('Selecione operador, loja, unidade e conta financeira do Bling.');
    setOperationBusy(true);
    try {
      const response = await apiFetch(`${api}/cash/sessions/open`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operatorId, sellerId: seller, accountId: selectedAccount, channelId: selectedChannel, businessUnitId: selectedBusinessUnit, openingAmount: numberValue(operationAmount) })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível abrir o caixa.');
      setCashSession(data.session);
      setOperationModal(undefined);
      setMessage(`Caixa aberto. O saldo inicial é somente operacional e não gerou movimento financeiro no Bling.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao abrir o caixa.'); }
    finally { setOperationBusy(false); }
  };
  const registerCashOperation = async (type: 'WITHDRAWAL' | 'SUPPLY') => {
    if (!cashSession) return setMessage('Abra o caixa antes de registrar a operação.');
    setOperationBusy(true);
    try {
      const response = await apiFetch(`${api}/cash/entries`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: newPaymentKey(), sessionId: cashSession.id, type, amount: numberValue(operationAmount), notes: operationNotes })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível registrar a operação.');
      setOperationModal(undefined);
      setMessage(`${type === 'WITHDRAWAL' ? 'Sangria' : 'Suprimento'} registrado em Caixas e Bancos do Bling.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha na operação de caixa.'); }
    finally { setOperationBusy(false); }
  };
  const closeCash = async () => {
    if (!cashSession || !dayHistory) return;
    setOperationBusy(true);
    try {
      const response = await apiFetch(`${api}/cash/sessions/${cashSession.id}/close`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          countedValues: dayHistory.paymentTotals.map(item => ({ name: item.name, amount: numberValue(countedValues[item.name] ?? '0') })),
          notes: operationNotes
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível fechar o caixa.');
      setOperationModal(undefined);
      setCashSession(undefined);
      setDayHistory(undefined);
      setMessage('Caixa fechado. O saldo final permaneceu somente no controle interno e não gerou movimento financeiro no Bling.');
      await refreshCashSession();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao fechar o caixa.'); }
    finally { setOperationBusy(false); }
  };
  const deleteOrder = async (order: any) => {
    const label = order.blingOrderNumber ?? order.blingOrderId ?? order.id.slice(0, 8);
    if (!window.confirm(`Excluir o pedido ${label}? A operação estornará contas e estoque e será refletida no Bling.`)) return;
    setOperationBusy(true);
    try {
      const response = await apiFetch(`${api}/sales/${encodeURIComponent(order.id)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível excluir o pedido.');
      await loadOrders();
      setMessage(data.loyaltyWarning ? `Pedido excluído no Bling. Atenção: ${data.loyaltyWarning}` : `Pedido ${label} excluído e estornado no Bling.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao excluir o pedido.'); }
    finally { setOperationBusy(false); }
  };
  const cancelOrder = async (order: any) => {
    const label = order.blingOrderNumber ?? order.blingOrderId ?? order.id.slice(0, 8);
    if (!window.confirm(`Cancelar o pedido ${label}? Contas e estoque serão estornados e o pedido ficará como Cancelado no Bling e no PDV.`)) return;
    setOperationBusy(true);
    try {
      const response = await apiFetch(`${api}/sales/${encodeURIComponent(order.id)}/cancel`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? 'Não foi possível cancelar o pedido.');
      await loadOrders();
      setMessage(data.loyaltyWarning ? `Pedido cancelado. Atenção: ${data.loyaltyWarning}` : `Pedido ${label} cancelado no Bling e no PDV.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao cancelar o pedido.'); }
    finally { setOperationBusy(false); }
  };

  return <main>
    <header className="pos-header">
      <div className="brand-block"><img className="vivi-logo" src="/vivi-logo-original.png" alt="Vivi Moda Plus Size" /><div><small>VIVI MODA · CAIXA 01</small><h1>Frente de caixa</h1><p>Venda integrada ao Bling e Fidelizei</p></div></div>
      <div className="header-actions">
        {authEnabled ? <div className="operator-select authenticated-operator"><span>Operador</span><b>{operatorName || 'Não autenticado'}</b><small>{authRole === 'MANAGER' ? 'Gerente' : 'Operador'}</small>{authToken && <button onClick={logout}>Sair</button>}</div> : <label className="operator-select"><span>Operador</span><select value={operatorId} onChange={e => setOperatorId(e.target.value)}>
          <option value="">Selecione no Bling</option>{sellers.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}
        </select></label>}
        <div className="operations-wrap">
          <button className="operations-trigger" onClick={() => setMenuOpen(value => !value)} aria-expanded={menuOpen}>Operações <b>•••</b></button>
          {menuOpen && <div className="operations-menu">
            <strong>Operações do caixa</strong>
            <button disabled={!cashSession} onClick={() => openOperation('withdrawal')}><span>↘</span><div>Sangria<small>Registra débito em Caixas e Bancos</small></div></button>
            <button disabled={!cashSession} onClick={() => openOperation('supply')}><span>↗</span><div>Suprimento<small>Registra crédito em Caixas e Bancos</small></div></button>
            <button disabled={!cashSession} onClick={() => openOperation('close')}><span>□</span><div>Fechar caixa<small>Conferir o movimento do dia</small></div></button>
            <button onClick={() => openOperation('control')}><span>▥</span><div>Controle de caixa<small>Histórico, relatórios e ajustes</small></div></button>
            <button onClick={() => openOperation('orders')}><span>☷</span><div>Pedidos do PDV<small>Consultar, conferir e excluir no Bling</small></div></button>
            <button onClick={() => printReceipt()} disabled={!sale?.blingOrderId}><span>▣</span><div>Imprimir<small>Comprovante da venda atual</small></div></button>
            <button onClick={() => void reprintLast()}><span>▤</span><div>Reimprimir última operação<small>Busca a última venda concluída</small></div></button>
            <button onClick={() => openOperation('return')}><span>↩</span><div>Gerar devolução<small>Selecionar pedido e continuar no Bling</small></div></button>
            <button onClick={() => openOperation('pending')}><span>!</span><div>Pendências de sincronização<small>Vendas, caixa e webhooks que exigem atenção</small></div></button>
            <div className="menu-routing"><b>{cashSession ? `Caixa aberto · ${cashSession.accountName}` : 'Caixa fechado'}</b><small>Somente vendas, sangrias e suprimentos geram registros financeiros. Troco inicial e fechamento são controles internos.</small></div>
          </div>}
        </div>
        <button className="new-sale-button" onClick={newSale}>＋ Nova venda</button>
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
      <button className={cashSession ? 'cash-status open' : 'cash-status'} onClick={() => cashSession ? openOperation('close') : openOperation('open')}>
        <span className={cashSession ? 'integration-dot online' : 'integration-dot'} />
        <span><b>{cashSession ? 'Caixa aberto' : 'Caixa fechado'}</b><small>{cashSession ? cashSession.accountName : 'Abrir seguindo a conta do Bling'}</small></span>
      </button>
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
            <div className="search-field"><span className="scan-icon">⌁</span><input ref={searchInputRef} id="product-search" className="search" value={query} onChange={e => handleProductInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (scanTimerRef.current) window.clearTimeout(scanTimerRef.current); void searchCatalog(); } }} placeholder="Bipe para adicionar ou digite o código e pressione Enter" autoFocus /><kbd>F2</kbd></div>
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
          </div> : customer ? <div className="empty-state">Cliente não localizado. Cadastre no Bling abaixo ou continue como Consumidor Final.</div> : null}
          {customer && !customer.bling && customer.systems.bling !== 'UNAVAILABLE' && <section className="customer-registration">
            <div><small>CADASTRO RÁPIDO</small><h3>Cadastrar cliente no Bling</h3><p>O cliente ficará disponível no Bling e será vinculado ao pedido desta venda.</p></div>
            <div className="customer-registration-grid">
              <label>Nome completo<input value={customerName} onChange={event => setCustomerName(event.target.value)} placeholder="Nome da cliente" /></label>
              <label>Celular<input value={customerPhone} onChange={event => setCustomerPhone(event.target.value)} placeholder="DDD + número" /></label>
              <label>E-mail<input value={customerEmail} onChange={event => setCustomerEmail(event.target.value)} placeholder="Opcional" type="email" /></label>
              <button className="finish" disabled={customerSaving || !customerName.trim()} onClick={() => void registerBlingCustomer()}>{customerSaving ? 'Salvando no Bling…' : 'Cadastrar no Bling'}</button>
            </div>
          </section>}
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
            <div className="split-payments">
              {payments.map((payment, index) => {
                const method = paymentMethods.find(item => item.id === payment.paymentMethodId);
                const cash = isCashMethod(payment.paymentMethodId);
                const lineChange = cash ? Math.max(0, numberValue(payment.receivedAmount) - numberValue(payment.amount)) : 0;
                return <article className="payment-line" key={payment.key}>
                  <div className="payment-line-title"><b>Pagamento {index + 1}</b>{payments.length > 1 && <button onClick={() => removePayment(payment.key)} aria-label="Remover pagamento">Remover</button>}</div>
                  <div className="payment-line-fields">
                    <label>Forma cadastrada no Bling<select value={payment.paymentMethodId} onChange={event => updatePayment(payment.key, { paymentMethodId: event.target.value, receivedAmount: '' })}>
                      <option value="">Selecione</option>
                      {paymentMethods.map(item => <option value={item.id} key={item.id}>{paymentIcon(item)} {item.name}</option>)}
                    </select></label>
                    <label>Valor nesta forma<input value={payment.amount} inputMode="decimal" onChange={event => updatePayment(payment.key, { amount: event.target.value })} /></label>
                    <button className="fill-balance" onClick={() => fillPaymentBalance(payment.key)} disabled={Math.abs(remainingPayment) < .01 || roundMoney(numberValue(payment.amount) + remainingPayment) <= 0}>Ajustar saldo</button>
                  </div>
                  {method && /cart|credit|debit|crédito|credito|débito|debito/i.test(`${method.name} ${method.type}`) && <p className="bling-rule-note">Taxas, prazo e conta de recebimento seguem a configuração desta forma no Bling.</p>}
                  {cash && <div className="cash-payment">
                    <label><span>Total recebido em dinheiro</span><input value={payment.receivedAmount} inputMode="decimal" placeholder={payment.amount || '0,00'} onChange={event => updatePayment(payment.key, { receivedAmount: event.target.value })} /></label>
                    <div><small>Troco desta parte</small><strong>{brl.format(lineChange)}</strong></div>
                  </div>}
                </article>;
              })}
              <button className="add-payment" onClick={addPayment}>＋ Adicionar outra forma de pagamento</button>
              <div className={Math.abs(remainingPayment) < .01 ? 'payment-balance settled' : remainingPayment < 0 ? 'payment-balance over' : 'payment-balance'}>
                <span>{remainingPayment > .009 ? 'Falta distribuir' : remainingPayment < -.009 ? 'Valor excedente' : 'Pagamento distribuído'}</span>
                <b>{brl.format(Math.abs(remainingPayment))}</b>
              </div>
              {cashReceived > 0 && <div className="cash-summary"><span>Recebido em dinheiro <b>{brl.format(cashReceived)}</b></span><span>Troco total <strong>{brl.format(change)}</strong></span></div>}
            </div>
            {!paymentMethods.length && <div className="empty-state compact">Nenhuma forma de pagamento disponível.</div>}
          </section>

          <section className="sale-details">
            <label>Vendedor do Bling<select value={seller} disabled={Boolean(sale?.coupon)} onChange={e => { setSeller(e.target.value); setSale(undefined); }}><option value="">Selecione o vendedor responsável</option>{sellers.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
            <label>Categoria financeira<select value={categoryId} disabled={Boolean(sale?.coupon)} onChange={e => { setCategoryId(e.target.value); setSale(undefined); }}><option value="">Selecione</option>{financialCategories.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><small>Usada no lançamento de Contas a Receber do Bling.</small></label>
            {!sellers.length && <p className="inline-warning">Nenhum vendedor retornado pelo Bling. Reconecte a integração e atualize a página.</p>}
            <label>Observações da venda<textarea value={observations} disabled={Boolean(sale?.coupon)} onChange={e => { setObservations(e.target.value); setSale(undefined); }} placeholder="Ex.: venda online, retirada, instruções de troca ou entrega" /></label>
            <div className="output-choice">
              <button className={!emitFiscal ? 'active' : ''} disabled={Boolean(sale?.coupon)} onClick={() => { setEmitFiscal(false); setSale(undefined); }}>
                <span>▣</span><b>Comprovante não fiscal</b><small>Padrão · imprimir após concluir</small>
              </button>
              <button className={emitFiscal ? 'active fiscal' : ''} disabled={Boolean(sale?.coupon)} onClick={() => { setEmitFiscal(true); setSale(undefined); }}>
                <span>◇</span><b>Emitir NFC-e</b><small>Somente por seleção · configuração Bling</small>
              </button>
            </div>
            {emitFiscal && integrations?.fiscal && !integrations.fiscal.available && <p className="inline-warning">O acesso fiscal do Bling não está disponível para esta conexão.</p>}
          </section>
          <div className="summary">
            <span>Cliente <b>{customer?.name ?? 'Não identificado'}</b></span>
            <span>Pagamento <b>{paymentsValid ? payments.length > 1 ? `${payments.length} formas` : paymentMethods.find(item => item.id === payments[0]?.paymentMethodId)?.name : 'Distribua o total'}</b></span>
            <span>Vendedor <b>{sellers.find(item => item.id === seller)?.name ?? 'Selecione'}</b></span>
          </div>
          <div className="nav-actions"><button className="secondary" onClick={() => setStep('customer')}>Voltar</button><button className="finish" disabled={!cashSession || completing || !items.length || !seller || !categoryId || !paymentsValid} onClick={complete}>{completing ? 'Finalizando no Bling…' : `Finalizar venda · ${brl.format(total)}`}</button></div>
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
          {step === 'payment' && <button className="cart-primary" disabled={!cashSession || completing || !items.length || !seller || !categoryId || !paymentsValid} onClick={complete}>{completing ? 'Finalizando…' : `Finalizar · ${brl.format(total)}`}</button>}
        </div>
      </aside>
    </section>

    {authEnabled && !authToken && <div className="operation-overlay auth-overlay" role="dialog" aria-modal="true" aria-label="Acesso ao PDV">
      <section className="operation-dialog auth-dialog">
        <div className="operation-dialog-title"><div><small>ACESSO SEGURO</small><h2>Entrar no frente de caixa</h2></div></div>
        <div className="operation-form">
          <p>Selecione seu usuário do Bling e informe o PIN do PDV.</p>
          <label>Operador<select value={loginOperator} onChange={event => setLoginOperator(event.target.value)}><option value="">Selecione</option>{sellers.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label>PIN<input type="password" inputMode="numeric" autoComplete="current-password" value={loginPin} onChange={event => setLoginPin(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void login(); }} /></label>
          <button className="finish" disabled={loginBusy || !loginOperator || !loginPin} onClick={() => void login()}>{loginBusy ? 'Entrando…' : 'Entrar'}</button>
          {message && <p className="message">{message}</p>}
        </div>
      </section>
    </div>}

    {operationModal && <div className="operation-overlay" role="dialog" aria-modal="true" aria-label="Operação de caixa">
      <section className="operation-dialog">
        <div className="operation-dialog-title">
          <div><small>OPERAÇÕES DO CAIXA</small><h2>{operationModal === 'open' ? 'Abrir caixa' : operationModal === 'withdrawal' ? 'Sangria' : operationModal === 'supply' ? 'Suprimento' : operationModal === 'close' ? 'Fechar caixa' : operationModal === 'control' ? 'Controle de caixa' : operationModal === 'orders' ? 'Pedidos do PDV' : operationModal === 'return' ? 'Gerar devolução' : 'Pendências de sincronização'}</h2></div>
          <button onClick={() => setOperationModal(undefined)} aria-label="Fechar">×</button>
        </div>
        {operationModal === 'open' && <div className="operation-form">
          <div className="opening-notice"><b>Caixa fechado</b><span>Selecione a mesma loja e unidade de negócio configuradas no Frente de Caixa do Bling.</span></div>
          <label>Loja / canal de venda<select value={selectedChannel} onChange={event => {
            const id = event.target.value;
            const channel = salesChannels.find(item => item.id === id);
            setSelectedChannel(id);
            setSelectedBusinessUnit(channel?.businessUnitId ?? '');
          }}><option value="">Selecione</option>{salesChannels.map(channel => <option value={channel.id} key={channel.id}>{channel.name}</option>)}</select></label>
          <label>Unidade de negócio<select value={selectedChannel === 'DEFAULT' ? 'DEFAULT' : selectedBusinessUnit} onChange={event => setSelectedBusinessUnit(event.target.value)} disabled={!selectedChannel || selectedChannel === 'DEFAULT'}><option value="">{selectedChannel === 'DEFAULT' ? 'Configuração padrão do Bling' : 'Selecione'}</option>{selectedChannel === 'DEFAULT' && <option value="DEFAULT">Configuração padrão do Bling</option>}{salesChannels.filter(channel => channel.id === selectedChannel && channel.businessUnitId).map(channel => <option value={channel.businessUnitId} key={channel.businessUnitId}>{channel.businessUnitName ?? 'Unidade do Bling'}</option>)}</select></label>
          <label>Troco / saldo inicial<input value={operationAmount} inputMode="decimal" placeholder="0,00" onChange={event => setOperationAmount(event.target.value)} /></label>
          <details className="opening-routing"><summary>Conta financeira usada nos lançamentos</summary><label>Conta financeira do Bling<select value={selectedAccount} onChange={event => setSelectedAccount(event.target.value)}><option value="">Selecione</option>{cashAccounts.map(account => <option value={account.id} key={account.id}>{account.name} · {account.type}</option>)}</select></label></details>
          <button className="finish" disabled={operationBusy || !selectedAccount || !selectedChannel || (selectedChannel !== 'DEFAULT' && !selectedBusinessUnit)} onClick={() => void openCash()}>{operationBusy ? 'Abrindo…' : 'Abrir caixa'}</button>
        </div>}
        {(operationModal === 'withdrawal' || operationModal === 'supply') && <div className="operation-form">
          <div className="operation-account"><span>Conta financeira</span><b>{cashSession?.accountName}</b></div>
          <label>Valor<input value={operationAmount} inputMode="decimal" autoFocus placeholder="0,00" onChange={event => setOperationAmount(event.target.value)} /></label>
          <label>Motivo / observação<textarea value={operationNotes} onChange={event => setOperationNotes(event.target.value)} placeholder={operationModal === 'withdrawal' ? 'Ex.: retirada para depósito bancário' : 'Ex.: reforço de troco'} /></label>
          <button className="finish" disabled={operationBusy || numberValue(operationAmount) <= 0} onClick={() => void registerCashOperation(operationModal === 'withdrawal' ? 'WITHDRAWAL' : 'SUPPLY')}>{operationBusy ? 'Registrando no Bling…' : `Registrar ${operationModal === 'withdrawal' ? 'sangria' : 'suprimento'} no Bling`}</button>
        </div>}
        {operationModal === 'control' && <div className="closing-review cash-control">
          {!cashControl ? <>
            <div className="report-filters">
              <label>Início<input type="date" value={cashFrom} onChange={event => setCashFrom(event.target.value)} /></label>
              <label>Fim<input type="date" value={cashTo} onChange={event => setCashTo(event.target.value)} /></label>
              <label>Operador ou loja<input value={cashSearch} placeholder="Pesquisar" onChange={event => setCashSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void loadCashSessions(); }} /></label>
              <button className="finish" disabled={operationBusy} onClick={() => void loadCashSessions()}>Filtrar caixas</button>
            </div>
            <div className="cash-session-table">
              <div className="table-head"><span>Loja</span><span>Operador</span><span>Abertura</span><span>Vendas</span><span>Total</span><span>Situação</span><span>Ações</span></div>
              {cashSessions.map(session => <div className="table-row" key={session.id}>
                <button className="row-link" onClick={() => void loadCashControl(session.id)}>{session.channelName ?? 'Configuração padrão'}</button>
                <span>{sellers.find(item => item.id === session.sellerId)?.name ?? session.operatorId}</span>
                <span>{new Date(session.openedAt).toLocaleString('pt-BR')}</span>
                <span>{session.salesCount ?? 0}</span>
                <b>{brl.format(session.salesTotal ?? 0)}</b>
                <span className={session.status === 'OPEN' ? 'status-open' : 'status-closed'}>{session.status === 'OPEN' ? 'Aberto' : 'Fechado'}</span>
                <span className="row-actions"><button onClick={() => void loadCashControl(session.id)}>Relatório</button>{session.status === 'CLOSED' && <button onClick={() => void reopenCash(session)}>Reabrir</button>}<button className="danger-action" onClick={() => void deleteCash(session)}>Excluir</button></span>
              </div>)}
              {!cashSessions.length && <div className="empty-state compact">{operationBusy ? 'Carregando caixas…' : 'Nenhum caixa encontrado no período.'}</div>}
            </div>
          </> : <>
            <div className="report-toolbar"><button className="secondary" onClick={() => setCashControl(undefined)}>← Voltar aos caixas</button><span className={cashControl.session.status === 'OPEN' ? 'status-open' : 'status-closed'}>{cashControl.session.status === 'OPEN' ? 'Caixa aberto' : 'Caixa fechado'}</span>{cashControl.session.status === 'CLOSED' && <button onClick={() => void reopenCash(cashControl.session)}>Reabrir caixa</button>}<button className="danger-action" onClick={() => void deleteCash(cashControl.session)}>Excluir caixa</button></div>
            <div className="operation-account"><span>{cashControl.session.channelName ?? 'Loja do Bling'} · {cashControl.session.businessUnitName ?? 'Unidade de negócio'}<small>Abertura: {new Date(cashControl.session.openedAt).toLocaleString('pt-BR')}{cashControl.session.closedAt ? ` · Fechamento: ${new Date(cashControl.session.closedAt).toLocaleString('pt-BR')}` : ''}</small></span><b>{sellers.find(item => item.id === cashControl.session.sellerId)?.name ?? cashControl.session.operatorId}</b></div>
            <div className="closing-summary">
              <div><small>Saldo inicial</small><b>{brl.format(cashControl.session.openingAmount)}</b></div>
              <div><small>Vendas</small><b>{cashControl.salesCount}</b></div>
              <div><small>Total vendido</small><b>{brl.format(cashControl.salesTotal)}</b></div>
              <div><small>Dinheiro esperado</small><b>{brl.format(cashControl.expectedCash)}</b></div>
            </div>
            {cashControl.pendingSales > 0 && <p className="inline-warning">{cashControl.pendingSales} venda(s) aguardando sincronização.</p>}
            <h3>Formas de pagamento</h3>
            <div className="report-table"><div className="table-head"><span>Nome</span><span>Total registrado</span><span>Total informado</span><span>Diferença</span></div>{cashControl.paymentTotals.map((item: any) => {
              const reconciled = cashControl.session.closingSummary?.reconciliation?.find((entry: any) => entry.name === item.name);
              return <div className="table-row" key={item.name}><b>{item.name}</b><span>{brl.format(item.amount)}</span><span>{reconciled ? brl.format(reconciled.counted) : '—'}</span><span className={reconciled?.difference ? 'difference' : ''}>{reconciled ? brl.format(reconciled.difference) : '—'}</span></div>;
            })}</div>
            <h3>Vendas desta abertura</h3>
            <div className="report-table"><div className="table-head"><span>Pedido</span><span>Cliente</span><span>Data</span><span>Desconto</span><span>Total</span></div>{cashControl.sales.map((item: any) => <div className="table-row" key={item.id}><b>{item.orderNumber ?? item.orderId ?? item.id.slice(0, 8)}</b><span>{item.customerName}</span><span>{new Date(item.createdAt).toLocaleString('pt-BR')}</span><span>{brl.format(item.discount ?? 0)}</span><b>{brl.format(item.total)}</b></div>)}</div>
            {cashControl.discountsTotal > 0 && <><h3>Descontos concedidos</h3><div className="bling-history">{cashControl.sales.filter((item: any) => item.discount > 0).map((item: any) => <div key={item.id}><span>Pedido {item.orderNumber ?? item.orderId}<small>{item.customerName}</small></span><b>− {brl.format(item.discount)}</b></div>)}<div><strong>Total</strong><strong>− {brl.format(cashControl.discountsTotal)}</strong></div></div></>}
            <h3>Sangrias e suprimentos</h3>
            <div className="bling-history">{cashControl.operations.filter((item: any) => ['WITHDRAWAL','SUPPLY'].includes(item.type)).map((item: any) => <div key={item.id}><span>{item.type === 'WITHDRAWAL' ? 'Sangria' : 'Suprimento'}<small>{new Date(item.createdAt).toLocaleString('pt-BR')} · {item.data?.notes ?? 'Sem observação'}</small></span><b className={item.type === 'WITHDRAWAL' ? 'debit' : 'credit'}>{item.type === 'WITHDRAWAL' ? '−' : '+'} {brl.format(item.amount)}</b></div>)}</div>
            <h3>Histórico operacional</h3>
            <div className="bling-history">{cashControl.operations.map((item: any) => <div key={item.id}><span>{item.type === 'OPENING' ? 'Abertura' : item.type === 'REOPENING' ? 'Reabertura' : item.type === 'WITHDRAWAL' ? 'Sangria' : item.type === 'SUPPLY' ? 'Suprimento' : item.type === 'CLOSING' ? 'Fechamento' : item.type}<small>{new Date(item.createdAt).toLocaleString('pt-BR')}</small></span><b>{['OPENING','CLOSING','REOPENING'].includes(item.type) ? 'Controle interno' : brl.format(item.amount)}</b></div>)}</div>
          </>}
        </div>}
        {operationModal === 'close' && <div className="closing-review">
          {operationBusy && !dayHistory ? <div className="empty-state">Consultando o movimento no Bling…</div> : dayHistory && <>
            <div className="closing-summary">
              <div><small>Vendas do dia</small><b>{dayHistory.salesCount}</b></div>
              <div><small>Total vendido</small><b>{brl.format(dayHistory.salesTotal)}</b></div>
              <div><small>Lançamentos Bling</small><b>{dayHistory.blingEntries.length}</b></div>
            </div>
            {dayHistory.pendingSales > 0 && <p className="inline-warning">Há {dayHistory.pendingSales} venda(s) pendente(s) de sincronização. Elas permanecerão na gestão de pedidos e não impedem o fechamento.</p>}
            <h3>Conferência por forma de pagamento</h3>
            <p className="muted">Confira o valor físico/operacional antes de fechar. Os valores registrados vêm das vendas deste PDV.</p>
            <div className="counted-list">{dayHistory.paymentTotals.length ? dayHistory.paymentTotals.map(item => {
              const expected = /dinheiro|cash/i.test(item.name) ? dayHistory.expectedCash : item.amount;
              const counted = numberValue(countedValues[item.name] ?? '0');
              return <div key={item.name}><span><b>{item.name}</b><small>Esperado: {brl.format(expected)}</small></span><label>Valor conferido<input value={countedValues[item.name] ?? ''} inputMode="decimal" placeholder="Informe o valor contado" onChange={event => setCountedValues(current => ({ ...current, [item.name]: event.target.value }))} /></label><strong className={countedValues[item.name] !== undefined && Math.abs(counted - expected) < .01 ? 'match' : 'difference'}>{countedValues[item.name] === undefined ? 'Aguardando conferência' : Math.abs(counted - expected) < .01 ? 'Conferido' : `Diferença ${brl.format(counted - expected)}`}</strong></div>;
            }) : <div className="empty-state compact">Nenhuma venda registrada hoje.</div>}</div>
            <h3>Histórico financeiro do Bling</h3>
            <div className="bling-history">{dayHistory.blingEntries.length ? dayHistory.blingEntries.map(entry => <div key={entry.id}><span>{entry.description}<small>{entry.accountName ?? cashSession?.accountName}</small></span><b className={entry.direction === 'D' ? 'debit' : 'credit'}>{entry.direction === 'D' ? '−' : '+'} {brl.format(entry.amount)}</b></div>) : <div className="empty-state compact">Sem lançamentos no Bling para esta conta hoje.</div>}</div>
            <label>Observação do fechamento<textarea value={operationNotes} onChange={event => setOperationNotes(event.target.value)} placeholder="Opcional" /></label>
            <div className="dialog-actions"><button className="secondary" onClick={() => setOperationModal(undefined)}>Cancelar</button><button className="finish" disabled={operationBusy} onClick={() => void closeCash()}>{operationBusy ? 'Sincronizando…' : 'Confirmar fechamento'}</button></div>
          </>}
        </div>}
        {operationModal === 'orders' && <div className="closing-review order-management">
          <p className="muted">Pedidos gerados neste PDV. A exclusão estorna contas e estoque e remove o pedido correspondente no Bling.</p>
          <div className="order-scope-tabs" role="tablist"><button className={orderScope === 'active' ? 'active' : ''} onClick={() => { setOrderScope('active'); void loadOrders('active'); }}>Ativos</button><button className={orderScope === 'deleted' ? 'active' : ''} onClick={() => { setOrderScope('deleted'); void loadOrders('deleted'); }}>Excluídos</button><button className={orderScope === 'cancelled' ? 'active' : ''} onClick={() => { setOrderScope('cancelled'); void loadOrders('cancelled'); }}>Cancelados</button><button className={orderScope === 'all' ? 'active' : ''} onClick={() => { setOrderScope('all'); void loadOrders('all'); }}>Todos</button></div>
          <div className="report-filters order-filters"><label>Início<input type="date" value={orderFrom} onChange={event => setOrderFrom(event.target.value)} /></label><label>Fim<input type="date" value={orderTo} onChange={event => setOrderTo(event.target.value)} /></label><label>Cliente, CPF ou pedido<input value={orderSearch} placeholder="Pesquisar" onChange={event => setOrderSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void loadOrders(); }} /></label><button className="finish" disabled={operationBusy} onClick={() => void loadOrders()}>Filtrar pedidos</button></div>
          <div className="closing-summary order-summary"><div><small>Pedidos ativos</small><b>{ordersSummary.count}</b></div><div><small>Total ativo</small><b>{brl.format(ordersSummary.total)}</b></div><div><small>Excluídos</small><b>{ordersSummary.deleted}</b></div><div><small>Cancelados</small><b>{ordersSummary.cancelled}</b></div></div>
          <div className="order-table"><div className="table-head"><span>Número</span><span>Data</span><span>Cliente</span><span>Total</span><span>Situação</span><span>Ações</span></div>{orders.map(item => <div className="table-row" key={item.id}>
            <b>{item.blingOrderNumber ?? item.blingOrderId ?? item.id.slice(0, 8)}</b><span>{new Date(item.createdAt).toLocaleString('pt-BR')}</span><span>{item.customer?.name ?? 'Consumidor Final'}<small>{item.customer?.cpf ?? ''}</small></span><b>{brl.format(item.total)}</b><span className={item.status === 'DELETED' || item.status === 'CANCELLED' ? 'status-cancelled' : 'status-open'}>{item.status === 'DELETED' ? 'Excluído' : item.status === 'CANCELLED' ? 'Cancelado' : item.status === 'COMPLETED' ? 'Atendido' : item.status}</span><span className="order-row-actions">{!['DELETED','CANCELLED','PROCESSING'].includes(item.status) && <><button className="cancel-action" disabled={operationBusy} onClick={() => void cancelOrder(item)}>Cancelar</button><button className="danger-action" disabled={operationBusy} onClick={() => void deleteOrder(item)}>Excluir</button></>}</span>
          </div>)}{!orders.length && <div className="empty-state compact">{operationBusy ? 'Consultando pedidos…' : 'Nenhum pedido encontrado no período.'}</div>}</div>
        </div>}
        {operationModal === 'pending' && <div className="return-list pending-list">
          {!pendingOperations ? <div className="empty-state">Consultando pendências…</div> : <>
            <div className="closing-summary">
              <div><small>Vendas</small><b>{pendingOperations.counts.sales}</b></div>
              <div><small>Caixa</small><b>{pendingOperations.counts.cash}</b></div>
              <div><small>Webhooks</small><b>{pendingOperations.counts.webhooks}</b></div>
            </div>
            {!pendingOperations.counts.sales && !pendingOperations.counts.cash && !pendingOperations.counts.webhooks
              ? <div className="empty-state">Tudo sincronizado. Nenhuma pendência operacional.</div>
              : <>
                {pendingOperations.sales.map((item: any) => <div key={item.id}><span><b>Venda {item.blingOrderId || item.id.slice(0, 8)}</b><small>{item.status} · tentativa {item.attempts || 0}</small><small>{item.lastError || 'Aguardando processamento'}</small></span></div>)}
                {pendingOperations.cash.map((item: any) => <div key={item.id}><span><b>{item.type === 'WITHDRAWAL' ? 'Sangria' : item.type === 'SUPPLY' ? 'Suprimento' : 'Abertura'} · {brl.format(item.amount)}</b><small>{item.status}</small><small>{item.lastError || 'Aguardando processamento'}</small></span></div>)}
                {pendingOperations.webhooks.map((item: any) => <div key={item.eventId}><span><b>{item.event}</b><small>{item.status} · tentativa {item.attempts}</small><small>{item.lastError || 'Aguardando processamento'}</small></span></div>)}
              </>
            }
          </>}
        </div>}
        {operationModal === 'return' && <div className="return-list">
          <p>Escolha a venda. A devolução será concluída no pedido correspondente do Bling, preservando estoque, financeiro e documento fiscal.</p>
          {recentSales.length ? recentSales.map(item => <div key={item.id}><span><b>Pedido {item.blingOrderNumber ?? item.blingOrderId}</b><small>{new Date(item.createdAt).toLocaleString('pt-BR')} · {brl.format(item.total)}</small></span><button onClick={() => window.open('https://www.bling.com.br/pedidos-venda', '_blank', 'noopener,noreferrer')}>Abrir no Bling</button></div>) : <div className="empty-state compact">Nenhuma venda concluída encontrada.</div>}
          <p className="integration-explanation">O PDV não cria uma devolução simulada: o fluxo oficial do Bling é aberto para manter as regras fiscais e financeiras da venda.</p>
        </div>}
      </section>
    </div>}

    {receipt && <div className="receipt-overlay" role="dialog" aria-modal="true" aria-label="Comprovante não fiscal">
      <section className="receipt-sheet">
        <div className="receipt-brand">
          <img src="/vivi-logo-original.png" alt="Vivi Moda Plus Size" />
          <b>{storeReceipt.legalName}</b>
          <small>CNPJ {storeReceipt.cnpj} · IE {storeReceipt.stateRegistration}</small>
          <small>Tel. {storeReceipt.phone}</small>
          <small>{storeReceipt.address}</small>
          <small>{storeReceipt.district} · {storeReceipt.cityStateZip}</small>
        </div>
        <div className="receipt-document-title"><b>COMPROVANTE NÃO FISCAL</b><small>Documento sem valor fiscal</small></div>
        <div className="receipt-meta">
          <span>Pedido Bling <b>{receipt.blingOrderNumber ?? receipt.blingOrderId ?? 'Pendente'}</b></span>
          <span>Data <b>{new Date(receipt.createdAt).toLocaleString('pt-BR')}</b></span>
          <span>Cliente <b>{receipt.customer?.name ?? 'Consumidor Final'}</b></span>
          {receipt.customer?.cpf && <span>CPF <b>{receipt.customer.cpf}</b></span>}
          <span>Vendedor <b>{sellers.find(item => item.id === receipt.sellerId)?.name ?? receipt.sellerId}</b></span>
        </div>
        <div className="receipt-table-head"><span>Item</span><span>Qtd.</span><span>Unit.</span><span>Total</span></div>
        <div className="receipt-items">{receipt.items?.map((item: any) => <div key={item.productId}>
          <span><b>{item.name}</b><small>{item.sku}{item.comment ? ` · ${item.comment}` : ''}</small></span>
          <span>{item.quantity}</span>
          <span>{brl.format(item.unitPrice)}</span>
          <b>{brl.format(item.quantity * item.unitPrice)}</b>
        </div>)}</div>
        <div className="receipt-totals">
          <span>Subtotal <b>{brl.format(receipt.subtotal ?? 0)}</b></span>
          {(receipt.discount ?? 0) > 0 && <span>Desconto{receipt.coupon?.code ? ` · Cupom ${receipt.coupon.code}` : ''} <b>− {brl.format(receipt.discount)}</b></span>}
          {(receipt.freight ?? 0) > 0 && <span>Frete / adicional <b>+ {brl.format(receipt.freight)}</b></span>}
          <strong>Total <b>{brl.format(receipt.total ?? 0)}</b></strong>
        </div>
        <div className="receipt-payments"><b>Pagamentos</b>{receipt.payments?.map((payment: any, index: number) => <span key={index}><span>{new Date(receipt.createdAt).toLocaleDateString('pt-BR')} · {payment.paymentMethodName}</span><strong>{brl.format(payment.amount)}</strong></span>)}</div>
        {(receipt.amountReceived ?? 0) > 0 && <div className="receipt-cash-detail"><span>Valor recebido <b>{brl.format(receipt.amountReceived)}</b></span>{(receipt.change ?? 0) > 0 && <span>Troco <b>{brl.format(receipt.change)}</b></span>}</div>}
        {receipt.observations && <p className="receipt-observations"><b>Observações:</b> {receipt.observations}</p>}
        <p className="receipt-exchange">Para trocas ou devoluções, apresente este comprovante.</p>
        <p className="receipt-thanks">Ficamos felizes em atendê-la.<br />Volte sempre!</p>
        <div className="receipt-actions no-print"><button className="secondary" onClick={() => setReceipt(undefined)}>Fechar</button><button className="finish" onClick={() => window.print()}>Imprimir comprovante</button></div>
      </section>
    </div>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);


