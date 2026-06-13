const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// Подключение к PostgreSQL (Railway даст переменную DATABASE_URL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'cesium-gdps-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// ========== СОЗДАНИЕ ТАБЛИЦ ==========
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            password TEXT,
            avatar TEXT DEFAULT 'default.png',
            is_admin INTEGER DEFAULT 0,
            is_verified INTEGER DEFAULT 0,
            is_banned INTEGER DEFAULT 0,
            ban_reason TEXT DEFAULT '',
            reputation INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS posts (
            id SERIAL PRIMARY KEY,
            title TEXT,
            description TEXT,
            image TEXT,
            username TEXT,
            likes INTEGER DEFAULT 0,
            dislikes INTEGER DEFAULT 0,
            views INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS comments (
            id SERIAL PRIMARY KEY,
            post_id INTEGER,
            username TEXT,
            text TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS reactions (
            user_id INTEGER,
            post_id INTEGER,
            type TEXT CHECK(type IN ('like', 'dislike')),
            PRIMARY KEY (user_id, post_id)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            from_user_id INTEGER,
            to_user_id INTEGER,
            message TEXT,
            is_read INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Создаём админа NICEPEEK если нет
    const adminCheck = await pool.query('SELECT * FROM users WHERE username = $1', ['NICEPEEK']);
    if (adminCheck.rows.length === 0) {
        const hashedPassword = bcrypt.hashSync('nicepeek123', 10);
        await pool.query(
            'INSERT INTO users (username, password, is_admin, is_verified, reputation) VALUES ($1, $2, $3, $4, $5)',
            ['NICEPEEK', hashedPassword, 1, 1, 100]
        );
        console.log('Администратор NICEPEEK создан');
    }
    console.log('База данных готова');
}
initDB();

// ========== НАСТРОЙКА ЗАГРУЗКИ ФАЙЛОВ ==========
const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
async function getAuthorInfo(username) {
    const result = await pool.query('SELECT username, avatar, is_verified, is_banned, reputation FROM users WHERE username = $1', [username]);
    return result.rows[0] || { username, avatar: 'default.png', is_verified: 0, is_banned: 0, reputation: 0 };
}

async function getUserReaction(userId, postId) {
    if (!userId) return null;
    const result = await pool.query('SELECT type FROM reactions WHERE user_id = $1 AND post_id = $2', [userId, postId]);
    return result.rows[0] ? result.rows[0].type : null;
}

async function getPostsWithDetails(query, params = [], userId = null) {
    const posts = await pool.query(query, params);
    for (const post of posts.rows) {
        const comments = await pool.query('SELECT * FROM comments WHERE post_id = $1 ORDER BY created_at DESC', [post.id]);
        post.comments = comments.rows;
        post.author = await getAuthorInfo(post.username);
        if (userId) {
            post.userReaction = await getUserReaction(userId, post.id);
        }
    }
    return posts.rows;
}

async function incrementViews(postId) {
    await pool.query('UPDATE posts SET views = views + 1 WHERE id = $1', [postId]);
}

// ========== МАРШРУТЫ ==========
app.get('/', async (req, res) => {
    const posts = await getPostsWithDetails('SELECT * FROM posts ORDER BY created_at DESC', [], req.session.user?.id);
    const stats = {
        totalUsers: (await pool.query('SELECT COUNT(*) as count FROM users')).rows[0].count,
        totalPosts: (await pool.query('SELECT COUNT(*) as count FROM posts')).rows[0].count,
        totalComments: (await pool.query('SELECT COUNT(*) as count FROM comments')).rows[0].count
    };
    const topUsers = (await pool.query('SELECT username, reputation FROM users ORDER BY reputation DESC LIMIT 5')).rows;
    res.render('index', { posts, user: req.session.user, title: 'Лента', stats, topUsers });
});

app.get('/popular', async (req, res) => {
    const posts = await getPostsWithDetails('SELECT * FROM posts ORDER BY likes DESC, created_at DESC LIMIT 50', [], req.session.user?.id);
    const stats = {
        totalUsers: (await pool.query('SELECT COUNT(*) as count FROM users')).rows[0].count,
        totalPosts: (await pool.query('SELECT COUNT(*) as count FROM posts')).rows[0].count,
        totalComments: (await pool.query('SELECT COUNT(*) as count FROM comments')).rows[0].count
    };
    const topUsers = (await pool.query('SELECT username, reputation FROM users ORDER BY reputation DESC LIMIT 5')).rows;
    res.render('index', { posts, user: req.session.user, title: 'Популярное', stats, topUsers });
});

app.get('/search', async (req, res) => {
    const q = req.query.q || '';
    const posts = await getPostsWithDetails(
        'SELECT * FROM posts WHERE title ILIKE $1 OR description ILIKE $1 OR username ILIKE $1 ORDER BY created_at DESC',
        [`%${q}%`],
        req.session.user?.id
    );
    res.render('index', { posts, user: req.session.user, title: `Поиск: ${q}` });
});

app.get('/user/:username', async (req, res) => {
    const profileUser = (await pool.query('SELECT * FROM users WHERE username = $1', [req.params.username])).rows[0];
    if (!profileUser) return res.status(404).render('error', { user: req.session.user, error: 'Пользователь не найден', code: 404, url: req.url });
    const posts = await getPostsWithDetails('SELECT * FROM posts WHERE username = $1 ORDER BY created_at DESC', [req.params.username], req.session.user?.id);
    res.render('profile', { posts, user: req.session.user, profileUser, title: `Профиль ${req.params.username}` });
});

app.get('/post/:id', async (req, res) => {
    await incrementViews(req.params.id);
    const posts = await getPostsWithDetails('SELECT * FROM posts WHERE id = $1', [req.params.id], req.session.user?.id);
    if (posts.length === 0) return res.status(404).render('error', { user: req.session.user, error: 'Пост не найден', code: 404, url: req.url });
    res.render('index', { posts, user: req.session.user, title: posts[0].title });
});

app.post('/post/:id/react', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const type = req.body.type;
    const userId = req.session.user.id;
    const postId = req.params.id;
    const existing = (await pool.query('SELECT type FROM reactions WHERE user_id = $1 AND post_id = $2', [userId, postId])).rows[0];
    
    if (existing) {
        if (existing.type === type) {
            await pool.query('DELETE FROM reactions WHERE user_id = $1 AND post_id = $2', [userId, postId]);
            await pool.query(`UPDATE posts SET ${type}s = ${type}s - 1 WHERE id = $1`, [postId]);
        } else {
            await pool.query('UPDATE reactions SET type = $1 WHERE user_id = $2 AND post_id = $3', [type, userId, postId]);
            const opposite = type === 'like' ? 'dislike' : 'like';
            await pool.query(`UPDATE posts SET ${type}s = ${type}s + 1, ${opposite}s = ${opposite}s - 1 WHERE id = $1`, [postId]);
        }
    } else {
        await pool.query('INSERT INTO reactions (user_id, post_id, type) VALUES ($1, $2, $3)', [userId, postId, type]);
        await pool.query(`UPDATE posts SET ${type}s = ${type}s + 1 WHERE id = $1`, [postId]);
    }
    res.redirect(req.get('referer') || '/');
});

app.post('/post/:id/comment', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    await pool.query('INSERT INTO comments (post_id, username, text) VALUES ($1, $2, $3)', [req.params.id, req.session.user.username, req.body.text]);
    res.redirect(req.get('referer') || '/');
});

app.post('/post/:id/delete', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const post = (await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id])).rows[0];
    const user = (await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.session.user.id])).rows[0];
    if (post && (post.username === req.session.user.username || user?.is_admin === 1)) {
        await pool.query('DELETE FROM comments WHERE post_id = $1', [req.params.id]);
        await pool.query('DELETE FROM reactions WHERE post_id = $1', [req.params.id]);
        await pool.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    }
    res.redirect('/');
});

app.get('/register', (req, res) => res.render('register', { user: req.session.user, error: null, title: 'Регистрация' }));
app.post('/register', async (req, res) => {
    try {
        const hashed = bcrypt.hashSync(req.body.password, 10);
        await pool.query('INSERT INTO users (username, password, reputation) VALUES ($1, $2, $3)', [req.body.username, hashed, 0]);
        res.redirect('/login');
    } catch(e) {
        res.render('register', { user: req.session.user, error: 'Ник уже занят', title: 'Регистрация' });
    }
});

app.get('/login', (req, res) => res.render('login', { user: req.session.user, error: null, title: 'Вход' }));
app.post('/login', async (req, res) => {
    const user = (await pool.query('SELECT * FROM users WHERE username = $1', [req.body.username])).rows[0];
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

app.post('/create', upload.single('media'), async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const media = req.file ? req.file.filename : null;
    await pool.query('INSERT INTO posts (title, description, image, username) VALUES ($1, $2, $3, $4)', [req.body.title, req.body.description, media, req.session.user.username]);
    res.redirect('/');
});

app.get('/settings', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id])).rows[0];
    req.session.user = { ...req.session.user, ...user };
    res.render('settings', { user: req.session.user, error: null, success: null, title: 'Настройки' });
});

app.post('/settings/avatar', upload.single('avatar'), async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const avatar = req.file ? req.file.filename : 'default.png';
    await pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatar, req.session.user.id]);
    req.session.user.avatar = avatar;
    res.redirect('/settings');
});

app.post('/settings/username', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    try {
        await pool.query('UPDATE users SET username = $1 WHERE id = $2', [req.body.username, req.session.user.id]);
        req.session.user.username = req.body.username;
        res.redirect('/settings');
    } catch(e) {
        res.render('settings', { user: req.session.user, error: 'Ник занят', success: null, title: 'Настройки' });
    }
});

app.post('/settings/password', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { oldPassword, newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword) return res.render('settings', { user: req.session.user, error: 'Новые пароли не совпадают', success: null, title: 'Настройки' });
    const user = (await pool.query('SELECT password FROM users WHERE id = $1', [req.session.user.id])).rows[0];
    if (bcrypt.compareSync(oldPassword, user.password)) {
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [bcrypt.hashSync(newPassword, 10), req.session.user.id]);
        res.render('settings', { user: req.session.user, error: null, success: 'Пароль изменён', title: 'Настройки' });
    } else {
        res.render('settings', { user: req.session.user, error: 'Неверный текущий пароль', success: null, title: 'Настройки' });
    }
});

app.get('/messages', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const conversationsRaw = await pool.query(`
        SELECT DISTINCT 
            CASE 
                WHEN from_user_id = $1 THEN to_user_id
                ELSE from_user_id
            END as other_user_id
        FROM messages 
        WHERE from_user_id = $1 OR to_user_id = $1
    `, [req.session.user.id]);
    
    const conversations = [];
    for (const conv of conversationsRaw.rows) {
        const otherUser = (await pool.query('SELECT id, username, avatar FROM users WHERE id = $1', [conv.other_user_id])).rows[0];
        if (otherUser) {
            const lastMessage = (await pool.query(`
                SELECT message, created_at FROM messages 
                WHERE (from_user_id = $1 AND to_user_id = $2) 
                   OR (from_user_id = $2 AND to_user_id = $1)
                ORDER BY created_at DESC LIMIT 1
            `, [req.session.user.id, otherUser.id])).rows[0];
            const unread = (await pool.query(`
                SELECT COUNT(*) as count FROM messages 
                WHERE to_user_id = $1 AND from_user_id = $2 AND is_read = 0
            `, [req.session.user.id, otherUser.id])).rows[0];
            conversations.push({
                other_user_id: otherUser.id,
                username: otherUser.username,
                avatar: otherUser.avatar,
                last_message: lastMessage ? lastMessage.message : null,
                unread: unread ? parseInt(unread.count) : 0
            });
        }
    }
    res.render('messages', { user: req.session.user, conversations, title: 'Сообщения' });
});

app.get('/messages/chat/:userId', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const otherUser = (await pool.query('SELECT id, username, avatar FROM users WHERE id = $1', [req.params.userId])).rows[0];
    if (!otherUser) return res.redirect('/messages');
    await pool.query('UPDATE messages SET is_read = 1 WHERE from_user_id = $1 AND to_user_id = $2', [otherUser.id, req.session.user.id]);
    const messages = (await pool.query(`
        SELECT * FROM messages 
        WHERE (from_user_id = $1 AND to_user_id = $2) 
           OR (from_user_id = $2 AND to_user_id = $1)
        ORDER BY created_at ASC
    `, [req.session.user.id, otherUser.id])).rows;
    res.render('chat', { user: req.session.user, otherUser, messages, title: `Чат с ${otherUser.username}` });
});

app.post('/messages/send/:userId', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.body.message && req.body.message.trim()) {
        await pool.query('INSERT INTO messages (from_user_id, to_user_id, message) VALUES ($1, $2, $3)', [req.session.user.id, req.params.userId, req.body.message.trim()]);
    }
    res.redirect(`/messages/chat/${req.params.userId}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));