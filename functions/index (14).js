const functions = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
admin.initializeApp();

// Días que el cliente o la empresa deben esperar después de una venta aceptada,
// para que la otra parte tenga tiempo de coordinar la entrega.
const DIAS_VENTA_EN_CURSO = 30;

exports.helloWorld = functions.https.onRequest((req, res) => {
  res.send("Repu-Ya backend funcionando");
});

exports.cancelarMembresia = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const ref = admin.firestore().collection("usuarios").doc(request.auth.uid);
  const d = (await ref.get()).data() || {};
  const hasta = d.membresiaHasta?.toMillis?.() || 0;
  if (!(hasta > Date.now())) {
    throw new HttpsError("failed-precondition", "No tienes una membresía activa que cancelar.");
  }
  await ref.update({
    membresiaCancelada: true,
    membresiaCanceladaEn: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

exports.eliminarCuenta = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const uid = request.auth.uid;
  const db = admin.firestore();
  const ahora = Date.now();
  const limiteVenta = ahora - DIAS_VENTA_EN_CURSO * 864e5;

  const perfilSnap = await db.collection("usuarios").doc(uid).get();
  const perfil = perfilSnap.data() || {};
  const esEmpresa = perfil.rol === "empresa";

  // 1. Subastas abiertas del cliente (que todavía no hayan vencido)
  const abiertas = await db.collection("solicitudes")
    .where("uid", "==", uid).where("estado", "==", "abierta").get();
  const abiertasVigentes = abiertas.docs.filter((s) => {
    const cierra = s.data().cierraEn;
    return !cierra || cierra > ahora;
  });
  if (abiertasVigentes.length > 0) {
    throw new HttpsError(
      "failed-precondition",
      "Tienes subastas abiertas. Espera a que terminen o ciérralas antes de eliminar tu cuenta."
    );
  }

  // 2. Ventas aceptadas recientes (como cliente o como empresa): la otra parte
  //    necesita el contacto para coordinar la entrega.
  const compradas = await db.collection("solicitudes")
    .where("uid", "==", uid).where("estado", "==", "aceptada").get();
  const compraEnCurso = compradas.docs.some((s) => (s.data().aceptadaEn?.toMillis?.() || 0) > limiteVenta);
  if (compraEnCurso) {
    throw new HttpsError(
      "failed-precondition",
      `Tienes una compra aceptada en los últimos ${DIAS_VENTA_EN_CURSO} días. Espera a que se complete la entrega o escribe a soporte antes de eliminar tu cuenta.`
    );
  }
  if (esEmpresa) {
    const vendidas = await db.collection("solicitudes")
      .where("ofertaId", "==", uid).where("estado", "==", "aceptada").get();
    const ventaEnCurso = vendidas.docs.some((s) => (s.data().aceptadaEn?.toMillis?.() || 0) > limiteVenta);
    if (ventaEnCurso) {
      throw new HttpsError(
        "failed-precondition",
        `Tienes una venta aceptada en los últimos ${DIAS_VENTA_EN_CURSO} días. Espera a que se complete la entrega o escribe a soporte antes de eliminar tu cuenta.`
      );
    }
  }

  // 3. Saldo de la empresa: no hay retiro automático, así que lo gestiona soporte.
  if (esEmpresa && Number(perfil.saldo || 0) > 0) {
    throw new HttpsError(
      "failed-precondition",
      "Tienes saldo disponible en tu cuenta. Escribe a soporte para solicitar su devolución antes de eliminar tu cuenta."
    );
  }

  // 4. Membresía vigente sin cancelar: debe cancelarla primero.
  const hasta = perfil.membresiaHasta?.toMillis?.() || 0;
  if (hasta > ahora && !perfil.membresiaCancelada) {
    throw new HttpsError(
      "failed-precondition",
      "Tienes una membresía activa. Cancélala en la sección «Membresía» antes de eliminar tu cuenta."
    );
  }

  await borrarDatosUsuario(db, uid);
  // Cuenta de inicio de sesión
  await admin.auth().deleteUser(uid);
  return { ok: true };
});

// ===================== ADMINISTRACIÓN =====================
// Correos de las cuentas administradoras (deben haber iniciado sesión con Google).
const ADMIN_EMAILS = ['robs2002004@gmail.com'];

function esAdmin(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const email = (request.auth.token.email || '').toLowerCase();
  if (!ADMIN_EMAILS.includes(email) || request.auth.token.email_verified !== true) {
    throw new HttpsError("permission-denied", "Sin acceso de administrador.");
  }
}

// Convierte Timestamps de Firestore en milisegundos para poder enviarlos al navegador
function limpio(v) {
  if (v && typeof v.toMillis === "function") return v.toMillis();
  if (Array.isArray(v)) return v.map(limpio);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = limpio(v[k]);
    return o;
  }
  return v;
}
const msOf = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : 0);

exports.adminListarUsuarios = onCall(async (request) => {
  esAdmin(request);
  const db = admin.firestore();
  const [us, sols, ofs] = await Promise.all([
    db.collection("usuarios").get(),
    db.collection("solicitudes").get(),
    db.collectionGroup("ofertas").get(),
  ]);

  const conteo = {};
  const cuenta = (uid) => (conteo[uid] = conteo[uid] || { subastas: 0, ofertas: 0 });
  sols.docs.forEach((d) => cuenta(d.data().uid).subastas++);
  ofs.docs.forEach((d) => cuenta(d.id).ofertas++);

  // Correos desde Authentication
  const correos = {};
  let pageToken;
  do {
    const r = await admin.auth().listUsers(1000, pageToken);
    r.users.forEach((x) => (correos[x.uid] = x.email || ""));
    pageToken = r.pageToken;
  } while (pageToken);

  const usuarios = us.docs.map((d) => {
    const x = d.data();
    const c = conteo[d.id] || { subastas: 0, ofertas: 0 };
    return {
      uid: d.id,
      rol: x.rol || "cliente",
      nombre: x.nombre || "",
      empresa: x.empresa || "",
      correo: correos[d.id] || "",
      pais: x.pais || "",
      plan: x.plan === "int" ? "Internacional" : "Nacional",
      membresiaHasta: msOf(x.membresiaHasta),
      membresiaCancelada: !!x.membresiaCancelada,
      saldo: Number(x.saldo || 0),
      whatsapp: x.whatsapp || "",
      creada: msOf(x.creada),
      bloqueado: !!x.bloqueado,
      subastas: c.subastas,
      ofertas: c.ofertas,
    };
  });
  return { usuarios };
});

exports.adminDetalleUsuario = onCall(async (request) => {
  esAdmin(request);
  const uid = request.data && request.data.uid;
  if (!uid) throw new HttpsError("invalid-argument", "Falta el uid.");
  const db = admin.firestore();

  const u = await db.collection("usuarios").doc(uid).get();
  if (!u.exists) throw new HttpsError("not-found", "Usuario no encontrado.");
  const x = u.data();

  // Subastas publicadas por el cliente
  const sols = await db.collection("solicitudes").where("uid", "==", uid).get();
  const subastas = sols.docs.map((d) => ({ id: d.id, ...limpio(d.data()) }));

  // Ofertas que envió la empresa (en subastas de otros)
  // En consultas de grupo de colecciones no se puede filtrar por ID corto: se filtra en memoria
  const ofs = await db.collectionGroup("ofertas").get();
  const ofertas = ofs.docs
    .filter((d) => d.id === uid)
    .map((d) => ({ solicitudId: d.ref.parent.parent.id, ...limpio(d.data()) }));

  // Movimientos de saldo, comisiones y pagos
  const movs = await db.collection("usuarios").doc(uid).collection("movimientos").limit(200).get();
  const movimientos = movs.docs
    .map((d) => ({ id: d.id, ...limpio(d.data()) }))
    .sort((a, b) => (b.creado || b.fecha || 0) - (a.creado || a.fecha || 0));

  return {
    usuario: { uid, ...limpio(x), membresiaHasta: msOf(x.membresiaHasta) },
    subastas,
    ofertas,
    movimientos,
  };
});

// Borra solicitudes, ofertas, contactos, bloqueos y el perfil. Conserva movimientos (registro legal).
async function borrarDatosUsuario(db, uid) {

  // Solicitudes del cliente (ya sin subastas abiertas ni ventas recientes)
  const sols = await db.collection("solicitudes").where("uid", "==", uid).get();
  for (const s of sols.docs) await db.recursiveDelete(s.ref);

  // Ofertas y contactos que la empresa dejó en solicitudes de otros
  const ofs = await db.collectionGroup("ofertas").get();
  for (const o of ofs.docs) if (o.id === uid) await o.ref.delete();
  const cts = await db.collectionGroup("contacto").get();
  for (const c of cts.docs) if (c.id === uid) await c.ref.delete();

  // Historial de ofertas enviadas y bloqueos propios
  const envs = await db.collection("ofertasEnviadas").where("empresaUid", "==", uid).get();
  for (const e of envs.docs) await e.ref.delete();
  const bls = await db.collection("bloqueos").where("bloqueadoPor", "==", uid).get();
  for (const b of bls.docs) await b.ref.delete();

  // Perfil. Los movimientos (saldo, comisiones, pagos) se conservan como registro legal.
  await db.collection("usuarios").doc(uid).delete();

}

exports.adminCambiarBloqueo = onCall(async (request) => {
  esAdmin(request);
  const { uid, bloquear } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "Falta el uid.");
  if (uid === request.auth.uid) throw new HttpsError("failed-precondition", "No puedes bloquear tu propia cuenta.");
  const ref = admin.firestore().collection("usuarios").doc(uid);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "Usuario no encontrado.");
  await ref.update({
    bloqueado: !!bloquear,
    bloqueadoEn: bloquear ? admin.firestore.FieldValue.serverTimestamp() : admin.firestore.FieldValue.delete(),
  });
  return { ok: true, bloqueado: !!bloquear };
});

exports.adminEliminarUsuario = onCall(async (request) => {
  esAdmin(request);
  const uid = request.data && request.data.uid;
  if (!uid) throw new HttpsError("invalid-argument", "Falta el uid.");
  if (uid === request.auth.uid) throw new HttpsError("failed-precondition", "No puedes eliminar tu propia cuenta desde administración.");
  const db = admin.firestore();
  await borrarDatosUsuario(db, uid);
  try { await admin.auth().deleteUser(uid); } catch (e) { /* la cuenta de acceso puede no existir */ }
  return { ok: true };
});
