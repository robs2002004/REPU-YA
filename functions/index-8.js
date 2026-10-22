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

  // ---- Borrado ----

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

  // Cuenta de inicio de sesión
  await admin.auth().deleteUser(uid);
  return { ok: true };
});
