/**
 * BACKEND SERVER GROOVY PET CENTER RADIO 03 (Node.js + Express + MongoDB + Nodemailer)
 * Mendukung:
 * 1. /api/packages   -> Aplikasi Kartu Paket Layanan Groovy
 * 2. /api/checklists -> Aplikasi Checklist Grooming + Auto-Kirim PDF ke ceklistgrooming@gmail.com
 *
 * Pastikan di package.json sudah terpasang:
 * npm install express mongoose cors dotenv nodemailer
 *
 * Environment Variables di Render.com:
 * - MONGO_URI   : URL koneksi MongoDB Atlas Anda
 * - EMAIL_USER  : Email pengirim (contoh: ceklistgrooming@gmail.com)
 * - EMAIL_PASS  : 16 digit Gmail App Password (bukan password login biasa)
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
// Limit 25MB agar pengiriman lampiran file PDF Base64 tidak terblokir
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ============================================================================
// 1. KONEKSI DATABASE MONGODB ATLAS
// ============================================================================
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Terhubung ke MongoDB Atlas'))
  .catch((err) => console.error('❌ Gagal koneksi MongoDB:', err));

// ============================================================================
// 2. KONFIGURASI NODEMAILER (AUTO-EMAIL PDF KE ceklistgrooming@gmail.com)
// ============================================================================
const DEFAULT_RECEIVER_EMAIL = 'ceklistgrooming@gmail.com';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || DEFAULT_RECEIVER_EMAIL,
    pass: process.env.EMAIL_PASS // Gunakan 16-digit App Password Google
  }
});

// ============================================================================
// 3. SCHEMA & ROUTES: PAKET LAYANAN (/api/packages)
// ============================================================================
const PackageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  date: String,
  owner: String,
  pet: String,
  type: String,
  deposit: Number,
  branch: String,
  status: String,
  notes: String,
  slots: Array
}, { timestamps: true });

const PackageModel = mongoose.model('Package', PackageSchema);

app.get('/api/packages', async (req, res) => {
  try {
    const data = await PackageModel.find().sort({ createdAt: -1 });
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/packages', async (req, res) => {
  try {
    const created = await PackageModel.findOneAndUpdate(
      { id: req.body.id },
      req.body,
      { upsert: true, new: true }
    );
    res.json({ status: 'success', data: created });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.put('/api/packages/:id/redeem', async (req, res) => {
  try {
    const { slotIndex, payload } = req.body;
    const pkg = await PackageModel.findOne({ id: req.params.id });
    if (!pkg) return res.status(404).json({ status: 'error', message: 'Paket tidak ditemukan' });

    const slot = (pkg.slots || []).find(s => Number(s.index) === Number(slotIndex));
    if (!slot) return res.status(400).json({ status: 'error', message: 'Slot tidak ditemukan' });

    Object.assign(slot, payload);
    pkg.markModified('slots');

    const allUsed = (pkg.slots || []).every(s => s.used === true || String(s.used) === 'true');
    pkg.status = allUsed ? 'Selesai' : 'Aktif';

    await pkg.save();
    res.json({ status: 'success', data: pkg });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.delete('/api/packages/:id', async (req, res) => {
  try {
    await PackageModel.deleteOne({ id: req.params.id });
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ============================================================================
// 4. SCHEMA & ROUTES: CHECKLIST GROOMING + AUTO EMAIL PDF (/api/checklists)
// ============================================================================
const ChecklistSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  tanggal: String,
  ownerName: String,
  hp: String,
  alamat: String,
  statusGrooming: String,
  hewan1: Object,
  hewan2: Object,
  catatanKhusus: String,
  groomer: String,
  ttdOwner: String,
  fileName: String
}, { timestamps: true });

const ChecklistModel = mongoose.model('Checklist', ChecklistSchema);

// Ambil semua riwayat checklist dari MongoDB
app.get('/api/checklists', async (req, res) => {
  try {
    const data = await ChecklistModel.find().sort({ createdAt: -1 });
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Simpan checklist ke MongoDB & kirim lampiran PDF ke ceklistgrooming@gmail.com
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

    // 1. Simpan data ke MongoDB (tanpa menyimpan string pdfBase64 agar database tetap hemat ruang)
    const savedDoc = await ChecklistModel.findOneAndUpdate(
      { id: id || `CHK-${Date.now()}` },
      {
        id: id || `CHK-${Date.now()}`,
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

    // 2. Kirim file PDF ke email ceklistgrooming@gmail.com
    let emailSent = false;
    const recipient = targetEmail || DEFAULT_RECEIVER_EMAIL;

    if (pdfBase64 && process.env.EMAIL_PASS) {
      // Bersihkan prefix "data:application/pdf;base64," atau "data:application/pdf;filename=generated.pdf;base64,"
      const cleanBase64 = pdfBase64.includes('base64,')
        ? pdfBase64.split('base64,')[1]
        : pdfBase64;

      const pdfFileName = fileName || `${ownerName || 'Owner'} (${petName || 'Pet'}) ${formattedDate || tanggal}.pdf`;

      await transporter.sendMail({
        from: `"Groovy Pet Center Radio 03" <${process.env.EMAIL_USER || DEFAULT_RECEIVER_EMAIL}>`,
        to: recipient,
        subject: `[CHECKLIST GROOMING - ${statusGrooming || 'GROOMING'}] ${ownerName} (${petName || hewan1?.nama || '-'}) - ${formattedDate || tanggal}`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.5;">
            <h2 style="color: #C2185B; margin-bottom: 4px;">🐾 Checklist Grooming - Groovy Pet Center Radio 03</h2>
            <p style="margin-top: 0; color: #666;">Berikut terlampir dokumen PDF hasil pemeriksaan Checklist Grooming:</p>
            <table style="border-collapse: collapse; width: 100%; max-width: 520px; font-size: 13px;">
              <tr><td style="padding: 6px 10px; border: 1px solid #eee; font-weight: bold; background: #fff8f0;">Tanggal</td><td style="padding: 6px 10px; border: 1px solid #eee;">${formattedDate || tanggal || '-'}</td></tr>
              <tr><td style="padding: 6px 10px; border: 1px solid #eee; font-weight: bold; background: #fff8f0;">Status Grooming</td><td style="padding: 6px 10px; border: 1px solid #eee;"><strong>${statusGrooming || '-'}</strong></td></tr>
              <tr><td style="padding: 6px 10px; border: 1px solid #eee; font-weight: bold; background: #fff8f0;">Nama Owner</td><td style="padding: 6px 10px; border: 1px solid #eee;">${ownerName || '-'} (${hp || '-'})</td></tr>
              <tr><td style="padding: 6px 10px; border: 1px solid #eee; font-weight: bold; background: #fff8f0;">Nama Anabul</td><td style="padding: 6px 10px; border: 1px solid #eee;">${petName || hewan1?.nama || '-'}</td></tr>
              <tr><td style="padding: 6px 10px; border: 1px solid #eee; font-weight: bold; background: #fff8f0;">Petugas / Groomer</td><td style="padding: 6px 10px; border: 1px solid #eee;">${groomer || '-'}</td></tr>
              <tr><td style="padding: 6px 10px; border: 1px solid #eee; font-weight: bold; background: #fff8f0;">Catatan Khusus</td><td style="padding: 6px 10px; border: 1px solid #eee;">${catatanKhusus || '-'}</td></tr>
            </table>
            <p style="font-size: 12px; color: #888; margin-top: 14px;">File PDF lengkap terlampir pada email ini (<strong>${pdfFileName}</strong>).</p>
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
      data: savedDoc
    });
  } catch (err) {
    console.error('Error /api/checklists:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Hapus riwayat checklist dari MongoDB
app.delete('/api/checklists/:id', async (req, res) => {
  try {
    await ChecklistModel.deleteOne({ id: req.params.id });
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server Groovy berjalan di port ${PORT}`);
});
