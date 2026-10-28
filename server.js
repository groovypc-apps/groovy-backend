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
