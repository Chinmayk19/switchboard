import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, messageOf, request } from './api';

interface BillingState {
  status: 'none' | 'incomplete' | 'active' | 'past_due' | 'canceled';
  seats: number;
  can_send: boolean;
  approval_url: string | null;
  paybox_url: string;
  publishable_key: string;
}

const statusText = {
  none: ['Free trial', 'Your workspace can still send messages. Subscribe when you are ready.'],
  incomplete: ['Payment incomplete', 'The subscription starts after Paybox confirms payment.'],
  active: ['Active', 'Your workspace subscription is paid and can send messages.'],
  past_due: ['Past due', 'Paybox is retrying the renewal. Sending continues until it cancels the subscription.'],
  canceled: ['Canceled', 'Agents can read the inbox. Subscribe again to resume sending.'],
};

export function Billing({ workspace }: { workspace: string }) {
  const query = '?' + new URLSearchParams({ workspace });
  const [current, setCurrent] = useState<BillingState>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        const state = await request<BillingState>('/api/billing' + query, { signal: abort.signal });
        if (!abort.signal.aborted) { setCurrent(state); setError(''); }
      } catch (error) {
        if (!abort.signal.aborted) {
          if (error instanceof ApiError && [401, 403].includes(error.status)) setCurrent(undefined);
          setError(messageOf(error));
        }
      }
    }
    void load();
    const timer = window.setInterval(load, 2500);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [query]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current || busy) return;
    setBusy(true);
    setNotice('');
    const form = event.currentTarget;
    const data = new FormData(form);
    const seats = Number(data.get('seats'));
    const resize = current.status === 'active' || current.status === 'past_due';
    const payload: { seats: number; token?: string } = { seats };
    try {
      if (!resize) {
        const response = await fetch(new URL('/v1/tokens', current.paybox_url), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
          headers: { authorization: 'Bearer ' + current.publishable_key, 'content-type': 'application/json' },
          body: JSON.stringify({ card: {
            number: data.get('number'), exp_month: Number(data.get('month')), exp_year: Number(data.get('year')), cvc: data.get('cvc'),
          } }),
        });
        if (!response.ok) {
          setNotice('Paybox could not tokenize this card. Check the test card details and try again.');
          return;
        }
        payload.token = (await response.json()).id;
        form.reset();
      }
      const response = await fetch('/api/billing/' + (resize ? 'seats' : 'subscribe') + query, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (response.status !== 200 && response.status !== 402) {
        setNotice('The billing request could not be confirmed. Check the status before retrying.');
        return;
      }
      const update = await response.json();
      setCurrent(previous => previous && { ...previous, ...update });
      if (response.ok) {
        setNotice(resize ? 'Seat count updated.' : 'Subscription active.');
      } else if (!update.approval_url) {
        setNotice(resize ? 'Paybox declined the change. Your seat count is unchanged.' : 'Payment did not complete. Check Paybox or try a different test card.');
      }
    } catch {
      setNotice('Billing is temporarily unavailable. Check the status before retrying.');
    } finally {
      setBusy(false);
    }
  }

  if (!current) return <section className="billing"><h1>Workspace billing</h1><p role={error ? 'alert' : 'status'}>{error || 'Loading billing...'}</p></section>;
  const resize = current.status === 'active' || current.status === 'past_due';
  const [status, explanation] = statusText[current.status];

  return <section className="billing">
    <h1>Workspace billing</h1>
    <p>$12 USD per seat every 30 days</p>
    <h2>{status}</h2>
    <p>{explanation}</p>
    {current.seats > 0 && <p>Seats on subscription <strong>{current.seats}</strong></p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {current.approval_url ? <p>
      <a className="primary" href={current.approval_url} target="_blank" rel="noopener noreferrer">Approve payment at Paybox</a>
      <br />After you approve or decline, return here. The status updates automatically.
    </p> : <form key={resize + ':' + current.seats} onSubmit={submit}>
      <label>Seats <input name="seats" type="number" min="1" defaultValue={current.seats || 1} required /></label>
      {resize ? <p>Increases are charged immediately for the rest of the period. Decreases credit the next invoice.</p> :
        <fieldset disabled={busy}>
          <legend>Paybox test card</legend>
          <label>Card number <input name="number" inputMode="numeric" maxLength={24} autoComplete="off" required /></label>
          <div className="billing-card-fields">
            <label>Expiry month <input name="month" type="number" min="1" max="12" required /></label>
            <label>Expiry year <input name="year" type="number" min="2000" max="9999" required /></label>
            <label>CVC <input name="cvc" inputMode="numeric" pattern="[0-9]{3,4}" maxLength={4} autoComplete="off" required /></label>
          </div>
          <p>Use a test card. Card details go directly from this browser to Paybox.</p>
        </fieldset>}
      <button className="primary" disabled={busy}>{busy ? 'Processing...' : resize ? 'Update seats' : 'Subscribe'}</button>
    </form>}
  </section>;
}
