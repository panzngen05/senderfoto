import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 📁 Auto-create folder jika belum ada (Production Improvement)
const uploadsDir = path.join(__dirname, 'uploads');
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// 🧠 Memory Store untuk user aktif
const users = new Map(); // username -> socketId
const socketToUser = new Map(); // socketId -> username

// ⚙️ Middleware
app.use(express.static(publicDir));
app.use('/uploads', express.static(uploadsDir));
app.use(express.json());

// 🔥 Rate Limiter (Max 10 upload per menit per IP)
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Terlalu banyak request upload. Tunggu 1 menit.' }
});

// 💾 Multer Configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${uuidv4()}${ext}`); // UUID Rename
    }
});

const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Hanya menerima format JPG, PNG, atau WEBP!'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // Max 5MB
});

// 🔌 Socket.io Handlers
io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Handle Login
    socket.on('login', (username, callback) => {
        const cleanUser = username.trim();
        if (!cleanUser) return callback({ success: false, message: 'Username kosong!' });
        
        if (users.has(cleanUser)) {
            return callback({ success: false, message: 'Username sudah dipakai, pilih yang lain.' });
        }

        // Simpan mapping
        users.set(cleanUser, socket.id);
        socketToUser.set(socket.id, cleanUser);

        callback({ success: true });
        broadcastUserList();
    });

    // Handle Disconnect
    socket.on('disconnect', () => {
        const username = socketToUser.get(socket.id);
        if (username) {
            users.delete(username);
            socketToUser.delete(socket.id);
            broadcastUserList();
            console.log(`User disconnected: ${username}`);
        }
    });
});

function broadcastUserList() {
    // Kirim daftar user online (kecuali socketId nya, hanya list username)
    const userList = Array.from(users.keys());
    io.emit('user_list', userList);
}

// 🚀 API Route: Upload & Send Photo
app.post('/upload', uploadLimiter, upload.single('photo'), (req, res) => {
    try {
        const { targetUser, socketId } = req.body;
        const file = req.file;

        // Validasi Request Body
        if (!targetUser || !socketId || !file) {
            // Hapus file jika ada karena validasi gagal
            if (file) fs.unlinkSync(file.path);
            return res.status(400).json({ error: 'Data tidak lengkap (Pilih target dan foto).' });
        }

        const senderUsername = socketToUser.get(socketId);
        
        // Validasi Security Basic
        if (!senderUsername) {
            fs.unlinkSync(file.path);
            return res.status(401).json({ error: 'Unathorized: Kamu belum login.' });
        }
        if (senderUsername === targetUser) {
            fs.unlinkSync(file.path);
            return res.status(400).json({ error: 'Tidak bisa mengirim ke diri sendiri.' });
        }
        if (!users.has(targetUser)) {
            fs.unlinkSync(file.path);
            return res.status(404).json({ error: 'User target sudah offline atau tidak ditemukan.' });
        }

        // Flow Sukses: Emit URL ke target
        const targetSocketId = users.get(targetUser);
        const imageUrl = `/uploads/${file.filename}`;

        io.to(targetSocketId).emit('receive_photo', {
            from: senderUsername,
            imageUrl: imageUrl
        });

        res.json({ success: true, message: 'Foto berhasil dikirim!', imageUrl });

    } catch (error) {
        console.error('Upload Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 🛠 Global Error Handling (termasuk Multer Errors)
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File terlalu besar. Maksimal 5MB.' });
        }
    }
    res.status(500).json({ error: err.message || 'Terjadi kesalahan pada server.' });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
