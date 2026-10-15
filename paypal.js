// functions/paypal.js  —  recargas, membresía (pago manual) y comisión con PayPal
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const PAYPAL_ID = defineSecret('PAYPAL_CLIENT_ID');
const PAYPAL_SECRET = defineSecret('PAYPAL_SECRET');
const SANDBOX = false; // true = pruebas con cuentas sandbox de PayPal
const API = SANDBOX ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
const GRATIS_HASTA = new Date('2026-11-30T23:59:59-06:00').getTime();
const PRECIOS = { empresa: { nac: 4.99, int: 9.99 }, cliente: { nac: 0, int: 4.99 } };
const r2 = (n) => Math.round(n * 100) / 100;

/* Verifica con PayPal que la orden esté pagada y sea del usuario que llama */
async function ordenPagada(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Inicia sesión.');
  const orderId = String(req.data?.orderId || '');
  if (!/^[A-Za-z0-9]{10,30}$/.test(orderId)) throw new HttpsError('invalid-argument', 'Orden inválida.');
  const tk = await (await fetch(API + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(PAYPAL_ID.value() + ':' + PAYPAL_SECRET.value()).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })).json();
  if (!tk.access_token) throw new HttpsError('internal', 'No se pudo conectar con PayPal.');
  const o = await (await fetch(API + '/v2/checkout/orders/' + orderId, {
    headers: { Authorization: 'Bearer ' + tk.access_token },
  })).json();
  const pu = o.purchase_units && o.purchase_units[0];
  const cap = pu && pu.payments && pu.payments.captures && pu.payments.captures[0];
  if (o.status !== 'COMPLETED' || !cap || cap.status !== 'COMPLETED')
    throw new HttpsError('failed-precondition', 'El pago no está completado.');
  if (pu.custom_id !== req.auth.uid) throw new HttpsError('permission-denied', 'Esta orden no es tuya.');
  if (cap.amount.currency_code !== 'USD') throw new HttpsError('failed-precondition', 'Moneda no válida.');
  const monto = r2(parseFloat(cap.amount.value));
  if (!(monto > 0)) throw new HttpsError('failed-precondition', 'Monto inválido.');
  return { orderId, monto, ref: pu.reference_id || '' };
}

/* ---------- 1) Recarga de saldo ---------- */
exports.acreditarPaypal = onCall({ secrets: [PAYPAL_ID, PAYPAL_SECRET] }, async (req) => {
  const { orderId, monto } = await ordenPagada(req);
  const mref = db.doc(`usuarios/${req.auth.uid}/movimientos/${orderId}`);
  const uref = db.doc(`usuarios/${req.auth.uid}`);
  await db.runTransaction(async (t) => {
    const m = await t.get(mref);
    if (m.exists) return; // ya acreditada: no se duplica
    t.set(mref, { tipo: 'deposito', monto, orderId, creada: admin.firestore.FieldValue.serverTimestamp() });
    t.update(uref, { saldo: admin.firestore.FieldValue.increment(monto) });
  });
  return { monto };
});

/* ---------- 2) Pago de membresía (manual, 1/3/6/12 meses) ---------- */
exports.pagarMembresia = onCall({ secrets: [PAYPAL_ID, PAYPAL_SECRET] }, async (req) => {
  const { orderId, monto, ref } = await ordenPagada(req);
  const mm = /^memb_(1|3|6|12)$/.exec(ref);
  if (!mm) throw new HttpsError('invalid-argument', 'Pago de membresía inválido.');
  const meses = parseInt(mm[1], 10);
  const uref = db.doc(`usuarios/${req.auth.uid}`);
  const pref = db.doc(`usuarios/${req.auth.uid}/pagosMembresia/${orderId}`);
  let hastaMs = 0;
  await db.runTransaction(async (t) => {
    const [u, p] = await Promise.all([t.get(uref), t.get(pref)]);
    if (p.exists) { hastaMs = p.data().hasta.toMillis(); return; } // ya procesado
    const d = u.data() || {};
    const precio = (PRECIOS[d.rol] || {})[d.plan] || 0;
    if (!(precio > 0)) throw new HttpsError('failed-precondition', 'Tu plan no requiere pago.');
    if (Math.abs(monto - r2(precio * meses)) > 0.005) throw new HttpsError('failed-precondition', 'El monto no coincide con tu plan.');
    const actual = d.membresiaHasta && d.membresiaHasta.toMillis ? d.membresiaHasta.toMillis() : 0;
    const f = new Date(Math.max(Date.now(), actual, GRATIS_HASTA)); // cuenta desde que termina lo gratis o lo ya pagado
    f.setMonth(f.getMonth() + meses);
    hastaMs = f.getTime();
    const hasta = admin.firestore.Timestamp.fromMillis(hastaMs);
    t.set(pref, { meses, monto, orderId, hasta, creada: admin.firestore.FieldValue.serverTimestamp() });
    t.update(uref, { membresiaHasta: hasta, renovacion: d.renovacion || 'manual' });
  });
  return { hasta: hastaMs };
});

/* ---------- 3) Comisión del 5% al aceptar una oferta ----------
   ¡OJO! Súbela SOLO si tu función actual NO descuenta ya la comisión;
   si no, se cobraría doble. Para activarla, en functions/index.js agrega:
     exports.cobrarComision = require('./paypal').cobrarComision;            */
async function tasaUSD(moneda, respaldo) {
  if (!moneda || moneda === 'USD') return 1;
  try {
    const j = await (await fetch('https://open.er-api.com/v6/latest/USD')).json();
    if (j && j.rates && j.rates[moneda] > 0) return j.rates[moneda];
  } catch (e) {}
  return respaldo > 0 ? respaldo : 1;
}
exports.cobrarComision = onDocumentUpdated('solicitudes/{id}', async (ev) => {
  const antes = ev.data.before.data(), d = ev.data.after.data();
  if (antes.estado === 'aceptada' || d.estado !== 'aceptada' || !d.ofertaId) return;
  const tasa = await tasaUSD(d.moneda, d.tasa);
  const comision = r2((d.precio / tasa) * 0.05);
  const mref = db.doc(`usuarios/${d.ofertaId}/movimientos/com_${ev.params.id}`);
  await db.runTransaction(async (t) => {
    const m = await t.get(mref);
    if (m.exists) return;
    t.set(mref, { tipo: 'comision', monto: -comision, solicitudId: ev.params.id, creada: admin.firestore.FieldValue.serverTimestamp() });
    t.update(db.doc(`usuarios/${d.ofertaId}`), { saldo: admin.firestore.FieldValue.increment(-comision) });
    t.update(ev.data.after.ref, { comision, tasa });
  });
});
