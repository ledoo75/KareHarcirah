/**
 * KareKara — Sunucu tarafı gece yedeği (İSTEĞE BAĞLI)
 * ---------------------------------------------------
 * index.html'deki otomatik yedek, 02:00'de yetkili bir kullanıcının ekranı açıksa
 * tam saatinde, değilse 02:00'den sonraki ilk girişte alınır.
 * Kimse sistemi açmasa bile yedeğin TAM 02:00'de alınmasını istiyorsanız
 * bu Cloud Function'ı yükleyin (Firebase "Blaze" planı gerekir).
 *
 * Aynı "kare_backups" formatını ve "auto_YYYY-MM-DD" kimliğini kullanır;
 * böylece panelde "Otomatik" yedek olarak görünür, tarayıcı aynı günü tekrar yedeklemez.
 *
 * Kurulum:
 *   npm i -g firebase-tools
 *   firebase login
 *   firebase init functions      (proje: kare-6172d, dil: JavaScript)
 *   bu dosyayı functions/index.js olarak koyun
 *   firebase deploy --only functions
 */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

const KEEP = 5;            // son 5 günlük otomatik yedek
const CHUNK = 300000;      // Firestore 1MB doküman sınırı için parça boyutu

const dayKeyIstanbul = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(d); // YYYY-MM-DD

const ts = (v) => (v && v.toDate ? v.toDate().toISOString() : typeof v === 'string' ? v : '');

async function batchRun(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const b = db.batch();
    ops.slice(i, i + 450).forEach((f) => f(b));
    await b.commit();
  }
}

async function deleteBackup(id) {
  const ref = db.collection('kare_backups').doc(id);
  const ch = await ref.collection('chunks').get();
  await batchRun(ch.docs.map((d) => (b) => b.delete(d.ref)));
  await ref.delete();
}

exports.gecelikYedek = onSchedule(
  {
    schedule: '0 2 * * *',          // her gece 02:00
    timeZone: 'Europe/Istanbul',
    region: 'europe-west1',
    memory: '512MiB',
    timeoutSeconds: 540,
  },
  async () => {
    const day = dayKeyIstanbul();
    const ref = db.collection('kare_backups').doc('auto_' + day);

    // Kilit — tarayıcıdaki otomatik yedekle çakışmasın
    const locked = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists) {
        const x = s.data();
        if (x.status === 'ready') return false;
        if (x.status === 'running' && Date.now() - (x.startedAt || 0) < 15 * 60 * 1000) return false;
      }
      tx.set(ref, { status: 'running', type: 'auto', dayKey: day, startedAt: Date.now(), createdBy: 'SUNUCU' });
      return true;
    });
    if (!locked) return;

    try {
      const [exp, adv, trp, usr] = await Promise.all(
        ['kare_expenses', 'kare_advances', 'kare_trips', 'kare_users'].map((c) => db.collection(c).get())
      );
      const map = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data(), timestamp: ts(d.data().timestamp) }));
      const backup = {
        version: '1.1', type: 'auto', createdAt: new Date().toISOString(), createdBy: 'SUNUCU',
        expenses: map(exp), advances: map(adv), trips: map(trp),
        users: usr.docs.map((d) => ({ id: d.id, ...d.data() })),
      };

      const json = JSON.stringify(backup);
      const chunks = [];
      for (let i = 0; i < json.length; i += CHUNK) chunks.push(json.slice(i, i + CHUNK));
      await batchRun(chunks.map((c, i) => (b) => b.set(ref.collection('chunks').doc(String(i).padStart(4, '0')), { d: c })));
      await ref.set({
        status: 'ready', type: 'auto', dayKey: day,
        createdAt: backup.createdAt, createdBy: 'SUNUCU',
        chunkCount: chunks.length, sizeBytes: json.length,
        counts: { expenses: backup.expenses.length, advances: backup.advances.length, trips: backup.trips.length, users: backup.users.length },
        savedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // Saklama: son 5 otomatik yedek, 5 günden eski manuel yedekler silinir
      const all = (await db.collection('kare_backups').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
      const limit = Date.now() - KEEP * 864e5;
      const autos = all.filter((x) => x.type === 'auto' && x.status === 'ready')
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      const del = [
        ...autos.slice(KEEP),
        ...all.filter((x) => x.type !== 'auto' && x.status === 'ready' && new Date(x.createdAt).getTime() < limit),
      ];
      for (const x of del) await deleteBackup(x.id);
      console.log(`Yedek alındı: ${day}, ${del.length} eski yedek silindi`);
    } catch (e) {
      console.error('Yedek hatası', e);
      await deleteBackup(ref.id).catch(() => {});
      throw e;
    }
  }
);
