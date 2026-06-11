const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const db = new Database('cesium.db');

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'cesium-gdps-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// ========== БАЗА ДАННЫХ ==========
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT DEFAULT 'default.png',
        is_admin INTEGER DEFAULT 0,
        is_verified INTEGER DEFAULT 0,
        is_banned INTEGER DEFAULT 0,
        ban_reason TEXT DEFAULT '',
        reputation INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        description TEXT,
        image TEXT,
        username TEXT,
        likes INTEGER DEFAULT 0,
        dislikes INTEGER DEFAULT 0,
        views INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER,
        username TEXT,
        text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reactions (
        user_id INTEGER,
        post_id INTEGER,
        type TEXT CHECK(type IN ('like', 'dislike')),
        PRIMARY KEY (user_id, post_id)
    );
    CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reported_user_id INTEGER,
        reporter_id INTEGER,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS post_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER,
        reporter_id INTEGER,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER,
        to_user_id INTEGER,
        message TEXT,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// Добавляем колонку reputation если её нет
try { db.exec(`ALTER TABLE users ADD COLUMN reputation INTEGER DEFAULT 0`); } catch(e) {}

// Создаём админа NICEPEEK
try {
    let user = db.prepare('SELECT * FROM users WHERE username = ?').get('NICEPEEK');
    if (!user) {
        const hashedPassword = bcrypt.hashSync('nicepeek123', 10);
        db.prepare('INSERT INTO users (username, password, is_admin, is_verified, avatar, reputation) VALUES (?, ?, ?, ?, ?, ?)')
            .run('NICEPEEK', hashedPassword, 1, 1, 'default.png', 100);
        console.log('Администратор NICEPEEK создан');
    } else if (user.is_admin !== 1) {
        db.prepare('UPDATE users SET is_admin = 1, is_verified = 1 WHERE username = ?').run('NICEPEEK');
        console.log('NICEPEEK повышен до администратора');
    }
} catch(e) {}

// Загрузка файлов
const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
function getAuthorInfo(username) {
    try {
        return db.prepare('SELECT username, avatar, is_verified, is_banned, reputation FROM users WHERE username = ?').get(username);
    } catch(e) {
        return { username, avatar: 'default.png', is_verified: 0, is_banned: 0, reputation: 0 };
    }
}
function getUserReaction(userId, postId) {
    if (!userId) return null;
    try {
        const reaction = db.prepare('SELECT type FROM reactions WHERE user_id = ? AND post_id = ?').get(userId, postId);
        return reaction ? reaction.type : null;
    } catch(e) { return null; }
}
function getPostsWithDetails(query, params = [], userId = null) {
    try {
        const posts = db.prepare(query).all(...params);
        posts.forEach(post => {
            post.comments = db.prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY created_at DESC').all(post.id);
            post.author = getAuthorInfo(post.username);
            if (userId) post.userReaction = getUserReaction(userId, post.id);
        });
        return posts;
    } catch(e) { return []; }
}
function incrementViews(postId) { try { db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(postId); } catch(e) {} }
function updateReputation(userId, delta) { try { db.prepare('UPDATE users SET reputation = reputation + ? WHERE id = ?').run(delta, userId); } catch(e) {} }
function getReputationLevel(reputation) {
    if (reputation >= 100) return { class: 'reputation-positive', text: 'Легенда' };
    if (reputation >= 50) return { class: 'reputation-positive', text: 'Звезда' };
    if (reputation >= 20) return { class: 'reputation-positive', text: 'Хорошая' };
    if (reputation >= 0) return { class: 'reputation-neutral', text: 'Нейтральная' };
    if (reputation >= -20) return { class: 'reputation-negative', text: 'Сомнительная' };
    return { class: 'reputation-negative', text: 'Плохая' };
}
// Middleware проверки бана
app.use((req, res, next) => {
    if (req.session.user) {
        try {
            const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
            if (user && user.is_banned === 1) {
                req.session.destroy();
                return res.render('error', { user: null, error: `Вы забанены. Причина: ${user.ban_reason}`, code: 403, url: req.url });
            }
            if (user) {
                req.session.user = { ...req.session.user, ...user };
                const unread = db.prepare('SELECT COUNT(*) as count FROM messages WHERE to_user_id = ? AND is_read = 0').get(req.session.user.id);
                req.session.user.unreadCount = unread ? unread.count : 0;
            }
        } catch(e) {}
    }
    next();
});

// ========== МАРШРУТЫ ==========
app.get('/', (req, res) => {
    const posts = getPostsWithDetails('SELECT * FROM posts ORDER BY created_at DESC', [], req.session.user?.id);
    const stats = {
        totalUsers: db.prepare('SELECT COUNT(*) as count FROM users').get().count,
        totalPosts: db.prepare('SELECT COUNT(*) as count FROM posts').get().count,
        totalComments: db.prepare('SELECT COUNT(*) as count FROM comments').get().count
    };
    const topUsers = db.prepare('SELECT username, reputation FROM users ORDER BY reputation DESC LIMIT 5').all();
    res.render('index', { posts, user: req.session.user, title: 'Лента', stats, topUsers });
});
app.get('/popular', (req, res) => {
    const posts = getPostsWithDetails('SELECT * FROM posts ORDER BY likes DESC, created_at DESC LIMIT 50', [], req.session.user?.id);
    const stats = {
        totalUsers: db.prepare('SELECT COUNT(*) as count FROM users').get().count,
        totalPosts: db.prepare('SELECT COUNT(*) as count FROM posts').get().count,
        totalComments: db.prepare('SELECT COUNT(*) as count FROM comments').get().count
    };
    const topUsers = db.prepare('SELECT username, reputation FROM users ORDER BY reputation DESC LIMIT 5').all();
    res.render('index', { posts, user: req.session.user, title: 'Популярное', stats, topUsers });
});
app.get('/search', (req, res) => {
    const q = req.query.q || '';
    const posts = getPostsWithDetails('SELECT * FROM posts WHERE title LIKE ? OR description LIKE ? OR username LIKE ? ORDER BY created_at DESC', [`%${q}%`, `%${q}%`, `%${q}%`], req.session.user?.id);
    res.render('index', { posts, user: req.session.user, title: `Поиск: ${q}` });
});
app.get('/user/:username', (req, res) => {
    const profileUser = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
    if (!profileUser) return res.status(404).render('error', { user: req.session.user, error: 'Пользователь не найден', code: 404, url: req.url });
    const posts = getPostsWithDetails('SELECT * FROM posts WHERE username = ? ORDER BY created_at DESC', [req.params.username], req.session.user?.id);
    const reputationLevel = getReputationLevel(profileUser.reputation);
    res.render('profile', { posts, user: req.session.user, profileUser, reputationLevel, title: `Профиль ${req.params.username}` });
});
app.get('/post/:id', (req, res) => {
    incrementViews(req.params.id);
    const posts = getPostsWithDetails('SELECT * FROM posts WHERE id = ?', [req.params.id], req.session.user?.id);
    if (posts.length === 0) return res.status(404).render('error', { user: req.session.user, error: 'Пост не найден', code: 404, url: req.url });
    res.render('index', { posts, user: req.session.user, title: posts[0].title });
});
app.post('/post/:id/react', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const type = req.body.type;
    const userId = req.session.user.id;
    const postId = req.params.id;
    const existing = db.prepare('SELECT type FROM reactions WHERE user_id = ? AND post_id = ?').get(userId, postId);
    if (existing) {
        if (existing.type === type) {
            db.prepare('DELETE FROM reactions WHERE user_id = ? AND post_id = ?').run(userId, postId);
            db.prepare(`UPDATE posts SET ${type}s = ${type}s - 1 WHERE id = ?`).run(postId);
        } else {
            db.prepare('UPDATE reactions SET type = ? WHERE user_id = ? AND post_id = ?').run(type, userId, postId);
            const opposite = type === 'like' ? 'dislike' : 'like';
            db.prepare(`UPDATE posts SET ${type}s = ${type}s + 1, ${opposite}s = ${opposite}s - 1 WHERE id = ?`).run(postId);
        }
    } else {
        db.prepare('INSERT INTO reactions (user_id, post_id, type) VALUES (?, ?, ?)').run(userId, postId, type);
        db.prepare(`UPDATE posts SET ${type}s = ${type}s + 1 WHERE id = ?`).run(postId);
    }
    res.redirect(req.get('referer') || '/');
});
app.post('/post/:id/comment', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    db.prepare('INSERT INTO comments (post_id, username, text) VALUES (?, ?, ?)').run(req.params.id, req.session.user.username, req.body.text);
    res.redirect(req.get('referer') || '/');
});
app.post('/post/:id/delete', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.user.id);
    if (post && (post.username === req.session.user.username || user?.is_admin === 1)) {
        db.prepare('DELETE FROM comments WHERE post_id = ?').run(req.params.id);
        db.prepare('DELETE FROM reactions WHERE post_id = ?').run(req.params.id);
        db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
    }
    res.redirect('/');
});
app.post('/post/:id/report', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const existing = db.prepare('SELECT * FROM post_reports WHERE post_id = ? AND reporter_id = ? AND status = "pending"').get(req.params.id, req.session.user.id);
    if (!existing) {
        db.prepare('INSERT INTO post_reports (post_id, reporter_id, reason) VALUES (?, ?, ?)').run(req.params.id, req.session.user.id, req.body.reason);
    }
    res.redirect(req.get('referer') || '/');
});
app.post('/user/:id/report', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const reportedUserId = req.params.id;
    const reporterId = req.session.user.id;
    if (reportedUserId == reporterId) return res.redirect(req.get('referer') || '/');
    const existing = db.prepare("SELECT * FROM reports WHERE reported_user_id = ? AND reporter_id = ? AND status = 'pending'").get(reportedUserId, reporterId);
    if (!existing) {
        db.prepare('INSERT INTO reports (reported_user_id, reporter_id, reason) VALUES (?, ?, ?)').run(reportedUserId, reporterId, req.body.reason);
        updateReputation(reportedUserId, -5);
    }
    res.redirect(req.get('referer') || '/');
});
app.get('/register', (req, res) => res.render('register', { user: req.session.user, error: null, title: 'Регистрация' }));
app.post('/register', (req, res) => {
    try {
        const hashed = bcrypt.hashSync(req.body.password, 10);
        db.prepare('INSERT INTO users (username, password, reputation) VALUES (?, ?, ?)').run(req.body.username, hashed, 0);
        res.redirect('/login');
    } catch(e) {
        res.render('register', { user: req.session.user, error: 'Ник уже занят', title: 'Регистрация' });
    }
});
app.get('/login', (req, res) => res.render('login', { user: req.session.user, error: null, title: 'Вход' }));
app.post('/login', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.body.username);
    if (user && bcrypt.compareSync(req.body.password, user.password)) {
        if (user.is_banned) return res.render('login', { user: req.session.user, error: `Забанен: ${user.ban_reason}`, title: 'Вход' });
        req.session.user = { id: user.id, username: user.username, avatar: user.avatar, is_admin: user.is_admin, is_verified: user.is_verified, reputation: user.reputation };
        res.redirect('/');
    } else {
        res.render('login', { user: req.session.user, error: 'Неверные данные', title: 'Вход' });
    }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.get('/create', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('create', { user: req.session.user, title: 'Создать пост' });
});
app.post('/create', upload.single('media'), (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const media = req.file ? req.file.filename : null;
    db.prepare('INSERT INTO posts (title, description, image, username) VALUES (?, ?, ?, ?)').run(req.body.title, req.body.description, media, req.session.user.username);
    res.redirect('/');
});
app.get('/settings', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    req.session.user = { ...req.session.user, ...user };
    res.render('settings', { user: req.session.user, error: null, success: null, title: 'Настройки' });
});
app.post('/settings/avatar', upload.single('avatar'), (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const avatar = req.file ? req.file.filename : 'default.png';
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.session.user.id);
    req.session.user.avatar = avatar;
    res.redirect('/settings');
});
app.post('/settings/username', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    try {
        db.prepare('UPDATE users SET username = ? WHERE id = ?').run(req.body.username, req.session.user.id);
        req.session.user.username = req.body.username;
        res.redirect('/settings');
    } catch(e) {
        res.render('settings', { user: req.session.user, error: 'Ник занят', success: null, title: 'Настройки' });
    }
});
app.post('/settings/password', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { oldPassword, newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword) return res.render('settings', { user: req.session.user, error: 'Новые пароли не совпадают', success: null, title: 'Настройки' });
    const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.session.user.id);
    if (bcrypt.compareSync(oldPassword, user.password)) {
        db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), req.session.user.id);
        res.render('settings', { user: req.session.user, error: null, success: 'Пароль изменён', title: 'Настройки' });
    } else {
        res.render('settings', { user: req.session.user, error: 'Неверный текущий пароль', success: null, title: 'Настройки' });
    }
});
app.get('/messages', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const conversationsRaw = db.prepare(`SELECT DISTINCT CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END as other_user_id FROM messages WHERE from_user_id = ? OR to_user_id = ?`).all(req.session.user.id, req.session.user.id, req.session.user.id);
    const conversations = [];
    for (const conv of conversationsRaw) {
        const otherUser = db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(conv.other_user_id);
        if (otherUser) {
            const lastMessage = db.prepare(`SELECT message, created_at FROM messages WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?) ORDER BY created_at DESC LIMIT 1`).get(req.session.user.id, otherUser.id, otherUser.id, req.session.user.id);
            const unread = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE to_user_id = ? AND from_user_id = ? AND is_read = 0`).get(req.session.user.id, otherUser.id);
            conversations.push({ other_user_id: otherUser.id, username: otherUser.username, avatar: otherUser.avatar, last_message: lastMessage ? lastMessage.message : null, unread: unread ? unread.count : 0 });
        }
    }
    res.render('messages', { user: req.session.user, conversations, title: 'Сообщения' });
});
app.get('/messages/chat/:userId', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const otherUser = db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(req.params.userId);
    if (!otherUser) return res.redirect('/messages');
    db.prepare('UPDATE messages SET is_read = 1 WHERE from_user_id = ? AND to_user_id = ?').run(otherUser.id, req.session.user.id);
    const messages = db.prepare(`SELECT * FROM messages WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?) ORDER BY created_at ASC`).all(req.session.user.id, otherUser.id, otherUser.id, req.session.user.id);
    res.render('chat', { user: req.session.user, otherUser, messages, title: `Чат с ${otherUser.username}` });
});
app.post('/messages/send/:userId', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.body.message && req.body.message.trim()) {
        db.prepare('INSERT INTO messages (from_user_id, to_user_id, message) VALUES (?, ?, ?)').run(req.session.user.id, req.params.userId, req.body.message.trim());
    }
    res.redirect(`/messages/chat/${req.params.userId}`);
});
app.get('/admin', (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/');
    const stats = {
        totalUsers: db.prepare('SELECT COUNT(*) as count FROM users').get().count,
        totalPosts: db.prepare('SELECT COUNT(*) as count FROM posts').get().count,
        totalComments: db.prepare('SELECT COUNT(*) as count FROM comments').get().count,
        totalReports: db.prepare("SELECT COUNT(*) as count FROM reports WHERE status = 'pending'").get().count,
        totalMessages: db.prepare('SELECT COUNT(*) as count FROM messages').get().count
    };
    const allUsers = db.prepare('SELECT * FROM users ORDER BY reputation DESC').all();
    const allPosts = db.prepare('SELECT * FROM posts ORDER BY created_at DESC LIMIT 20').all();
    const pendingReports = db.prepare(`
        SELECT r.*, ru.username as reported_username, rep.username as reporter_username
        FROM reports r JOIN users ru ON r.reported_user_id = ru.id JOIN users rep ON r.reporter_id = rep.id
        WHERE r.status = 'pending' ORDER BY r.created_at DESC
    `).all();
    res.render('admin', { user: req.session.user, stats, allUsers, allPosts, pendingReports, title: 'Админ-панель' });
});
app.post('/admin/user/:id/verify', (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    const u = db.prepare('SELECT is_verified FROM users WHERE id = ?').get(req.params.id);
    if (u) {
        const newStatus = u.is_verified ? 0 : 1;
        db.prepare('UPDATE users SET is_verified = ? WHERE id = ?').run(newStatus, req.params.id);
        if (newStatus) updateReputation(req.params.id, 20);
    }
    res.redirect('/admin');
});
app.post('/admin/user/:id/ban', (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    db.prepare('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?').run(req.body.reason || 'Нарушение', req.params.id);
    res.redirect('/admin');
});
app.post('/admin/user/:id/unban', (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    db.prepare('UPDATE users SET is_banned = 0, ban_reason = "" WHERE id = ?').run(req.params.id);
    res.redirect('/admin');
});
app.post('/admin/user/:id/makeadmin', (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(req.params.id);
    res.redirect('/admin');
});
app.post('/admin/user/:id/removeadmin', (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(req.params.id);
    res.redirect('/admin');
});
app.post('/admin/user/:id/addreputation', (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    updateReputation(req.params.id, parseInt(req.body.amount) || 0);
    res.redirect('/admin');
});
app.post('/admin/post/:id/delete', (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    db.prepare('DELETE FROM comments WHERE post_id = ?').run(req.params.id);
    db.prepare('DELETE FROM reactions WHERE post_id = ?').run(req.params.id);
    db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
    res.redirect('/admin');
});
app.post('/admin/report/:id/resolve', (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    db.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?").run(req.params.id);
    res.redirect('/admin');
});
app.use((req, res) => {
    res.status(404).render('error', { user: req.session.user, error: 'Страница не найдена', code: 404, url: req.url });
});
app.listen(3000, () => console.log('Сервер запущен: http://localhost:3000'));