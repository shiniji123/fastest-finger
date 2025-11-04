// server.js (ฉบับสมบูรณ์ที่แก้ไข Race Condition และ Rejoin แล้ว)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// จัดการ static files เช่น HTML, CSS, JS
app.use(express.static(__dirname));

let rooms = {}; // { '1234': { roomName, hostId, players[], submissions[], isGameActive, disconnectTimer } }

// --- ฟังก์ชันช่วยเหลือ ---
function generateRoomCode() {
    let code;
    do {
        // สร้างรหัส 4 หลัก
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms[code]);
    return code;
}

function isValidName(name) {
    if (!name || name.length === 0 || name.length > 20) return false;
    // อนุญาต ก-ฮ, a-z, และ space, ห้ามตัวเลข/อักษรพิเศษอื่น
    const nameRegex = /^[A-Za-zก-๙\s]+$/; 
    return nameRegex.test(name.trim()); 
}

// --- เริ่มการเชื่อมต่อ Socket ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // === 1. Host สร้างห้อง ===
    socket.on('host-create-room', (data) => {
        const roomName = data.roomName.trim();
        
        if (!isValidName(roomName)) {
            socket.emit('error-message', 'ชื่อห้องไม่ถูกต้อง (ก-ฮ, a-z, ห้ามตัวเลข/อักษรพิเศษ, ไม่เกิน 20 ตัวอักษร)');
            return;
        }

        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            roomName: roomName,
            hostId: socket.id,
            players: [],
            submissions: [],
            isGameActive: false,
            disconnectTimer: null 
        };

        socket.join(roomCode);
        console.log(`Host created room: ${roomCode} (${roomName}) by ${socket.id}`);
        socket.emit('room-created', { roomCode, roomName });
    });

    // === 2. Host เข้าร่วม/Refresh (host.html) ===
    socket.on('host-join', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) {
            socket.emit('error-message', 'ไม่พบห้องนี้', true); 
            return;
        }

        if (room.disconnectTimer) {
            clearTimeout(room.disconnectTimer); // ยกเลิกการปิดห้อง
            room.disconnectTimer = null;
            console.log(`Host reconnected in time. Room ${roomCode} saved.`);
        }

        room.hostId = socket.id;
        socket.join(roomCode);
        console.log(`Host ${socket.id} connected/rejoined room ${roomCode}`);
        
        socket.emit('host-data', {
            roomName: room.roomName,
            roomCode: roomCode,
            players: room.players,
            submissions: room.submissions,
            isGameActive: room.isGameActive
        });
    });

    // === 3. Player เข้าร่วมห้อง ===
    socket.on('player-join-room', (data) => {
        const { roomCode, playerName } = data;
        const trimmedName = playerName.trim();
        const room = rooms[roomCode];

        if (!room) {
            socket.emit('error-message', 'ไม่พบรหัสห้องนี้');
            return;
        }

        if (room.disconnectTimer) {
            socket.emit('error-message', 'Host กำลังเชื่อมต่อ กรุณาลองใหม่อีกครั้ง');
            return;
        }

        if (!isValidName(trimmedName)) {
            socket.emit('error-message', 'ชื่อผู้เล่นไม่ถูกต้อง (ก-ฮ, a-z, ห้ามตัวเลข/อักษรพิเศษ, ไม่เกิน 20 ตัวอักษร)');
            return;
        }

        const existingPlayer = room.players.find(p => p.name === trimmedName);
        if (existingPlayer) {
            socket.emit('error-message', 'มีคนใช้ชื่อนี้ในห้องแล้ว');
            return;
        }
        
        const newPlayer = { id: socket.id, name: trimmedName, fouled: false, buzzed: false };
        room.players.unshift(newPlayer); // ผู้เล่นใหม่ขึ้นบนสุด
        
        socket.join(roomCode);
        console.log(`Player ${trimmedName} joined room ${roomCode} with ID: ${socket.id}`);

        socket.emit('join-success', { playerName: trimmedName, roomName: room.roomName, roomCode: roomCode });
        
        io.to(room.hostId).emit('update-player-list', room.players);
    });

    // === 4. เมื่อ Player เข้าหน้า Player Page (กรณี Refresh/Rejoin) ===
    socket.on('player-rejoin-check', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];

        if (!room) {
            socket.emit('error-message', 'ไม่พบรหัสห้องนี้', true);
            return;
        }

        const player = room.players.find(p => p.name === playerName);
        if (player) {
            player.id = socket.id; // อัปเดต Socket ID ใหม่
            socket.join(roomCode);
            console.log(`Player ${playerName} reconnected to room ${roomCode} with new ID: ${socket.id}`);
            
            socket.emit('rejoin-state', {
                roomName: room.roomName,
                playerName: playerName,
                isGameActive: room.isGameActive,
                playerState: player
            });
            io.to(room.hostId).emit('update-player-list', room.players);
        } else {
            socket.emit('error-message', 'ไม่พบชื่อผู้เล่นนี้ในห้อง หรือห้องถูกปิดแล้ว', true);
        }
    });

    // === 5. Host เริ่มเกม ===
    socket.on('host-start-game', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;

        console.log(`Game started in room ${roomCode}`);
        room.isGameActive = true;
        room.players.forEach(p => { p.fouled = false; p.buzzed = false; });
        room.submissions = [];

        io.to(roomCode).emit('game-started'); 
        io.to(room.hostId).emit('update-submissions', room.submissions);
        io.to(room.hostId).emit('update-player-list', room.players);
    });

    // === 6. Host รีเซ็ตเกม ===
    socket.on('host-reset-game', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;

        console.log(`Game reset in room ${roomCode}`);
        room.isGameActive = false;
        room.players.forEach(p => { p.fouled = false; p.buzzed = false; });
        room.submissions = [];

        io.to(roomCode).emit('game-reset'); 
        io.to(room.hostId).emit('update-submissions', room.submissions);
        io.to(room.hostId).emit('update-player-list', room.players);
    });

    // === 7. Player กดปุ่ม ===
    socket.on('player-buzz', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        
        if (!player || player.buzzed || player.fouled) return;

        const buzzTime = new Date();
        if (!room.isGameActive) {
            player.fouled = true;
            socket.emit('player-foul');
        } else {
            player.buzzed = true;
            room.submissions.push({
                name: player.name,
                time: buzzTime.toLocaleTimeString('th-TH', { hour12: false }) + '.' + buzzTime.getMilliseconds().toString().padStart(3, '0')
            });
            socket.emit('player-done');
            io.to(room.hostId).emit('update-submissions', room.submissions);
        }
        io.to(room.hostId).emit('update-player-list', room.players);
    });

    // === 8. การจัดการเมื่อผู้ใช้หลุด ===
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        for (const roomCode in rooms) {
            const room = rooms[roomCode];

            // ตรรกะของ Host เมื่อ Disconnect
            if (room.hostId === socket.id) {
                console.log(`Host ${socket.id} disconnected from room ${roomCode}. Starting 5s close timer.`);
                
                room.disconnectTimer = setTimeout(() => {
                    if (rooms[roomCode] && rooms[roomCode].disconnectTimer) {
                        console.log(`Room ${roomCode} close timer expired. Closing room.`);
                        io.to(roomCode).emit('error-message', 'Host ไม่ได้เชื่อมต่อ... เกมสิ้นสุดลง', true);
                        delete rooms[roomCode];
                    }
                }, 5000); 
                
                break;
            }

            // ตรรกะของ Player เมื่อ Disconnect
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                console.log(`Player ${player.name} disconnected from room ${roomCode}. Awaiting rejoin.`);
                break;
            }
        }
    });
});

// --- รัน Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});