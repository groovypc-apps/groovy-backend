const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// KONEKSI KE MONGODB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Berhasil Terhubung ke MongoDB Atlas'))
  .catch(err => console.error('❌ Gagal koneksi:', err));

// SKEMA DATABASE
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

// API ENDPOINTS

// 1. Ambil semua data
app.get('/api/packages', async (req, res) => {
  try {
    const packages = await Package.find().sort({ createdAt: -1 });
    res.json({ status: 'success', data: packages });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// 2. Buat paket baru
app.post('/api/packages', async (req, res) => {
  try {
    const newPackage = new Package(req.body);
    await newPackage.save();
    res.json({ status: 'success', message: 'Paket tersimpan di MongoDB' });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
});

// 3. Potong Saldo
app.put('/api/packages/:pkgId/redeem', async (req, res) => {
  try {
    const { pkgId } = req.params;
    const { slotIndex, payload } = req.body;

    const pkg = await Package.findOne({ id: pkgId });
    if (!pkg) return res.status(404).json({ message: 'Paket tidak ditemukan' });

    const slot = pkg.slots.find(s => s.index === slotIndex);
    if(slot) { Object.assign(slot, payload); }

    if (pkg.slots.every(s => s.used === true)) { pkg.status = "Selesai"; }

    await pkg.save();
    res.json({ status: 'success', message: 'Sesi berhasil dipotong' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// 4. Hapus Paket
app.delete('/api/packages/:pkgId', async (req, res) => {
  try {
    await Package.findOneAndDelete({ id: req.params.pkgId });
    res.json({ status: 'success', message: 'Paket dihapus dari MongoDB' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// JALANKAN SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server Backend berjalan di port ${PORT}`));