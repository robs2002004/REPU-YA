const functions = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
admin.initializeApp();

exports.helloWorld = functions.https.onRequest((req, res) => {
  res.send("Repu-Ya backend funcionando");
});

exports.cancelarMembresia = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const ref = admin.firestore().collection("usuarios").doc(request.auth.uid);
  const d = (await ref.get()).data() || {};
  const hasta = d.membresiaHasta?.toMillis?.() || 0;
  if (!(hasta > Date.now())) throw new HttpsError("failed-precondition", "No tienes una membresía activa que cancelar.");
  await ref.update({ membresiaCancelada: true, membresiaCanceladaEn: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true };
});

exports.eliminarCuenta = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const uid = request.auth.uid;
  const db = admin.firestore();

  const sols = await db.collection("solicitudes").where("uid", "==", uid).get();
  for (const s of sols.docs) await db.recursiveDelete(s.ref);

  const ofs = await db.collectionGroup("ofertas").get();
  for (const o of ofs.docs) if (o.id === uid) await o.ref.delete();
  const cts = await db.collectionGroup("contacto").get();
  for (const c of cts.docs) if (c.id === uid) await c.ref.delete();

  const envs = await db.collection("ofertasEnviadas").where("empresaUid", "==", uid).get();
  for (const e of envs.docs) await e.ref.delete();
  const bls = await db.collection("bloqueos").where("bloqueadoPor", "==", uid).get();
  for (const b of bls.docs) await b.ref.delete();

  // Los movimientos (saldo, comisiones, pagos) se conservan como registro legal.
  await db.collection("usuarios").doc(uid).delete();
  await admin.auth().deleteUser(uid);
  return { ok: true };
});
