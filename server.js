const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
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

// KONEKSI KE MONGODB ATLAS
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Berhasil Terhubung ke MongoDB Atlas'))
  .catch(err => console.error('❌ Gagal koneksi:', err));

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

app.post('/api/packages', async (req, res) => {
  try {
    const newPackage = new Package(req.body);
    await newPackage.save();
    res.json({ status: 'success', message: 'Paket tersimpan di MongoDB', data: newPackage });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
});

app.put('/api/packages/:pkgId/redeem', async (req, res) => {
  try {
    const { pkgId } = req.params;
    const { slotIndex, payload } = req.body;

    const pkg = await Package.findOne({ id: pkgId });
    if (!pkg) return res.status(404).json({ message: 'Paket tidak ditemukan' });

    const slot = pkg.slots.find(s => s.index === slotIndex);
    if (slot) { Object.assign(slot, payload); }

    if (pkg.slots.every(s => s.used === true)) { pkg.status = "Selesai"; }

    await pkg.save();
    res.json({ status: 'success', message: 'Sesi berhasil dipotong' });
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
  pinned: { type: Boolean, default: true },
  order: { type: Number, default: 0 }
}, { timestamps: true });

const LauncherLink = mongoose.model('LauncherLink', launcherLinkSchema);

// Ambil semua kartu aplikasi dari MongoDB
app.get('/api/links', async (req, res) => {
  try {
    const links = await LauncherLink.find().sort({ order: 1, createdAt: 1 });
    res.json({ status: 'success', data: links });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Simpan atau update 1 kartu aplikasi (termasuk URL gambar latar & ikon) ke MongoDB
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

// Sinkronisasi / urutkan seluruh daftar kartu sekaligus ke MongoDB
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
    const all = await LauncherLink.find().sort({ order: 1, createdAt: 1 });
    res.json({ status: 'success', data: all });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Hapus 1 kartu aplikasi dari MongoDB
app.delete('/api/links/:id', async (req, res) => {
  try {
    await LauncherLink.findOneAndDelete({ id: req.params.id });
    res.json({ status: 'success', message: 'Kartu aplikasi dihapus dari MongoDB' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// JALANKAN SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server Backend berjalan di port ${PORT}`));
