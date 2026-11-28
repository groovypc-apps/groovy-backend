const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Muat nodemailer dengan aman
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (err) {
  console.warn('⚠️ Modul nodemailer belum terpasang di package.json.');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Sajikan file statis (aplikasi terpadu HTML) jika dijalankan dari folder yang sama
app.use(express.static(__dirname));

// KONEKSI KE MONGODB ATLAS (Aman dari crash jika MONGODB_URI belum disetel)
const mongoUri = process.env.MONGODB_URI;
if (mongoUri) {
  mongoose.connect(mongoUri)
    .then(() => console.log('✅ Berhasil Terhubung ke MongoDB Atlas'))
    .catch(err => console.error('❌ Gagal koneksi ke MongoDB Atlas:', err.message));
} else {
  console.warn('⚠️ Peringatan: Variabel environment MONGODB_URI belum diatur di file .env!');
}

// Endpoint Health Check untuk memantau status Server & Koneksi MongoDB
app.get('/api/health', (req, res) => {
  const dbStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    status: 'online',
    database: dbStates[mongoose.connection.readyState] || 'unknown',
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// 1. SKEMA & ENDPOINT PAKET LAYANAN (/api/packages)
// ============================================================================
const slotSchema = new mongoose.Schema({
  index: Number,
  name: String,
  nominal: { type: Number, default: 0 },
  branch: { type: String, default: '' },
  date: { type: String, default: '' },
  used: { type: Boolean, default: false },
  groomer: { type: String, default: '' },
  notes: { type: String, default: '' }
});

const packageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  date: String,
  owner: String,
  pet: String,
  type: String,
  deposit: Number,
  branch: String,
  status: { type: String, default: 'Aktif' },
  notes: String,
  slots: [slotSchema]
}, { timestamps: true });

const Package = mongoose.model('Package', packageSchema);

app.get('/api/packages', async (req, res) => {
  try {
    const packages = await Package.find().sort({ createdAt: -1 });
    res.json({ status: 'success', data: packages });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Menggunakan findOneAndUpdate + upsert agar aman dari duplicate key error saat sinkronisasi/import
app.post('/api/packages', async (req, res) => {
  try {
    const body = req.body || {};
    const docId = String(body.id || `PKG-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`);
    const savedPackage = await Package.findOneAndUpdate(
      { id: docId },
      { ...body, id: docId },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ status: 'success', message: 'Paket tersimpan di MongoDB', data: savedPackage });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
});

app.put('/api/packages/:pkgId/redeem', async (req, res) => {
  try {
    const { pkgId } = req.params;
    const { slotIndex, payload } = req.body;

    const pkg = await Package.findOne({ id: pkgId });
    if (!pkg) return res.status(404).json({ status: 'error', message: 'Paket tidak ditemukan' });

    const slot = pkg.slots.find(s => Number(s.index) === Number(slotIndex));
    if (slot) { Object.assign(slot, payload); }

    if (pkg.slots.length > 0 && pkg.slots.every(s => s.used === true)) {
      pkg.status = 'Selesai';
    } else {
      pkg.status = 'Aktif';
    }

    await pkg.save();
    res.json({ status: 'success', message: 'Sesi berhasil dipotong', data: pkg });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.delete('/api/packages/:pkgId', async (req, res) => {
  try {
    await Package.findOneAndDelete({ id: req.params.pkgId });
    res.json({ status: 'success', message: 'Paket dihapus dari MongoDB' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// 2. SKEMA & ENDPOINT CHECKLIST GROOMING + AUTO EMAIL PDF (/api/checklists)
// ============================================================================
const checklistSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  tanggal: String,
  ownerName: String,
  hp: { type: String, default: '' },
  alamat: { type: String, default: '' },
  statusGrooming: String,
  hewan1: Object,
  hewan2: Object,
  catatanKhusus: { type: String, default: '' },
  groomer: String,
  ttdOwner: { type: String, default: '' },
  fileName: String
}, { timestamps: true });

const Checklist = mongoose.model('Checklist', checklistSchema);

app.get('/api/checklists', async (req, res) => {
  try {
    const list = await Checklist.find().sort({ createdAt: -1 });
    res.json({ status: 'success', data: list });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/checklists', async (req, res) => {
  try {
    const {
      id,
      tanggal,
      formattedDate,
      ownerName,
      hp,
      alamat,
      statusGrooming,
      hewan1,
      hewan2,
      petName,
      catatanKhusus,
      groomer,
      ttdOwner,
      fileName,
      targetEmail,
      pdfBase64
    } = req.body;

    const docId = id || `CHK-${Date.now()}`;

    const savedChecklist = await Checklist.findOneAndUpdate(
      { id: docId },
      {
        id: docId,
        tanggal,
        ownerName,
        hp,
        alamat,
        statusGrooming,
        hewan1,
        hewan2,
        catatanKhusus,
        groomer,
        ttdOwner,
        fileName
      },
      { upsert: true, new: true }
    );

    let emailSent = false;
    const recipient = targetEmail || 'ceklistgrooming@gmail.com';

    if (nodemailer && pdfBase64 && process.env.EMAIL_PASS) {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER || 'ceklistgrooming@gmail.com',
          pass: process.env.EMAIL_PASS
        }
      });

      const cleanBase64 = pdfBase64.includes('base64,')
        ? pdfBase64.split('base64,')[1]
        : pdfBase64;

      const pdfFileName = fileName || `${ownerName || 'Owner'} (${petName || 'Pet'}) ${formattedDate || tanggal}.pdf`;

      await transporter.sendMail({
        from: `"Groovy Pet Center Radio 03" <${process.env.EMAIL_USER || 'ceklistgrooming@gmail.com'}>`,
        to: recipient,
        subject: `[CHECKLIST GROOMING - ${statusGrooming || 'GROOMING'}] ${ownerName} (${petName || hewan1?.nama || '-'})`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.5;">
            <h2 style="color: #C2185B; margin-bottom: 4px;">🐾 Checklist Grooming - Groovy Pet Center Radio 03</h2>
            <p style="margin-top: 0; color: #666;">Dokumen PDF Checklist Grooming terlampir secara otomatis:</p>
            <table style="border-collapse: collapse; width: 100%; max-width: 500px; font-size: 13px;">
              <tr><td style="padding: 6px 10px; border: 1px solid #ddd; font-weight: bold; background: #fff8f0;">Tanggal</td><td style="padding: 6px 10px; border: 1px solid #ddd;">${formattedDate || tanggal || '-'}</td></tr>
              <tr><td style="padding: 6px 10px; border: 1px solid #ddd; font-weight: bold; background: #fff8f0;">Status Grooming</td><td style="padding: 6px 10px; border: 1px solid #ddd;"><strong>${statusGrooming || '-'}</strong></td></tr>
              <tr><td style="padding: 6px 10px; border: 1px solid #ddd; font-weight: bold; background: #fff8f0;">Nama Owner</td><td style="padding: 6px 10px; border: 1px solid #ddd;">${ownerName || '-'} (${hp || '-'})</td></tr>
              <tr><td style="padding: 6px 10px; border: 1px solid #ddd; font-weight: bold; background: #fff8f0;">Nama Hewan</td><td style="padding: 6px 10px; border: 1px solid #ddd;">${petName || hewan1?.nama || '-'}</td></tr>
              <tr><td style="padding: 6px 10px; border: 1px solid #ddd; font-weight: bold; background: #fff8f0;">Petugas / Groomer</td><td style="padding: 6px 10px; border: 1px solid #ddd;">${groomer || '-'}</td></tr>
              <tr><td style="padding: 6px 10px; border: 1px solid #ddd; font-weight: bold; background: #fff8f0;">Catatan Khusus</td><td style="padding: 6px 10px; border: 1px solid #ddd;">${catatanKhusus || '-'}</td></tr>
            </table>
          </div>
        `,
        attachments: [
          {
            filename: pdfFileName,
            content: Buffer.from(cleanBase64, 'base64'),
            contentType: 'application/pdf'
          }
        ]
      });

      emailSent = true;
    }

    res.json({
      status: 'success',
      emailSent,
      recipient,
      data: savedChecklist
    });
  } catch (error) {
    console.error('Error /api/checklists:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.delete('/api/checklists/:id', async (req, res) => {
  try {
    await Checklist.findOneAndDelete({ id: req.params.id });
    res.json({ status: 'success', message: 'Checklist dihapus dari MongoDB' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// 3. SKEMA & ENDPOINT APP LAUNCHER / PORTAL STAF (/api/links)
// ============================================================================
const launcherLinkSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  url: { type: String, required: true },
  category: { type: String, default: 'Operasional' },
  theme: { type: String, default: 'duo' },
  icon: { type: String, default: '🐾' },
  bgImage: { type: String, default: '' },
  bgFit: { type: String, default: 'cover' },
  hideIcon: { type: Boolean, default: false },
  pinned: { type: Boolean, default: false },
  order: { type: Number, default: 0 }
}, { timestamps: true });

const LauncherLink = mongoose.model('LauncherLink', launcherLinkSchema);

app.get('/api/links', async (req, res) => {
  try {
    const links = await LauncherLink.find().sort({ order: 1, createdAt: 1 });
    res.json({ status: 'success', data: links });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/links', async (req, res) => {
  try {
    const item = req.body;
    const docId = item.id || `app-${Date.now()}`;
    const saved = await LauncherLink.findOneAndUpdate(
      { id: docId },
      {
        id: docId,
        name: item.name,
        url: item.url,
        category: item.category || 'Operasional',
        theme: item.theme || 'duo',
        icon: item.icon || '🐾',
        bgImage: item.bgImage || '',
        bgFit: item.bgFit || 'cover',
        hideIcon: Boolean(item.hideIcon),
        pinned: Boolean(item.pinned),
        order: typeof item.order === 'number' ? item.order : 0
      },
      { upsert: true, new: true }
    );
    res.json({ status: 'success', data: saved });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.put('/api/links/sync', async (req, res) => {
  try {
    const list = Array.isArray(req.body.links) ? req.body.links : [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || !item.id || !item.name || !item.url) continue;
      await LauncherLink.findOneAndUpdate(
        { id: item.id },
        {
          id: item.id,
          name: item.name,
          url: item.url,
          category: item.category || 'Operasional',
          theme: item.theme || 'duo',
          icon: item.icon || '🐾',
          bgImage: item.bgImage || '',
          bgFit: item.bgFit || 'cover',
          hideIcon: Boolean(item.hideIcon),
          pinned: Boolean(item.pinned),
          order: i
        },
        { upsert: true, new: true }
      );
    }
    const validIds = list.filter(item => item && item.id).map(item => item.id);
    if (validIds.length > 0 && req.body.replace !== false) {
      await LauncherLink.deleteMany({ id: { $nin: validIds } });
    }
    const all = await LauncherLink.find().sort({ order: 1, createdAt: 1 });
    res.json({ status: 'success', data: all });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.delete('/api/links/:id', async (req, res) => {
  try {
    await LauncherLink.findOneAndDelete({ id: req.params.id });
    res.json({ status: 'success', message: 'Kartu aplikasi dihapus dari MongoDB' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// 4. SKEMA & ENDPOINT JADWAL GROOMING TOKO (/api/schedules)
// ============================================================================
const scheduleSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  ownerName: { type: String, required: true },
  petName: { type: String, required: true },
  petType: { type: String, default: 'Dog' },
  service: { type: String, required: true },
  notes: { type: String, default: '' },
  isoDate: { type: String, required: true },
  timestamp: { type: Number, default: 0 },
  formattedDate: { type: String, default: '' }
}, { timestamps: true, collection: 'schedules' });

const Schedule = mongoose.model('Schedule', scheduleSchema);

app.get('/api/schedules', async (req, res) => {
  try {
    const list = await Schedule.find().sort({ timestamp: 1, createdAt: 1 });
    res.json({ status: 'success', data: list });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/schedules', async (req, res) => {
  try {
    const entries = Array.isArray(req.body.entries)
      ? req.body.entries
      : (Array.isArray(req.body) ? req.body : [req.body]);

    for (const item of entries) {
      if (!item || !item.ownerName || !item.petName) continue;
      const docId = String(item.id || `SCH-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
      const isoDate = String(item.isoDate || '').split('T')[0];
      const timestamp = item.timestamp || new Date(isoDate + 'T00:00:00').getTime() || Date.now();

      await Schedule.findOneAndUpdate(
        { id: docId },
        {
          id: docId,
          ownerName: item.ownerName,
          petName: item.petName,
          petType: item.petType || 'Dog',
          service: item.service || 'BATH',
          notes: item.notes || '',
          isoDate,
          timestamp,
          formattedDate: item.formattedDate || isoDate
        },
        { upsert: true, new: true }
      );
    }

    const updated = await Schedule.find().sort({ timestamp: 1, createdAt: 1 });
    res.json({ status: 'success', data: updated });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.delete('/api/schedules/:id', async (req, res) => {
  try {
    await Schedule.findOneAndDelete({ id: req.params.id });
    res.json({ status: 'success', message: 'Jadwal dihapus dari MongoDB' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// 5. SKEMA & ENDPOINT JADWAL HOME GROOMING (/api/home-schedules)
// ============================================================================
const homeScheduleSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  ownerName: { type: String, required: true },
  petName: { type: String, required: true },
  petType: { type: String, default: 'Dog' },
  service: { type: String, required: true },
  notes: { type: String, default: '' },
  isoDate: { type: String, required: true },
  timestamp: { type: Number, default: 0 },
  formattedDate: { type: String, default: '' }
}, { timestamps: true, collection: 'home_schedules' });

const HomeSchedule = mongoose.model('HomeSchedule', homeScheduleSchema);

app.get('/api/home-schedules', async (req, res) => {
  try {
    const list = await HomeSchedule.find().sort({ timestamp: 1, createdAt: 1 });
    res.json({ status: 'success', data: list });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/home-schedules', async (req, res) => {
  try {
    const entries = Array.isArray(req.body.entries)
      ? req.body.entries
      : (Array.isArray(req.body) ? req.body : [req.body]);

    for (const item of entries) {
      if (!item || !item.ownerName || !item.petName) continue;
      const docId = String(item.id || `HSCH-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
      const isoDate = String(item.isoDate || '').split('T')[0];
      const timestamp = item.timestamp || new Date(isoDate + 'T00:00:00').getTime() || Date.now();

      await HomeSchedule.findOneAndUpdate(
        { id: docId },
        {
          id: docId,
          ownerName: item.ownerName,
          petName: item.petName,
          petType: item.petType || 'Dog',
          service: item.service || 'BATH',
          notes: item.notes || '',
          isoDate,
          timestamp,
          formattedDate: item.formattedDate || isoDate
        },
        { upsert: true, new: true }
      );
    }

    const updated = await HomeSchedule.find().sort({ timestamp: 1, createdAt: 1 });
    res.json({ status: 'success', data: updated });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.delete('/api/home-schedules/:id', async (req, res) => {
  try {
    await HomeSchedule.findOneAndDelete({ id: req.params.id });
    res.json({ status: 'success', message: 'Jadwal home grooming dihapus dari MongoDB' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// 6. SKEMA & ENDPOINT JADWAL DAYCARE & DOG WALKER (/api/daycare-schedules)
// ============================================================================
const daycareScheduleSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  ownerName: { type: String, required: true },
  petName: { type: String, required: true },
  petType: { type: String, default: 'Dog' },
  service: { type: String, required: true },
  notes: { type: String, default: '' },
  isoDate: { type: String, required: true },
  timestamp: { type: Number, default: 0 },
  formattedDate: { type: String, default: '' }
}, { timestamps: true, collection: 'daycare_schedules' });

const DaycareSchedule = mongoose.model('DaycareSchedule', daycareScheduleSchema);

app.get('/api/daycare-schedules', async (req, res) => {
  try {
    const list = await DaycareSchedule.find().sort({ timestamp: 1, createdAt: 1 });
    res.json({ status: 'success', data: list });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/daycare-schedules', async (req, res) => {
  try {
    const entries = Array.isArray(req.body.entries)
      ? req.body.entries
      : (Array.isArray(req.body) ? req.body : [req.body]);

    for (const item of entries) {
      if (!item || !item.ownerName || !item.petName) continue;
      const docId = String(item.id || `DCW-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
      const isoDate = String(item.isoDate || '').split('T')[0];
      const timestamp = item.timestamp || new Date(isoDate + 'T00:00:00').getTime() || Date.now();
      const service = String(item.service || 'DAYCARE').toUpperCase();
      const petType = service === 'DOGWALKER' ? 'Dog' : (item.petType || 'Dog');

      await DaycareSchedule.findOneAndUpdate(
        { id: docId },
        {
          id: docId,
          ownerName: item.ownerName,
          petName: item.petName,
          petType,
          service,
          notes: item.notes || '',
          isoDate,
          timestamp,
          formattedDate: item.formattedDate || isoDate
        },
        { upsert: true, new: true }
      );
    }

    const updated = await DaycareSchedule.find().sort({ timestamp: 1, createdAt: 1 });
    res.json({ status: 'success', data: updated });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.delete('/api/daycare-schedules/:id', async (req, res) => {
  try {
    await DaycareSchedule.findOneAndDelete({ id: req.params.id });
    res.json({ status: 'success', message: 'Jadwal daycare & dog walker dihapus dari MongoDB' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// 7. SKEMA & ENDPOINT JADWAL BOARDING (/api/boarding-schedules)
// ============================================================================
const boardingScheduleSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  ownerName: { type: String, required: true },
  petName: { type: String, required: true },
  petType: { type: String, default: 'Dog' },
  service: { type: String, required: true },
  roomType: { type: String, default: '' },
  notes: { type: String, default: '' },
  isoDate: { type: String, required: true },
  endDate: { type: String, default: '' },
  durationDays: { type: Number, default: 1 },
  timestamp: { type: Number, default: 0 },
  formattedDate: { type: String, default: '' }
}, { timestamps: true, collection: 'boarding_schedules' });

const BoardingSchedule = mongoose.model('BoardingSchedule', boardingScheduleSchema);

app.get('/api/boarding-schedules', async (req, res) => {
  try {
    const list = await BoardingSchedule.find().sort({ timestamp: 1, createdAt: 1 });
    res.json({ status: 'success', data: list });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/boarding-schedules', async (req, res) => {
  try {
    const entries = Array.isArray(req.body.entries)
      ? req.body.entries
      : (Array.isArray(req.body) ? req.body : [req.body]);

    for (const item of entries) {
      if (!item || !item.ownerName || !item.petName) continue;
      const docId = String(item.id || `BRD-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
      const isoDate = String(item.isoDate || '').split('T')[0];
      const endDate = String(item.endDate || isoDate).split('T')[0];
      const durationDays = Math.max(1, Number(item.durationDays) || 1);
      const timestamp = item.timestamp || new Date(isoDate + 'T00:00:00').getTime() || Date.now();
      const service = String(item.service || 'HOTEL').toUpperCase();
      const roomType = service === 'SHORTTIME' ? '' : (item.roomType || 'Supawrior');

      await BoardingSchedule.findOneAndUpdate(
        { id: docId },
        {
          id: docId,
          ownerName: item.ownerName,
          petName: item.petName,
          petType: item.petType || 'Dog',
          service,
          roomType,
          notes: item.notes || '',
          isoDate,
          endDate,
          durationDays,
          timestamp,
          formattedDate: item.formattedDate || isoDate
        },
        { upsert: true, new: true }
      );
    }

    const updated = await BoardingSchedule.find().sort({ timestamp: 1, createdAt: 1 });
    res.json({ status: 'success', data: updated });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.delete('/api/boarding-schedules/:id', async (req, res) => {
  try {
    await BoardingSchedule.findOneAndDelete({ id: req.params.id });
    res.json({ status: 'success', message: 'Jadwal boarding dihapus dari MongoDB' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// 8. SKEMA & ENDPOINT INVOICE & KWITANSI (/api/invoices)
//    Mendukung penyimpanan & riwayat: Sales Invoice, Grooming Invoice, Kwitansi
// ============================================================================
const invoiceSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  serial: { type: String, required: true },
  type: { type: String, required: true, enum: ['Sales', 'Grooming', 'Kwitansi'] },
  customer: { type: String, default: 'Tanpa Nama' },
  date: { type: String, default: '' },
  total: { type: String, default: '0' },
  paperSize: { type: String, default: 'a5' },
  details: { type: Object, default: {} }
}, { timestamps: true, collection: 'invoices' });

const Invoice = mongoose.model('Invoice', invoiceSchema);

app.get('/api/invoices', async (req, res) => {
  try {
    const list = await Invoice.find().sort({ updatedAt: -1, createdAt: -1 }).limit(300);
    res.json({ status: 'success', data: list });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/invoices', async (req, res) => {
  try {
    const entries = Array.isArray(req.body.entries)
      ? req.body.entries
      : (Array.isArray(req.body) ? req.body : [req.body]);

    const savedItems = [];
    for (const item of entries) {
      if (!item || !item.serial || !item.type) continue;
      const docId = String(item.id || `${item.type.toUpperCase()}-${item.serial}`);

      const saved = await Invoice.findOneAndUpdate(
        { id: docId },
        {
          id: docId,
          serial: String(item.serial).trim(),
          type: item.type,
          customer: item.customer || 'Tanpa Nama',
          date: item.date || '',
          total: String(item.total || '0'),
          paperSize: item.paperSize || 'a5',
          details: item.details || {}
        },
        { upsert: true, new: true }
      );
      savedItems.push(saved);
    }

    const allInvoices = await Invoice.find().sort({ updatedAt: -1, createdAt: -1 }).limit(300);
    res.json({
      status: 'success',
      message: 'Data Invoice / Kwitansi tersimpan di MongoDB',
      saved: savedItems,
      data: allInvoices
    });
  } catch (error) {
    console.error('Error POST /api/invoices:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.delete('/api/invoices/:id', async (req, res) => {
  try {
    const target = req.params.id;
    await Invoice.findOneAndDelete({
      $or: [{ id: target }, { serial: target }]
    });
    res.json({ status: 'success', message: 'Invoice / Kwitansi dihapus dari MongoDB' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// 9. SKEMA & ENDPOINT FORM PENDAFTARAN PAKET A4 (/api/enrollment-forms)
//    Mendukung penyimpanan, riwayat, buka/edit & hapus Form Paket A4 di MongoDB
// ============================================================================
const enrollmentFormSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  formType: { type: String, required: true },
  selectedPackage: { type: String, default: '' },
  ownerName: { type: String, required: true },
  phone: { type: String, default: '' },
  petName: { type: String, default: '' },
  breed: { type: String, default: '' },
  weight: { type: String, default: '' },
  address: { type: String, default: '' },
  trainingDetails: { type: Object, default: {} },
  signatureDataUrl: { type: String, default: '' },
  dateStr: { type: String, default: '' }
}, { timestamps: true, collection: 'enrollment_forms' });

const EnrollmentForm = mongoose.model('EnrollmentForm', enrollmentFormSchema);

app.get('/api/enrollment-forms', async (req, res) => {
  try {
    const list = await EnrollmentForm.find().sort({ updatedAt: -1, createdAt: -1 }).limit(300);
    res.json({ status: 'success', data: list });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/enrollment-forms', async (req, res) => {
  try {
    const entries = Array.isArray(req.body.entries)
      ? req.body.entries
      : (Array.isArray(req.body) ? req.body : [req.body]);

    const savedItems = [];
    for (const item of entries) {
      if (!item || !item.ownerName) continue;
      const docId = String(item.id || `FRM-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);

      const saved = await EnrollmentForm.findOneAndUpdate(
        { id: docId },
        {
          id: docId,
          formType: item.formType || 'grooming-5-1',
          selectedPackage: item.selectedPackage || '',
          ownerName: item.ownerName,
          phone: item.phone || '',
          petName: item.petName || '',
          breed: item.breed || '',
          weight: item.weight || '',
          address: item.address || '',
          trainingDetails: item.trainingDetails || {},
          signatureDataUrl: item.signatureDataUrl || '',
          dateStr: item.dateStr || ''
        },
        { upsert: true, new: true }
      );
      savedItems.push(saved);
    }

    const allForms = await EnrollmentForm.find().sort({ updatedAt: -1, createdAt: -1 }).limit(300);
    res.json({
      status: 'success',
      message: 'Form Pendaftaran Paket tersimpan di MongoDB',
      saved: savedItems,
      data: allForms
    });
  } catch (error) {
    console.error('Error POST /api/enrollment-forms:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.delete('/api/enrollment-forms/:id', async (req, res) => {
  try {
    await EnrollmentForm.findOneAndDelete({ id: req.params.id });
    res.json({ status: 'success', message: 'Form Pendaftaran Paket dihapus dari MongoDB' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============================================================================
// 10. SKEMA & ENDPOINT ABSENSI KARYAWAN (/api/absensi)
//     + CRUD Karyawan di MongoDB ('absensi_employees')
//     + Selfie Datang/Pulang + Auto-Bersih Foto > 7 Hari
//     + Pengaturan GPS (radius 500m) & Selfie + Jejak Audit (Manual/Diedit)
// ============================================================================
const ABSENSI_ADMIN_PASSWORD = process.env.ABSENSI_ADMIN_PASSWORD || 'Admin!2345';
const DEFAULT_OFFICE_LAT = -6.2490868;
const DEFAULT_OFFICE_LNG = 106.7929767;
const DEFAULT_GPS_RADIUS = 500;
const SELFIE_RETENTION_DAYS = 7;

const DEFAULT_ABSENSI_EMPLOYEES = [
  { nama: 'LIDYA TRIKURNIAWATI', kode: 'LIDYAR01', kategori: 'Kepala Toko', kuotaCuti: 12, urutan: 1 },
  { nama: 'PAULUS KUAT', kode: 'PAULUSR02', kategori: 'Staff', kuotaCuti: 12, urutan: 2 },
  { nama: 'KASRIN', kode: 'KASRINR03', kategori: 'Staff', kuotaCuti: 12, urutan: 3 },
  { nama: 'WIKE', kode: 'WIKER04', kategori: 'Staff', kuotaCuti: 12, urutan: 4 },
  { nama: 'YOEL ALIANSAH', kode: 'YOELR05', kategori: 'Staff', kuotaCuti: 12, urutan: 5 },
  { nama: 'PRAYOGA', kode: 'YOGAR06', kategori: 'Staff', kuotaCuti: 12, urutan: 6 },
  { nama: 'YUDI MAKATIPU', kode: 'YUDIR07', kategori: 'Staff', kuotaCuti: 12, urutan: 7 },
  { nama: 'YOHANES YUNTORO', kode: 'TOROR08', kategori: 'Groomer', kuotaCuti: 12, urutan: 8 },
  { nama: 'EDI WARSONO', kode: 'EDIR09', kategori: 'Groomer', kuotaCuti: 12, urutan: 9 },
  { nama: 'RISMANTO', kode: 'ARISR10', kategori: 'Groomer', kuotaCuti: 12, urutan: 10 },
  { nama: 'EDI HARDIANTO', kode: 'ANTOR11', kategori: 'Groomer', kuotaCuti: 12, urutan: 11 },
  { nama: 'MOKO', kode: 'MOKOR12', kategori: 'Groomer', kuotaCuti: 12, urutan: 12 },
  { nama: 'LAZUARDI', kode: 'ARDIR13', kategori: 'Groomer', kuotaCuti: 12, urutan: 13 },
  { nama: 'ANGGI ERMAWAN', kode: 'ANGGIR14', kategori: 'Groomer', kuotaCuti: 12, urutan: 14 },
  { nama: 'INDRA', kode: 'INDRAR15', kategori: 'Groomer', kuotaCuti: 12, urutan: 15 },
  { nama: 'WAHYU', kode: 'WAHYUR16', kategori: 'Groomer', kuotaCuti: 12, urutan: 16 },
  { nama: 'FADLI RAKA', kode: 'RAKAR17', kategori: 'Groomer', kuotaCuti: 12, urutan: 17 },
  { nama: 'DIKI SUHARI', kode: 'DIKIR18', kategori: 'Groomer', kuotaCuti: 12, urutan: 18 }
];

// Skema Karyawan Dinamis (CRUD di MongoDB)
const absensiEmployeeSchema = new mongoose.Schema({
  nama: { type: String, required: true },
  kode: { type: String, required: true, unique: true, uppercase: true, trim: true },
  kategori: { type: String, default: 'Staff', enum: ['Kepala Toko', 'Staff', 'Groomer'] },
  kuotaCuti: { type: Number, default: 12 },
  urutan: { type: Number, default: 99 },
  aktif: { type: Boolean, default: true }
}, { timestamps: true, collection: 'absensi_employees' });

const AbsensiEmployee = mongoose.model('AbsensiEmployee', absensiEmployeeSchema);

async function ensureSeededEmployees() {
  try {
    const count = await AbsensiEmployee.countDocuments();
    if (count === 0) {
      await AbsensiEmployee.insertMany(DEFAULT_ABSENSI_EMPLOYEES);
      console.log('✅ Auto-seed 18 karyawan ke collection absensi_employees');
    }
  } catch (err) {
    console.error('Seed absensi_employees error:', err.message);
  }
}

async function getAllAbsensiEmployees() {
  await ensureSeededEmployees();
  const list = await AbsensiEmployee.find({ aktif: { $ne: false } }).sort({ urutan: 1, nama: 1 }).lean();
  if (list.length > 0) {
    return list.map((e, i) => ({
      id: String(e._id),
      nama: e.nama,
      kode: e.kode,
      kategori: e.kategori || 'Staff',
      kuotaCuti: typeof e.kuotaCuti === 'number' ? e.kuotaCuti : 12,
      urutan: typeof e.urutan === 'number' ? e.urutan : i + 1
    }));
  }
  return DEFAULT_ABSENSI_EMPLOYEES.map((e, i) => ({ id: `def_${i}`, ...e }));
}

async function findAbsensiEmployeeAsync(rawKode) {
  const clean = String(rawKode || '').trim().toUpperCase();
  if (!clean) return null;
  await ensureSeededEmployees();
  const doc = await AbsensiEmployee.findOne({ kode: clean, aktif: { $ne: false } }).lean();
  if (doc) {
    return {
      id: String(doc._id),
      nama: doc.nama,
      kode: doc.kode,
      kategori: doc.kategori || 'Staff',
      kuotaCuti: typeof doc.kuotaCuti === 'number' ? doc.kuotaCuti : 12
    };
  }
  const fallback = DEFAULT_ABSENSI_EMPLOYEES.find((e) => e.kode.toUpperCase() === clean);
  return fallback || null;
}

async function resolveEmployeeKategoriAsync(kode, nama) {
  const byKode = await findAbsensiEmployeeAsync(kode);
  if (byKode) return byKode.kategori;
  const cleanNama = String(nama || '').trim().toUpperCase();
  const all = await getAllAbsensiEmployees();
  const byNama = all.find((e) => e.nama.toUpperCase() === cleanNama);
  return byNama ? byNama.kategori : '';
}

const absensiSettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'main' },
  gpsEnabled: { type: Boolean, default: true },
  selfieEnabled: { type: Boolean, default: true },
  officeLat: { type: Number, default: DEFAULT_OFFICE_LAT },
  officeLng: { type: Number, default: DEFAULT_OFFICE_LNG },
  radiusMeters: { type: Number, default: DEFAULT_GPS_RADIUS }
}, { timestamps: true, collection: 'absensi_settings' });

const AbsensiSettings = mongoose.model('AbsensiSettings', absensiSettingsSchema);

async function getAbsensiSettings() {
  let cfg = await AbsensiSettings.findOne({ key: 'main' }).lean();
  if (!cfg) {
    cfg = await AbsensiSettings.create({
      key: 'main',
      gpsEnabled: true,
      selfieEnabled: true,
      officeLat: DEFAULT_OFFICE_LAT,
      officeLng: DEFAULT_OFFICE_LNG,
      radiusMeters: DEFAULT_GPS_RADIUS
    });
  }
  return {
    gpsEnabled: Boolean(cfg.gpsEnabled),
    selfieEnabled: cfg.selfieEnabled === undefined ? true : Boolean(cfg.selfieEnabled),
    officeLat: typeof cfg.officeLat === 'number' ? cfg.officeLat : DEFAULT_OFFICE_LAT,
    officeLng: typeof cfg.officeLng === 'number' ? cfg.officeLng : DEFAULT_OFFICE_LNG,
    radiusMeters: typeof cfg.radiusMeters === 'number' && cfg.radiusMeters > 0 ? cfg.radiusMeters : DEFAULT_GPS_RADIUS
  };
}

const absensiSchema = new mongoose.Schema({
  tanggal: { type: String, required: true, index: true }, // Format YYYY-MM-DD (WIB)
  nama: { type: String, required: true },
  kode: { type: String, required: true, index: true },
  kategori: { type: String, default: '' },
  jamDatang: { type: String, default: '' },
  jamPulang: { type: String, default: '' },
  statusDatang: { type: String, default: '' },
  statusPulang: { type: String, default: '' },
  jarakDatangM: { type: Number, default: null },
  jarakPulangM: { type: Number, default: null },
  fotoDatang: { type: String, default: '' },
  fotoPulang: { type: String, default: '' },
  isManual: { type: Boolean, default: false },
  isEdited: { type: Boolean, default: false },
  auditNote: { type: String, default: '' },
  datangMs: { type: Number, default: null },
  pulangMs: { type: Number, default: null },
  updatedAt: { type: Number, default: () => Date.now() }
}, { timestamps: true, collection: 'absensi_karyawan' });

absensiSchema.index({ tanggal: 1, kode: 1 }, { unique: true });

const Absensi = mongoose.model('Absensi', absensiSchema);

function getWibDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = {};
  for (const p of formatter.formatToParts(date)) {
    parts[p.type] = p.value;
  }
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const tanggal = `${parts.year}-${parts.month}-${parts.day}`;
  const jam = `${hour}:${parts.minute}:${parts.second}`;
  const dayOfWeek = new Date(`${tanggal}T12:00:00+07:00`).getDay();
  return { tanggal, jam, dayOfWeek };
}

// Auto-bersih foto selfie > 7 hari (hanya hapus field foto; data absensi tetap permanen)
let lastPhotoCleanupMs = 0;
async function cleanupOldSelfies(days = SELFIE_RETENTION_DAYS, force = false) {
  const nowMs = Date.now();
  if (!force && nowMs - lastPhotoCleanupMs < 3600 * 1000) return 0;
  lastPhotoCleanupMs = nowMs;
  try {
    const cutoffDate = new Date(nowMs - days * 86400000);
    const { tanggal: cutoffKey } = getWibDateParts(cutoffDate);
    const res = await Absensi.updateMany(
      {
        tanggal: { $lt: cutoffKey },
        $or: [{ fotoDatang: { $ne: '' } }, { fotoPulang: { $ne: '' } }]
      },
      { $set: { fotoDatang: '', fotoPulang: '' } }
    );
    if (res.modifiedCount > 0) {
      console.log(`🧹 Auto-bersih selfie > ${days} hari (< ${cutoffKey}): ${res.modifiedCount} baris dibersihkan.`);
    }
    return res.modifiedCount || 0;
  } catch (err) {
    console.error('Error cleanupOldSelfies:', err.message);
    return 0;
  }
}

// Jalankan pembersihan foto > 7 hari otomatis saat server siap & setiap 6 jam
setTimeout(() => { cleanupOldSelfies(SELFIE_RETENTION_DAYS, true); }, 8000);
setInterval(() => { cleanupOldSelfies(SELFIE_RETENTION_DAYS, true); }, 6 * 3600 * 1000);

function sanitizeSelfieDataUrl(raw) {
  const str = String(raw || '').trim();
  if (!str) return '';
  if (!str.startsWith('data:image/')) return '';
  // Batasi maksimal ~150 KB base64 per foto demi keamanan 512 MB MongoDB
  if (str.length > 180000) return '';
  return str;
}

function timeStrToSeconds(timeStr) {
  if (!timeStr) return null;
  const parts = String(timeStr).split(':').map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return null;
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

// Senin-Sabtu: 09:00 - 17:00 | Minggu: 10:00 - 16:00
function getShiftBoundsSeconds(tanggal) {
  const dayOfWeek = new Date(`${tanggal}T12:00:00+07:00`).getDay();
  if (dayOfWeek === 0) {
    return { startSec: 10 * 3600, endSec: 16 * 3600 };
  }
  return { startSec: 9 * 3600, endSec: 17 * 3600 };
}

function evaluateStatusDatang(tanggal, jamDatang, approvedIzinKode = '') {
  const sec = timeStrToSeconds(jamDatang);
  if (sec === null) return '';
  if (approvedIzinKode === 'IZ-BB' || approvedIzinKode === 'IZ-SB') {
    return sec > 13 * 3600 ? 'Telat (IZ-BB)' : 'Tepat Waktu (IZ-BB)';
  }
  const { startSec } = getShiftBoundsSeconds(tanggal);
  return sec > startSec ? 'Telat' : 'Tepat Waktu';
}

function evaluateStatusPulang(tanggal, jamPulang, approvedIzinKode = '') {
  const sec = timeStrToSeconds(jamPulang);
  if (sec === null) return '';
  if (approvedIzinKode === 'IZ-AB' || approvedIzinKode === 'IZ-SS') {
    return sec < 12 * 3600 ? 'Pulang Cepat (IZ-AB)' : 'Tepat Waktu (IZ-AB)';
  }
  const { endSec } = getShiftBoundsSeconds(tanggal);
  return sec < endSec ? 'Pulang Cepat' : 'Tepat Waktu';
}

async function getApprovedIzinKode(kode, tanggal) {
  if (!kode || !tanggal || typeof TimeOff === 'undefined') return '';
  try {
    const found = await TimeOff.findOne({
      kode,
      status: 'Disetujui',
      kodeRekap: { $in: ['IZ-BB', 'IZ-AB', 'IZ-SB', 'IZ-SS'] },
      tanggalMulai: { $lte: tanggal },
      tanggalSelesai: { $gte: tanggal }
    }).lean();
    return found ? found.kodeRekap : '';
  } catch (e) {
    return '';
  }
}

function calcDistanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function mapAbsensiDoc(item, fallbackKat = '') {
  return {
    id: String(item._id),
    tanggal: item.tanggal,
    nama: item.nama,
    kode: item.kode,
    kategori: item.kategori || fallbackKat,
    jamDatang: item.jamDatang || '',
    jamPulang: item.jamPulang || '',
    statusDatang: item.statusDatang || evaluateStatusDatang(item.tanggal, item.jamDatang),
    statusPulang: item.statusPulang || evaluateStatusPulang(item.tanggal, item.jamPulang),
    jarakDatangM: typeof item.jarakDatangM === 'number' ? item.jarakDatangM : null,
    jarakPulangM: typeof item.jarakPulangM === 'number' ? item.jarakPulangM : null,
    fotoDatang: item.fotoDatang || '',
    fotoPulang: item.fotoPulang || '',
    isManual: Boolean(item.isManual),
    isEdited: Boolean(item.isEdited),
    auditNote: item.auditNote || '',
    datangMs: item.datangMs,
    pulangMs: item.pulangMs,
    updatedAt: item.updatedAt
  };
}

// CRUD Karyawan (/api/absensi/employees)
app.get('/api/absensi/employees', async (req, res) => {
  try {
    const list = await getAllAbsensiEmployees();
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Gagal memuat daftar karyawan.' });
  }
});

app.post('/api/absensi/employees', async (req, res) => {
  try {
    if (req.headers['x-admin-password'] !== ABSENSI_ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Akses ditolak. Password admin tidak valid.' });
    }
    const nama = String(req.body.nama || '').trim().toUpperCase();
    const kode = String(req.body.kode || '').trim().toUpperCase();
    const kategori = ['Kepala Toko', 'Staff', 'Groomer'].includes(req.body.kategori) ? req.body.kategori : 'Staff';
    const kuotaCuti = Math.max(0, Math.min(30, Number(req.body.kuotaCuti ?? 12)));
    if (!nama || !kode) {
      return res.status(400).json({ error: 'Nama dan Kode Akses wajib diisi.' });
    }
    const exists = await AbsensiEmployee.findOne({ kode });
    if (exists) {
      return res.status(400).json({ error: `Kode akses "${kode}" sudah digunakan karyawan lain.` });
    }
    const count = await AbsensiEmployee.countDocuments();
    const created = await AbsensiEmployee.create({
      nama,
      kode,
      kategori,
      kuotaCuti,
      urutan: Number(req.body.urutan) || (count + 1),
      aktif: true
    });
    res.status(201).json({
      message: `Karyawan ${nama} berhasil ditambahkan.`,
      employee: {
        id: String(created._id),
        nama: created.nama,
        kode: created.kode,
        kategori: created.kategori,
        kuotaCuti: created.kuotaCuti,
        urutan: created.urutan
      }
    });
  } catch (error) {
    console.error('Error POST /api/absensi/employees:', error);
    res.status(500).json({ error: 'Gagal menambah karyawan baru.' });
  }
});

app.put('/api/absensi/employees/:id', async (req, res) => {
  try {
    if (req.headers['x-admin-password'] !== ABSENSI_ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Akses ditolak. Password admin tidak valid.' });
    }
    const emp = await AbsensiEmployee.findById(req.params.id);
    if (!emp) return res.status(404).json({ error: 'Karyawan tidak ditemukan.' });

    const nama = String(req.body.nama || emp.nama).trim().toUpperCase();
    const kode = String(req.body.kode || emp.kode).trim().toUpperCase();
    const kategori = ['Kepala Toko', 'Staff', 'Groomer'].includes(req.body.kategori) ? req.body.kategori : emp.kategori;
    const kuotaCuti = Math.max(0, Math.min(30, Number(req.body.kuotaCuti ?? emp.kuotaCuti ?? 12)));
    const urutan = Number(req.body.urutan) || emp.urutan;

    if (kode !== emp.kode) {
      const clash = await AbsensiEmployee.findOne({ kode, _id: { $ne: emp._id } });
      if (clash) return res.status(400).json({ error: `Kode akses "${kode}" sudah dipakai.` });
    }

    emp.nama = nama;
    emp.kode = kode;
    emp.kategori = kategori;
    emp.kuotaCuti = kuotaCuti;
    emp.urutan = urutan;
    await emp.save();

    res.json({
      message: `Data karyawan ${emp.nama} berhasil diperbarui.`,
      employee: {
        id: String(emp._id),
        nama: emp.nama,
        kode: emp.kode,
        kategori: emp.kategori,
        kuotaCuti: emp.kuotaCuti,
        urutan: emp.urutan
      }
    });
  } catch (error) {
    console.error('Error PUT /api/absensi/employees/:id:', error);
    res.status(500).json({ error: 'Gagal memperbarui data karyawan.' });
  }
});

app.delete('/api/absensi/employees/:id', async (req, res) => {
  try {
    if (req.headers['x-admin-password'] !== ABSENSI_ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Akses ditolak. Password admin tidak valid.' });
    }
    const deleted = await AbsensiEmployee.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Karyawan tidak ditemukan.' });
    res.json({ ok: true, id: req.params.id, message: `Karyawan ${deleted.nama} dihapus.` });
  } catch (error) {
    res.status(500).json({ error: 'Gagal menghapus karyawan.' });
  }
});

// Pengaturan GPS & Selfie
app.get('/api/absensi/settings', async (req, res) => {
  try {
    const cfg = await getAbsensiSettings();
    res.json(cfg);
  } catch (error) {
    res.status(500).json({ error: 'Gagal memuat pengaturan GPS & Selfie.' });
  }
});

app.put('/api/absensi/settings', async (req, res) => {
  try {
    const adminPass = req.headers['x-admin-password'];
    if (adminPass !== ABSENSI_ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Akses ditolak. Password admin tidak valid.' });
    }
    const gpsEnabled = Boolean(req.body.gpsEnabled);
    const selfieEnabled = req.body.selfieEnabled === undefined ? true : Boolean(req.body.selfieEnabled);
    const radiusMeters = Math.max(50, Math.min(5000, Number(req.body.radiusMeters) || DEFAULT_GPS_RADIUS));
    const updated = await AbsensiSettings.findOneAndUpdate(
      { key: 'main' },
      {
        key: 'main',
        gpsEnabled,
        selfieEnabled,
        officeLat: DEFAULT_OFFICE_LAT,
        officeLng: DEFAULT_OFFICE_LNG,
        radiusMeters
      },
      { upsert: true, new: true }
    ).lean();
    res.json({
      gpsEnabled: Boolean(updated.gpsEnabled),
      selfieEnabled: updated.selfieEnabled === undefined ? true : Boolean(updated.selfieEnabled),
      officeLat: updated.officeLat,
      officeLng: updated.officeLng,
      radiusMeters: updated.radiusMeters
    });
  } catch (error) {
    console.error('Error PUT /api/absensi/settings:', error);
    res.status(500).json({ error: 'Gagal menyimpan pengaturan.' });
  }
});

// Bersihkan foto selfie > 7 hari secara manual
app.post('/api/absensi/cleanup-photos', async (req, res) => {
  try {
    if (req.headers['x-admin-password'] !== ABSENSI_ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Akses ditolak.' });
    }
    const cleaned = await cleanupOldSelfies(SELFIE_RETENTION_DAYS, true);
    res.json({ ok: true, cleaned, message: `${cleaned} foto selfie lebih dari ${SELFIE_RETENTION_DAYS} hari dibersihkan.` });
  } catch (error) {
    res.status(500).json({ error: 'Gagal membersihkan foto lama.' });
  }
});

app.get('/api/absensi', async (req, res) => {
  try {
    cleanupOldSelfies(SELFIE_RETENTION_DAYS, false);
    const allEmps = await getAllAbsensiEmployees();
    const list = await Absensi.find().sort({ updatedAt: -1 }).lean();
    const mapped = list.map((item) => {
      const empMatch = allEmps.find(
        (e) => e.kode.toUpperCase() === String(item.kode || '').toUpperCase() ||
               e.nama.toUpperCase() === String(item.nama || '').trim().toUpperCase()
      );
      return mapAbsensiDoc(item, empMatch ? empMatch.kategori : '');
    });
    res.json(mapped);
  } catch (error) {
    console.error('Error GET /api/absensi:', error);
    res.status(500).json({ error: 'Gagal memuat data absensi dari MongoDB.' });
  }
});

app.post('/api/absensi/datang', async (req, res) => {
  try {
    const emp = await findAbsensiEmployeeAsync(req.body.kode);
    if (!emp) {
      return res.status(404).json({ error: 'Kode akses tidak ditemukan. Periksa kembali kode Anda.' });
    }

    const cfg = await getAbsensiSettings();
    let jarakM = null;
    if (cfg.gpsEnabled) {
      const lat = Number(req.body.lat);
      const lng = Number(req.body.lng);
      if (Number.isNaN(lat) || Number.isNaN(lng)) {
        return res.status(400).json({ error: 'GPS wajib aktif. Izinkan akses lokasi di browser Anda untuk absen.' });
      }
      jarakM = calcDistanceMeters(lat, lng, cfg.officeLat, cfg.officeLng);
      if (jarakM > cfg.radiusMeters) {
        return res.status(403).json({
          error: `Anda berada di luar radius absensi (${jarakM} m dari Groovy Pet Center Radio, maks ${cfg.radiusMeters} m).`
        });
      }
    }

    const fotoDatang = sanitizeSelfieDataUrl(req.body.foto);
    if (cfg.selfieEnabled && !fotoDatang) {
      return res.status(400).json({ error: 'Foto selfie wajib diambil untuk melakukan Absen Datang.' });
    }

    const now = new Date();
    const { tanggal, jam } = getWibDateParts(now);
    const nowMs = now.getTime();

    const existing = await Absensi.findOne({ tanggal, kode: emp.kode });
    if (existing) {
      return res.status(400).json({
        error: `${emp.nama} sudah melakukan Absen Datang hari ini pukul ${existing.jamDatang}.`
      });
    }

    const approvedIzin = await getApprovedIzinKode(emp.kode, tanggal);
    const statusDatang = evaluateStatusDatang(tanggal, jam, approvedIzin);

    const created = await Absensi.create({
      tanggal,
      nama: emp.nama,
      kode: emp.kode,
      kategori: emp.kategori,
      jamDatang: jam,
      jamPulang: '',
      statusDatang,
      statusPulang: '',
      jarakDatangM: jarakM,
      jarakPulangM: null,
      fotoDatang,
      fotoPulang: '',
      isManual: false,
      isEdited: false,
      auditNote: '',
      datangMs: nowMs,
      pulangMs: null,
      updatedAt: nowMs
    });

    cleanupOldSelfies(SELFIE_RETENTION_DAYS, false);

    res.status(201).json({
      message: `${emp.nama} berhasil Absen Datang (${jam} • ${statusDatang})`,
      record: mapAbsensiDoc(created, emp.kategori)
    });
  } catch (error) {
    console.error('Error POST /api/absensi/datang:', error);
    res.status(500).json({ error: 'Terjadi kesalahan saat menyimpan Absen Datang.' });
  }
});

app.post('/api/absensi/pulang', async (req, res) => {
  try {
    const emp = await findAbsensiEmployeeAsync(req.body.kode);
    if (!emp) {
      return res.status(404).json({ error: 'Kode akses tidak ditemukan. Periksa kembali kode Anda.' });
    }

    const cfg = await getAbsensiSettings();
    let jarakM = null;
    if (cfg.gpsEnabled) {
      const lat = Number(req.body.lat);
      const lng = Number(req.body.lng);
      if (Number.isNaN(lat) || Number.isNaN(lng)) {
        return res.status(400).json({ error: 'GPS wajib aktif. Izinkan akses lokasi di browser Anda untuk absen.' });
      }
      jarakM = calcDistanceMeters(lat, lng, cfg.officeLat, cfg.officeLng);
      if (jarakM > cfg.radiusMeters) {
        return res.status(403).json({
          error: `Anda berada di luar radius absensi (${jarakM} m dari Groovy Pet Center Radio, maks ${cfg.radiusMeters} m).`
        });
      }
    }

    const fotoPulang = sanitizeSelfieDataUrl(req.body.foto);
    if (cfg.selfieEnabled && !fotoPulang) {
      return res.status(400).json({ error: 'Foto selfie wajib diambil untuk melakukan Absen Pulang.' });
    }

    const now = new Date();
    const { tanggal, jam } = getWibDateParts(now);
    const nowMs = now.getTime();

    const existing = await Absensi.findOne({ tanggal, kode: emp.kode });
    if (!existing) {
      return res.status(400).json({
        error: `${emp.nama} belum melakukan Absen Datang hari ini.`
      });
    }

    if (existing.jamPulang) {
      return res.status(400).json({
        error: `${emp.nama} sudah melakukan Absen Pulang hari ini pukul ${existing.jamPulang}.`
      });
    }

    const approvedIzin = await getApprovedIzinKode(emp.kode, tanggal);
    const statusPulang = evaluateStatusPulang(tanggal, jam, approvedIzin);

    existing.jamPulang = jam;
    existing.statusPulang = statusPulang;
    existing.jarakPulangM = jarakM;
    existing.fotoPulang = fotoPulang;
    existing.pulangMs = nowMs;
    existing.updatedAt = nowMs;
    await existing.save();

    res.json({
      message: `${emp.nama} berhasil Absen Pulang (${jam} • ${statusPulang})`,
      record: mapAbsensiDoc(existing, emp.kategori)
    });
  } catch (error) {
    console.error('Error POST /api/absensi/pulang:', error);
    res.status(500).json({ error: 'Terjadi kesalahan saat menyimpan Absen Pulang.' });
  }
});

app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body || {};
  if (password === ABSENSI_ADMIN_PASSWORD) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Password salah. Silakan coba lagi.' });
});

function normalizeTimeStr(raw) {
  const str = String(raw || '').trim();
  if (!str) return '';
  const parts = str.split(':');
  if (parts.length === 2) return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}:00`;
  if (parts.length >= 3) return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}:${parts[2].padStart(2, '0')}`;
  return str;
}

function wibDateTimeToMs(tanggal, jam) {
  if (!tanggal || !jam) return null;
  const norm = normalizeTimeStr(jam);
  const dt = new Date(`${tanggal}T${norm}+07:00`);
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}

// API: Input Manual Absensi (Khusus Admin) + Audit Note
app.post('/api/absensi/manual', async (req, res) => {
  try {
    const adminPass = req.headers['x-admin-password'];
    if (adminPass !== ABSENSI_ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Akses ditolak. Password admin tidak valid.' });
    }
    const emp = await findAbsensiEmployeeAsync(req.body.kode);
    if (!emp) {
      return res.status(400).json({ error: 'Karyawan tidak valid.' });
    }
    const tanggal = String(req.body.tanggal || '').trim();
    const jamDatang = normalizeTimeStr(req.body.jamDatang);
    const jamPulang = normalizeTimeStr(req.body.jamPulang);

    if (!tanggal || !jamDatang) {
      return res.status(400).json({ error: 'Tanggal dan Jam Datang wajib diisi.' });
    }

    const existing = await Absensi.findOne({ tanggal, kode: emp.kode });
    if (existing) {
      return res.status(400).json({
        error: `Data absensi ${emp.nama} pada ${tanggal} sudah ada. Gunakan tombol Edit pada tabel.`
      });
    }

    const datangMs = wibDateTimeToMs(tanggal, jamDatang);
    const pulangMs = jamPulang ? wibDateTimeToMs(tanggal, jamPulang) : null;
    if (pulangMs !== null && datangMs !== null && pulangMs < datangMs) {
      return res.status(400).json({ error: 'Jam Pulang tidak boleh lebih awal dari Jam Datang.' });
    }

    const { tanggal: nowTgl, jam: nowJam } = getWibDateParts(new Date());
    const approvedIzin = await getApprovedIzinKode(emp.kode, tanggal);

    const created = await Absensi.create({
      tanggal,
      nama: emp.nama,
      kode: emp.kode,
      kategori: emp.kategori,
      jamDatang,
      jamPulang,
      statusDatang: evaluateStatusDatang(tanggal, jamDatang, approvedIzin),
      statusPulang: jamPulang ? evaluateStatusPulang(tanggal, jamPulang, approvedIzin) : '',
      jarakDatangM: null,
      jarakPulangM: null,
      fotoDatang: '',
      fotoPulang: '',
      isManual: true,
      isEdited: false,
      auditNote: `Input Manual Admin (${nowTgl} ${nowJam.slice(0, 5)} WIB)`,
      datangMs,
      pulangMs,
      updatedAt: Date.now()
    });

    res.status(201).json({
      message: `Input manual absensi ${emp.nama} (${tanggal}) berhasil disimpan.`,
      record: mapAbsensiDoc(created, emp.kategori)
    });
  } catch (error) {
    console.error('Error POST /api/absensi/manual:', error);
    res.status(500).json({ error: 'Gagal menyimpan input manual absensi.' });
  }
});

// API: Edit Data Absensi (Khusus Admin) + Audit Note
app.put('/api/absensi/:id', async (req, res) => {
  try {
    const adminPass = req.headers['x-admin-password'];
    if (adminPass !== ABSENSI_ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Akses ditolak. Password admin tidak valid.' });
    }
    const existing = await Absensi.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Data absensi tidak ditemukan.' });
    }

    const tanggal = String(req.body.tanggal || existing.tanggal).trim();
    const jamDatang = normalizeTimeStr(req.body.jamDatang);
    const jamPulang = normalizeTimeStr(req.body.jamPulang);

    if (!tanggal || !jamDatang) {
      return res.status(400).json({ error: 'Tanggal dan Jam Datang wajib diisi.' });
    }

    if (tanggal !== existing.tanggal) {
      const clash = await Absensi.findOne({ tanggal, kode: existing.kode, _id: { $ne: existing._id } });
      if (clash) {
        return res.status(400).json({ error: `Sudah ada data absensi ${existing.nama} pada ${tanggal}.` });
      }
    }

    const datangMs = wibDateTimeToMs(tanggal, jamDatang);
    const pulangMs = jamPulang ? wibDateTimeToMs(tanggal, jamPulang) : null;
    if (pulangMs !== null && datangMs !== null && pulangMs < datangMs) {
      return res.status(400).json({ error: 'Jam Pulang tidak boleh lebih awal dari Jam Datang.' });
    }

    const { tanggal: nowTgl, jam: nowJam } = getWibDateParts(new Date());
    const approvedIzinEdit = await getApprovedIzinKode(existing.kode, tanggal);

    existing.tanggal = tanggal;
    existing.jamDatang = jamDatang;
    existing.jamPulang = jamPulang;
    existing.statusDatang = evaluateStatusDatang(tanggal, jamDatang, approvedIzinEdit);
    existing.statusPulang = jamPulang ? evaluateStatusPulang(tanggal, jamPulang, approvedIzinEdit) : '';
    existing.isEdited = true;
    existing.auditNote = `Diedit Admin (${nowTgl} ${nowJam.slice(0, 5)} WIB)`;
    existing.datangMs = datangMs;
    existing.pulangMs = pulangMs;
    existing.updatedAt = Date.now();
    await existing.save();

    res.json({
      message: `Data absensi ${existing.nama} berhasil diperbarui.`,
      record: mapAbsensiDoc(existing, await resolveEmployeeKategoriAsync(existing.kode, existing.nama))
    });
  } catch (error) {
    console.error('Error PUT /api/absensi/:id:', error);
    res.status(500).json({ error: 'Gagal memperbarui data absensi.' });
  }
});

app.delete('/api/absensi/:id', async (req, res) => {
  try {
    const adminPass = req.headers['x-admin-password'];
    if (adminPass !== ABSENSI_ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Akses ditolak. Password admin tidak valid.' });
    }
    const deleted = await Absensi.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Data absensi tidak ditemukan.' });
    }
    res.json({ ok: true, id: req.params.id });
  } catch (error) {
    console.error('Error DELETE /api/absensi/:id:', error);
    res.status(500).json({ error: 'Gagal menghapus data absensi.' });
  }
});

// ============================================================================
// 11. SKEMA & ENDPOINT REQUEST TIME OFF, LMM & REQUEST ABSEN (/api/timeoff)
//     Approval hanya diperbolehkan untuk kategori 'Kepala Toko'
// ============================================================================
const timeOffSchema = new mongoose.Schema({
  kode: { type: String, required: true, index: true },
  nama: { type: String, required: true },
  kategori: { type: String, default: '' },
  jenis: { type: String, required: true },
  subIzin: { type: String, default: '' },
  kodeRekap: { type: String, required: true },
  tanggalMulai: { type: String, required: true },
  tanggalSelesai: { type: String, required: true },
  jumlahHari: { type: Number, default: 1 },
  jamRequest: { type: String, default: '' },
  alasan: { type: String, default: '' },
  status: { type: String, default: 'Menunggu', enum: ['Menunggu', 'Disetujui', 'Ditolak'] },
  approvedBy: { type: String, default: '' },
  approvedAt: { type: String, default: '' },
  createdAtMs: { type: Number, default: () => Date.now() }
}, { timestamps: true, collection: 'absensi_timeoff' });

const TimeOff = mongoose.model('TimeOff', timeOffSchema);

function computeTimeOffKodeRekap(jenis, subIzin) {
  if (jenis === 'Cuti Tahunan') return 'CT';
  if (jenis === 'Libur Masuk Minggu') return 'LMM';
  if (jenis === 'Sakit') return 'SK';
  if (jenis === 'Izin') {
    if (subIzin === 'Before Break' || subIzin === 'Sebelum Istirahat') return 'IZ-BB';
    if (subIzin === 'After Break' || subIzin === 'Sesudah Istirahat') return 'IZ-AB';
    return 'IZ-FD';
  }
  if (jenis === 'Request Absen') {
    return subIzin === 'Absen Pulang' ? 'REQ-P' : 'REQ-M';
  }
  return 'LAIN';
}

function calcInclusiveDays(startDate, endDate) {
  const sDt = new Date(`${startDate}T00:00:00+07:00`);
  const eDt = new Date(`${endDate}T00:00:00+07:00`);
  if (Number.isNaN(sDt.getTime()) || Number.isNaN(eDt.getTime()) || eDt < sDt) return 0;
  return Math.round((eDt - sDt) / 86400000) + 1;
}

app.get('/api/timeoff', async (req, res) => {
  try {
    const allEmps = await getAllAbsensiEmployees();
    const list = await TimeOff.find().sort({ createdAtMs: -1 }).lean();
    const mapped = list.map((item) => {
      const empMatch = allEmps.find(
        (e) => e.kode.toUpperCase() === String(item.kode || '').toUpperCase() ||
               e.nama.toUpperCase() === String(item.nama || '').trim().toUpperCase()
      );
      return {
        id: String(item._id),
        kode: item.kode,
        nama: item.nama,
        kategori: item.kategori || (empMatch ? empMatch.kategori : ''),
        jenis: item.jenis,
        subIzin: item.subIzin || '',
        kodeRekap: item.kodeRekap,
        tanggalMulai: item.tanggalMulai,
        tanggalSelesai: item.tanggalSelesai,
        jumlahHari: item.jumlahHari || 1,
        jamRequest: item.jamRequest || '',
        alasan: item.alasan || '',
        status: item.status || 'Menunggu',
        approvedBy: item.approvedBy || '',
        approvedAt: item.approvedAt || '',
        createdAtMs: item.createdAtMs || Date.now()
      };
    });
    res.json(mapped);
  } catch (error) {
    console.error('Error GET /api/timeoff:', error);
    res.status(500).json({ error: 'Gagal memuat data pengajuan.' });
  }
});

app.post('/api/timeoff', async (req, res) => {
  try {
    const emp = await findAbsensiEmployeeAsync(req.body.kode);
    if (!emp) {
      return res.status(404).json({ error: 'Kode akses karyawan tidak ditemukan.' });
    }
    const jenis = String(req.body.jenis || '').trim();
    const allowedJenis = ['Cuti Tahunan', 'Libur Masuk Minggu', 'Sakit', 'Izin', 'Request Absen'];
    if (!allowedJenis.includes(jenis)) {
      return res.status(400).json({ error: 'Jenis pengajuan tidak valid.' });
    }

    let subIzin = '';
    let jamRequest = '';
    if (jenis === 'Izin') {
      subIzin = String(req.body.subIzin || '').trim();
      const allowedSub = ['Full Day', 'Before Break', 'After Break', 'Full Time', 'Sebelum Istirahat', 'Sesudah Istirahat'];
      if (!allowedSub.includes(subIzin)) {
        return res.status(400).json({ error: 'Pilih kategori Izin (IZ-FD Full Day, IZ-BB Before Break, atau IZ-AB After Break).' });
      }
    } else if (jenis === 'Request Absen') {
      subIzin = String(req.body.subIzin || '').trim();
      if (!['Absen Datang', 'Absen Pulang'].includes(subIzin)) {
        return res.status(400).json({ error: 'Pilih jenis Request Absen (Absen Datang atau Absen Pulang).' });
      }
      jamRequest = normalizeTimeStr(req.body.jamRequest);
      if (!jamRequest) {
        return res.status(400).json({ error: 'Jam absensi wajib diisi untuk Request Absen.' });
      }
    }

    const tanggalMulai = String(req.body.tanggalMulai || '').trim();
    const tanggalSelesai = jenis === 'Request Absen'
      ? tanggalMulai
      : String(req.body.tanggalSelesai || tanggalMulai).trim();
    const jumlahHari = calcInclusiveDays(tanggalMulai, tanggalSelesai);
    if (!tanggalMulai || jumlahHari <= 0) {
      return res.status(400).json({ error: 'Rentang tanggal tidak valid. Tanggal selesai tidak boleh sebelum tanggal mulai.' });
    }

    const kodeRekap = computeTimeOffKodeRekap(jenis, subIzin);
    const alasan = String(req.body.alasan || '').trim();

    const created = await TimeOff.create({
      kode: emp.kode,
      nama: emp.nama,
      kategori: emp.kategori,
      jenis,
      subIzin,
      kodeRekap,
      tanggalMulai,
      tanggalSelesai,
      jumlahHari,
      jamRequest,
      alasan,
      status: 'Menunggu',
      approvedBy: '',
      approvedAt: '',
      createdAtMs: Date.now()
    });

    res.status(201).json({
      message: `Pengajuan ${jenis}${subIzin ? ` (${subIzin})` : ''} berhasil dikirim.`,
      record: {
        id: String(created._id),
        kode: created.kode,
        nama: created.nama,
        kategori: created.kategori,
        jenis: created.jenis,
        subIzin: created.subIzin,
        kodeRekap: created.kodeRekap,
        tanggalMulai: created.tanggalMulai,
        tanggalSelesai: created.tanggalSelesai,
        jumlahHari: created.jumlahHari,
        jamRequest: created.jamRequest,
        alasan: created.alasan,
        status: created.status,
        approvedBy: created.approvedBy,
        approvedAt: created.approvedAt,
        createdAtMs: created.createdAtMs
      }
    });
  } catch (error) {
    console.error('Error POST /api/timeoff:', error);
    res.status(500).json({ error: 'Gagal mengirim pengajuan.' });
  }
});

app.put('/api/timeoff/:id/approve', async (req, res) => {
  try {
    const approverKode = req.headers['x-approver-kode'];
    const approver = await findAbsensiEmployeeAsync(approverKode);
    if (!approver || approver.kategori !== 'Kepala Toko') {
      return res.status(403).json({
        error: 'Akses ditolak. Hanya Kepala Toko yang dapat menyetujui atau menolak pengajuan.'
      });
    }

    const newStatus = String(req.body.status || '').trim();
    if (!['Disetujui', 'Ditolak'].includes(newStatus)) {
      return res.status(400).json({ error: 'Status persetujuan harus Disetujui atau Ditolak.' });
    }

    const item = await TimeOff.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Data pengajuan tidak ditemukan.' });
    }

    const { tanggal, jam } = getWibDateParts(new Date());
    item.status = newStatus;
    item.approvedBy = approver.nama;
    item.approvedAt = `${tanggal} ${jam.slice(0, 5)} WIB`;
    await item.save();

    if (item.jenis === 'Request Absen' && newStatus === 'Disetujui' && item.jamRequest) {
      const tgl = item.tanggalMulai;
      const approvedIzin = await getApprovedIzinKode(item.kode, tgl);
      let existingAbsen = await Absensi.findOne({ tanggal: tgl, kode: item.kode });
      const auditTxt = `Via Request Absen (Disetujui ${approver.nama})`;

      if (item.subIzin === 'Absen Datang') {
        const datangMs = wibDateTimeToMs(tgl, item.jamRequest);
        const stDatang = evaluateStatusDatang(tgl, item.jamRequest, approvedIzin);
        if (existingAbsen) {
          existingAbsen.jamDatang = item.jamRequest;
          existingAbsen.statusDatang = stDatang;
          existingAbsen.datangMs = datangMs;
          existingAbsen.isManual = true;
          existingAbsen.auditNote = auditTxt;
          existingAbsen.updatedAt = Date.now();
          await existingAbsen.save();
        } else {
          await Absensi.create({
            tanggal: tgl,
            nama: item.nama,
            kode: item.kode,
            kategori: item.kategori || await resolveEmployeeKategoriAsync(item.kode, item.nama),
            jamDatang: item.jamRequest,
            jamPulang: '',
            statusDatang: stDatang,
            statusPulang: '',
            jarakDatangM: null,
            jarakPulangM: null,
            fotoDatang: '',
            fotoPulang: '',
            isManual: true,
            isEdited: false,
            auditNote: auditTxt,
            datangMs,
            pulangMs: null,
            updatedAt: Date.now()
          });
        }
      } else if (item.subIzin === 'Absen Pulang') {
        const pulangMs = wibDateTimeToMs(tgl, item.jamRequest);
        const stPulang = evaluateStatusPulang(tgl, item.jamRequest, approvedIzin);
        if (existingAbsen) {
          existingAbsen.jamPulang = item.jamRequest;
          existingAbsen.statusPulang = stPulang;
          existingAbsen.pulangMs = pulangMs;
          existingAbsen.isEdited = true;
          existingAbsen.auditNote = auditTxt;
          existingAbsen.updatedAt = Date.now();
          await existingAbsen.save();
        } else {
          await Absensi.create({
            tanggal: tgl,
            nama: item.nama,
            kode: item.kode,
            kategori: item.kategori || await resolveEmployeeKategoriAsync(item.kode, item.nama),
            jamDatang: '',
            jamPulang: item.jamRequest,
            statusDatang: '',
            statusPulang: stPulang,
            jarakDatangM: null,
            jarakPulangM: null,
            fotoDatang: '',
            fotoPulang: '',
            isManual: true,
            isEdited: false,
            auditNote: auditTxt,
            datangMs: null,
            pulangMs,
            updatedAt: Date.now()
          });
        }
      }
    }

    if (['IZ-BB', 'IZ-AB', 'IZ-SB', 'IZ-SS'].includes(item.kodeRekap)) {
      const affected = await Absensi.find({
        kode: item.kode,
        tanggal: { $gte: item.tanggalMulai, $lte: item.tanggalSelesai }
      });
      for (const rec of affected) {
        const izinKode = newStatus === 'Disetujui' ? item.kodeRekap : '';
        rec.statusDatang = evaluateStatusDatang(rec.tanggal, rec.jamDatang, izinKode);
        rec.statusPulang = rec.jamPulang ? evaluateStatusPulang(rec.tanggal, rec.jamPulang, izinKode) : '';
        await rec.save();
      }
    }

    res.json({
      message: `Pengajuan ${item.nama} (${item.kodeRekap}) telah ${newStatus.toLowerCase()} oleh ${approver.nama}.`,
      record: {
        id: String(item._id),
        kode: item.kode,
        nama: item.nama,
        kategori: item.kategori,
        jenis: item.jenis,
        subIzin: item.subIzin,
        kodeRekap: item.kodeRekap,
        tanggalMulai: item.tanggalMulai,
        tanggalSelesai: item.tanggalSelesai,
        jumlahHari: item.jumlahHari,
        jamRequest: item.jamRequest,
        alasan: item.alasan,
        status: item.status,
        approvedBy: item.approvedBy,
        approvedAt: item.approvedAt,
        createdAtMs: item.createdAtMs
      }
    });
  } catch (error) {
    console.error('Error PUT /api/timeoff/:id/approve:', error);
    res.status(500).json({ error: 'Gagal memproses persetujuan.' });
  }
});

app.delete('/api/timeoff/:id', async (req, res) => {
  try {
    const adminPass = req.headers['x-admin-password'];
    const approver = await findAbsensiEmployeeAsync(req.headers['x-approver-kode']);
    const isAllowed = adminPass === ABSENSI_ADMIN_PASSWORD || (approver && approver.kategori === 'Kepala Toko');
    if (!isAllowed) {
      return res.status(401).json({ error: 'Akses ditolak.' });
    }
    const deleted = await TimeOff.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Data pengajuan tidak ditemukan.' });
    }
    res.json({ ok: true, id: req.params.id });
  } catch (error) {
    console.error('Error DELETE /api/timeoff/:id:', error);
    res.status(500).json({ error: 'Gagal menghapus pengajuan.' });
  }
});

// Route PWA Manifest & Service Worker agar bisa Instal App di Layar Utama Android
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    id: '/absensi',
    name: 'Absensi Karyawan — Groovy Pet Center Radio 03',
    short_name: 'Absensi Groovy',
    description: 'Aplikasi Absensi Karyawan, Time Off, dan LMM Groovy Pet Center Radio 03',
    start_url: '/absensi',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#FFF9F5',
    theme_color: '#C2185B',
    icons: [
      {
        src: 'https://i.ibb.co.com/chNqgwX1/Logo-Groovy-Copy.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any'
      },
      {
        src: 'https://i.ibb.co.com/chNqgwX1/Logo-Groovy-Copy.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any'
      }
    ]
  });
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`const CACHE_NAME = 'absensi-groovy-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});`);
});

// Route khusus untuk membuka halaman App Absensi di /absensi
app.get('/absensi', (req, res) => {
  const candidates = ['app_absensi.html', 'app_absensi_mongodb.html'];
  for (const name of candidates) {
    const absensiFile = path.join(__dirname, name);
    if (fs.existsSync(absensiFile)) {
      return res.sendFile(absensiFile);
    }
  }
  res.status(404).send('File app_absensi.html belum ditemukan di folder server.');
});

// Route utama untuk menyajikan file aplikasi terpadu jika diakses via browser
app.get('/', (req, res) => {
  const candidateFiles = [
    'groovy_pet_center_radio_03.html',
    'groovy_pet_center_radio_03_aplikasi_terpadu.html',
    'groovy_pet_center_radio_03_aplikasi_terpadu (6).html',
    'index.html'
  ];
  for (const fileName of candidateFiles) {
    const fullPath = path.join(__dirname, fileName);
    if (fs.existsSync(fullPath)) {
      return res.sendFile(fullPath);
    }
  }
  res.json({ status: 'online', message: 'Groovy Pet Center Radio 03 API Server Active' });
});

// JALANKAN SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server Backend berjalan di port ${PORT}`));
