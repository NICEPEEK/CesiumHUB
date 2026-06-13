const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const svgCaptcha = require('svg-captcha');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Supabase клиент (без realtime, он нам не нужен)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'cesium-gdps-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// ========== ФУНКЦИЯ ДЛЯ РЕПУТАЦИИ ==========
function getReputationLevel(reputation) {
    if (reputation >= 100) return { class: 'reputation-positive', text: 'Легенда' };
    if (reputation >= 50) return { class: 'reputation-positive', text: 'Звезда' };
    if (reputation >= 20) return { class: 'reputation-positive', text: 'Хорошая' };
    if (reputation >= 0) return { class: 'reputation-neutral', text: 'Нейтральная' };
    if (reputation >= -20) return { class: 'reputation-negative', text: 'Сомнительная' };
    return { class: 'reputation-negative', text: 'Плохая' };
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
async function getAuthorInfo(username) {
    const { data } = await supabase
        .from('users')
        .select('username, avatar, is_verified, is_banned, reputation')
        .eq('username', username)
        .single();
    return data || { username, avatar: 'default.png', is_verified: 0, is_banned: 0, reputation: 0 };
}

async function getUserReaction(userId, postId) {
    if (!userId) return null;
    const { data } = await supabase
        .from('reactions')
        .select('type')
        .eq('user_id', userId)
        .eq('post_id', postId)
        .single();
    return data ? data.type : null;
}

async function getPostsWithDetails(query, params = [], userId = null) {
    let posts = [];
    
    if (query.includes('ORDER BY created_at DESC') && !query.includes('WHERE')) {
        const { data } = await supabase
            .from('posts')
            .select('*')
            .order('created_at', { ascending: false });
        posts = data || [];
    } else if (query.includes('WHERE username =')) {
        const { data } = await supabase
            .from('posts')
            .select('*')
            .eq('username', params[0])
            .order('created_at', { ascending: false });
        posts = data || [];
    } else if (query.includes('WHERE id =')) {
        const { data } = await supabase
            .from('posts')
            .select('*')
            .eq('id', parseInt(params[0]))
            .single();
        posts = data ? [data] : [];
    } else {
        const { data } = await supabase
            .from('posts')
            .select('*')
            .order('created_at', { ascending: false });
        posts = data || [];
    }
    
    for (const post of posts) {
        const { data: comments } = await supabase
            .from('comments')
            .select('*')
            .eq('post_id', post.id)
            .order('created_at', { ascending: false });
        post.comments = comments || [];
        post.author = await getAuthorInfo(post.username);
        if (userId) {
            post.userReaction = await getUserReaction(userId, post.id);
        }
    }
    return posts;
}

async function incrementViews(postId) {
    const { data: post } = await supabase
        .from('posts')
        .select('views')
        .eq('id', postId)
        .single();
    if (post) {
        await supabase
            .from('posts')
            .update({ views: (post.views || 0) + 1 })
            .eq('id', postId);
    }
}

async function getActiveUsersCount() {
    const { count } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('is_banned', 0);
    return count || 0;
}

// ========== НАСТРОЙКА ЗАГРУЗКИ ==========
const tempDir = './temp';
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tempDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// ========== КАПЧА ==========
app.get('/captcha', (req, res) => {
    const captcha = svgCaptcha.create({
        size: 5,
        noise: 2,
        color: true,
        background: '#1a1a2e',
        width: 150,
        height: 50
    });
    req.session.captchaText = captcha.text;
    res.type('svg');
    res.send(captcha.data);
});

// ========== СОЗДАНИЕ ТАБЛИЦ (через REST API, без RPC) ==========
async function initTables() {
    // Проверяем существование таблицы users
    const { error: usersError } = await supabase.from('users').select('id').limit(1);
    if (usersError && usersError.message.includes('relation') && usersError.message.includes('does not exist')) {
        console.log('Таблицы будут созданы через SQL в Supabase Dashboard');
        console.log('Пожалуйста, выполните следующий SQL в Supabase SQL Editor:');
        console.log(`
CREATE TABLE users (
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
);

CREATE TABLE posts (
    id SERIAL PRIMARY KEY,
    title TEXT,
    description TEXT,
    image TEXT,
    username TEXT,
    likes INTEGER DEFAULT 0,
    dislikes INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE comments (
    id SERIAL PRIMARY KEY,
    post_id INTEGER,
    username TEXT,
    text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reactions (
    user_id INTEGER,
    post_id INTEGER,
    type TEXT CHECK(type IN ('like', 'dislike')),
    PRIMARY KEY (user_id, post_id)
);

CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    from_user_id INTEGER,
    to_user_id INTEGER,
    message TEXT,
    is_read INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ip_limits (
    ip TEXT PRIMARY KEY,
    account_count INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
        `);
    }
    
    // Создаём админа NICEPEEK
    const { data: adminCheck } = await supabase
        .from('users')
        .select('*')
        .eq('username', 'NICEPEEK')
        .single();
    
    if (!adminCheck) {
        const hashedPassword = bcrypt.hashSync('nicepeek123', 10);
        await supabase
            .from('users')
            .insert({ username: 'NICEPEEK', password: hashedPassword, is_admin: 1, is_verified: 1, reputation: 100 });
        console.log('Администратор NICEPEEK создан');
    }
    
    console.log('База данных готова');
}

// Запускаем инициализацию
initTables();

// ========== МАРШРУТЫ ==========
app.get('/', async (req, res) => {
    const posts = await getPostsWithDetails('SELECT * FROM posts ORDER BY created_at DESC', [], req.session.user?.id);
    const stats = {
        totalUsers: await getActiveUsersCount(),
        totalPosts: (await supabase.from('posts').select('*', { count: 'exact', head: true })).count || 0,
        totalComments: (await supabase.from('comments').select('*', { count: 'exact', head: true })).count || 0
    };
    res.render('index', { posts, user: req.session.user, title: 'Лента', stats });
});

app.get('/popular', async (req, res) => {
    const { data: posts } = await supabase
        .from('posts')
        .select('*')
        .order('likes', { ascending: false })
        .limit(50);
    
    for (const post of posts || []) {
        const { data: comments } = await supabase
            .from('comments')
            .select('*')
            .eq('post_id', post.id)
            .order('created_at', { ascending: false });
        post.comments = comments || [];
        post.author = await getAuthorInfo(post.username);
        if (req.session.user?.id) {
            post.userReaction = await getUserReaction(req.session.user.id, post.id);
        }
    }
    
    const stats = {
        totalUsers: await getActiveUsersCount(),
        totalPosts: (await supabase.from('posts').select('*', { count: 'exact', head: true })).count || 0,
        totalComments: (await supabase.from('comments').select('*', { count: 'exact', head: true })).count || 0
    };
    res.render('index', { posts: posts || [], user: req.session.user, title: 'Популярное', stats });
});

app.get('/search', async (req, res) => {
    const q = req.query.q || '';
    const { data: posts } = await supabase
        .from('posts')
        .select('*')
        .or(`title.ilike.%${q}%,description.ilike.%${q}%,username.ilike.%${q}%`)
        .order('created_at', { ascending: false });
    
    for (const post of posts || []) {
        const { data: comments } = await supabase
            .from('comments')
            .select('*')
            .eq('post_id', post.id);
        post.comments = comments || [];
        post.author = await getAuthorInfo(post.username);
        if (req.session.user?.id) {
            post.userReaction = await getUserReaction(req.session.user.id, post.id);
        }
    }
    
    const stats = {
        totalUsers: await getActiveUsersCount(),
        totalPosts: (await supabase.from('posts').select('*', { count: 'exact', head: true })).count || 0,
        totalComments: (await supabase.from('comments').select('*', { count: 'exact', head: true })).count || 0
    };
    res.render('index', { posts: posts || [], user: req.session.user, title: `Поиск: ${q}`, stats });
});

app.get('/user/:username', async (req, res) => {
    const { data: profileUser } = await supabase
        .from('users')
        .select('*')
        .eq('username', req.params.username)
        .single();
    
    if (!profileUser) return res.status(404).render('error', { user: req.session.user, error: 'Пользователь не найден', code: 404, url: req.url });
    
    const { data: posts } = await supabase
        .from('posts')
        .select('*')
        .eq('username', req.params.username)
        .order('created_at', { ascending: false });
    
    for (const post of posts || []) {
        const { data: comments } = await supabase
            .from('comments')
            .select('*')
            .eq('post_id', post.id);
        post.comments = comments || [];
        post.author = await getAuthorInfo(post.username);
    }
    
    const reputationLevel = getReputationLevel(profileUser.reputation);
    res.render('profile', { posts: posts || [], user: req.session.user, profileUser, reputationLevel, title: `Профиль ${req.params.username}` });
});

app.get('/post/:id', async (req, res) => {
    await incrementViews(req.params.id);
    
    const { data: post } = await supabase
        .from('posts')
        .select('*')
        .eq('id', req.params.id)
        .single();
    
    if (!post) return res.status(404).render('error', { user: req.session.user, error: 'Пост не найден', code: 404, url: req.url });
    
    const { data: comments } = await supabase
        .from('comments')
        .select('*')
        .eq('post_id', req.params.id)
        .order('created_at', { ascending: false });
    post.comments = comments || [];
    post.author = await getAuthorInfo(post.username);
    if (req.session.user?.id) {
        post.userReaction = await getUserReaction(req.session.user.id, post.id);
    }
    
    const stats = {
        totalUsers: await getActiveUsersCount(),
        totalPosts: (await supabase.from('posts').select('*', { count: 'exact', head: true })).count || 0,
        totalComments: (await supabase.from('comments').select('*', { count: 'exact', head: true })).count || 0
    };
    res.render('post', { post, user: req.session.user, stats, title: post.title });
});

app.post('/post/:id/react', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const type = req.body.type;
    const userId = req.session.user.id;
    const postId = req.params.id;
    
    const { data: existing } = await supabase
        .from('reactions')
        .select('type')
        .eq('user_id', userId)
        .eq('post_id', postId)
        .single();
    
    if (existing) {
        if (existing.type === type) {
            await supabase
                .from('reactions')
                .delete()
                .eq('user_id', userId)
                .eq('post_id', postId);
            
            const { data: post } = await supabase
                .from('posts')
                .select(`${type}s`)
                .eq('id', postId)
                .single();
            if (post) {
                await supabase
                    .from('posts')
                    .update({ [`${type}s`]: Math.max(0, (post[`${type}s`] || 0) - 1) })
                    .eq('id', postId);
            }
        } else {
            await supabase
                .from('reactions')
                .update({ type })
                .eq('user_id', userId)
                .eq('post_id', postId);
            
            const opposite = type === 'like' ? 'dislike' : 'like';
            const { data: post } = await supabase
                .from('posts')
                .select(`${type}s, ${opposite}s`)
                .eq('id', postId)
                .single();
            if (post) {
                await supabase
                    .from('posts')
                    .update({ 
                        [`${type}s`]: (post[`${type}s`] || 0) + 1,
                        [`${opposite}s`]: Math.max(0, (post[`${opposite}s`] || 0) - 1)
                    })
                    .eq('id', postId);
            }
        }
    } else {
        await supabase
            .from('reactions')
            .insert({ user_id: userId, post_id: postId, type });
        
        const { data: post } = await supabase
            .from('posts')
            .select(`${type}s`)
            .eq('id', postId)
            .single();
        if (post) {
            await supabase
                .from('posts')
                .update({ [`${type}s`]: (post[`${type}s`] || 0) + 1 })
                .eq('id', postId);
        }
    }
    
    res.redirect(req.get('referer') || '/');
});

app.post('/post/:id/comment', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    await supabase
        .from('comments')
        .insert({ post_id: req.params.id, username: req.session.user.username, text: req.body.text });
    res.redirect(`/post/${req.params.id}`);
});

app.post('/post/:id/delete', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const { data: post } = await supabase
        .from('posts')
        .select('*')
        .eq('id', req.params.id)
        .single();
    
    if (post && (post.username === req.session.user.username || req.session.user.is_admin === 1)) {
        await supabase.from('comments').delete().eq('post_id', req.params.id);
        await supabase.from('reactions').delete().eq('post_id', req.params.id);
        await supabase.from('posts').delete().eq('id', req.params.id);
    }
    res.redirect('/');
});

app.get('/register', (req, res) => res.render('register', { user: req.session.user, error: null, title: 'Регистрация' }));

app.post('/register', async (req, res) => {
    try {
        if (!req.body.captcha || req.body.captcha.toLowerCase() !== req.session.captchaText?.toLowerCase()) {
            return res.render('register', { user: req.session.user, error: 'Неверный код с картинки', title: 'Регистрация' });
        }
        
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const { data: ipCheck } = await supabase
            .from('ip_limits')
            .select('account_count')
            .eq('ip', userIp)
            .single();
        
        if (ipCheck && ipCheck.account_count >= 2) {
            return res.render('register', { user: req.session.user, error: 'С одного IP нельзя зарегистрировать более 2 аккаунтов', title: 'Регистрация' });
        }
        
        const hashed = bcrypt.hashSync(req.body.password, 10);
        await supabase
            .from('users')
            .insert({ username: req.body.username, password: hashed, reputation: 0 });
        
        if (ipCheck) {
            await supabase
                .from('ip_limits')
                .update({ account_count: ipCheck.account_count + 1 })
                .eq('ip', userIp);
        } else {
            await supabase
                .from('ip_limits')
                .insert({ ip: userIp, account_count: 1 });
        }
        
        req.session.captchaText = null;
        res.redirect('/login');
    } catch(e) {
        res.render('register', { user: req.session.user, error: 'Ник уже занят', title: 'Регистрация' });
    }
});

app.get('/login', (req, res) => res.render('login', { user: req.session.user, error: null, title: 'Вход' }));

app.post('/login', async (req, res) => {
    const { data: user } = await supabase
        .from('users')
        .select('*')
        .eq('username', req.body.username)
        .single();
    
    if (user && bcrypt.compareSync(req.body.password, user.password)) {
        if (user.is_banned) return res.render('login', { user: req.session.user, error: `Забанен: ${user.ban_reason}`, title: 'Вход' });
        req.session.user = { 
            id: user.id, 
            username: user.username, 
            avatar: user.avatar, 
            is_admin: user.is_admin, 
            is_verified: user.is_verified, 
            reputation: user.reputation 
        };
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
    
    let imageUrl = null;
    if (req.file) {
        const fileBuffer = fs.readFileSync(req.file.path);
        const fileName = `${Date.now()}${path.extname(req.file.originalname)}`;
        
        const { error } = await supabase.storage
            .from('uploads')
            .upload(`posts/${fileName}`, fileBuffer, { contentType: req.file.mimetype });
        
        if (!error) {
            const { data: { publicUrl } } = supabase.storage
                .from('uploads')
                .getPublicUrl(`posts/${fileName}`);
            imageUrl = publicUrl;
        }
        
        fs.unlinkSync(req.file.path);
    }
    
    await supabase
        .from('posts')
        .insert({ title: req.body.title, description: req.body.description, image: imageUrl, username: req.session.user.username });
    
    res.redirect('/');
});

app.get('/settings', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { data: user } = await supabase
        .from('users')
        .select('*')
        .eq('id', req.session.user.id)
        .single();
    req.session.user = { ...req.session.user, ...user };
    res.render('settings', { user: req.session.user, error: null, success: null, title: 'Настройки' });
});

app.post('/settings/avatar', upload.single('avatar'), async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    let avatarUrl = 'default.png';
    if (req.file) {
        const fileBuffer = fs.readFileSync(req.file.path);
        const fileName = `avatars/${req.session.user.id}_${Date.now()}${path.extname(req.file.originalname)}`;
        
        const { error } = await supabase.storage
            .from('uploads')
            .upload(fileName, fileBuffer, { contentType: req.file.mimetype });
        
        if (!error) {
            const { data: { publicUrl } } = supabase.storage
                .from('uploads')
                .getPublicUrl(fileName);
            avatarUrl = publicUrl;
        }
        
        fs.unlinkSync(req.file.path);
    }
    
    await supabase
        .from('users')
        .update({ avatar: avatarUrl })
        .eq('id', req.session.user.id);
    req.session.user.avatar = avatarUrl;
    res.redirect('/settings');
});

app.post('/settings/username', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    try {
        await supabase
            .from('users')
            .update({ username: req.body.username })
            .eq('id', req.session.user.id);
        req.session.user.username = req.body.username;
        res.redirect('/settings');
    } catch(e) {
        res.render('settings', { user: req.session.user, error: 'Ник занят', success: null, title: 'Настройки' });
    }
});

app.post('/settings/password', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { oldPassword, newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword) {
        return res.render('settings', { user: req.session.user, error: 'Новые пароли не совпадают', success: null, title: 'Настройки' });
    }
    
    const { data: user } = await supabase
        .from('users')
        .select('password')
        .eq('id', req.session.user.id)
        .single();
    
    if (bcrypt.compareSync(oldPassword, user.password)) {
        const hashed = bcrypt.hashSync(newPassword, 10);
        await supabase
            .from('users')
            .update({ password: hashed })
            .eq('id', req.session.user.id);
        res.render('settings', { user: req.session.user, error: null, success: 'Пароль изменён', title: 'Настройки' });
    } else {
        res.render('settings', { user: req.session.user, error: 'Неверный текущий пароль', success: null, title: 'Настройки' });
    }
});

app.get('/messages', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const { data: messages } = await supabase
        .from('messages')
        .select('*')
        .or(`from_user_id.eq.${req.session.user.id},to_user_id.eq.${req.session.user.id}`);
    
    const userIds = new Set();
    (messages || []).forEach(msg => {
        if (msg.from_user_id !== req.session.user.id) userIds.add(msg.from_user_id);
        if (msg.to_user_id !== req.session.user.id) userIds.add(msg.to_user_id);
    });
    
    const conversations = [];
    for (const userId of userIds) {
        const { data: otherUser } = await supabase
            .from('users')
            .select('id, username, avatar')
            .eq('id', userId)
            .single();
        
        if (otherUser) {
            const { data: lastMsg } = await supabase
                .from('messages')
                .select('message, created_at')
                .or(`and(from_user_id.eq.${req.session.user.id},to_user_id.eq.${userId}),and(from_user_id.eq.${userId},to_user_id.eq.${req.session.user.id})`)
                .order('created_at', { ascending: false })
                .limit(1);
            
            const { count: unread } = await supabase
                .from('messages')
                .select('*', { count: 'exact', head: true })
                .eq('to_user_id', req.session.user.id)
                .eq('from_user_id', userId)
                .eq('is_read', 0);
            
            conversations.push({
                other_user_id: otherUser.id,
                username: otherUser.username,
                avatar: otherUser.avatar,
                last_message: lastMsg?.[0]?.message || null,
                unread: unread || 0
            });
        }
    }
    
    res.render('messages', { user: req.session.user, conversations, title: 'Сообщения' });
});

app.get('/messages/chat/:userId', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const { data: otherUser } = await supabase
        .from('users')
        .select('id, username, avatar')
        .eq('id', req.params.userId)
        .single();
    
    if (!otherUser) return res.redirect('/messages');
    
    await supabase
        .from('messages')
        .update({ is_read: 1 })
        .eq('from_user_id', otherUser.id)
        .eq('to_user_id', req.session.user.id);
    
    const { data: messages } = await supabase
        .from('messages')
        .select('*')
        .or(`and(from_user_id.eq.${req.session.user.id},to_user_id.eq.${otherUser.id}),and(from_user_id.eq.${otherUser.id},to_user_id.eq.${req.session.user.id})`)
        .order('created_at', { ascending: true });
    
    res.render('chat', { user: req.session.user, otherUser, messages: messages || [], title: `Чат с ${otherUser.username}` });
});

app.post('/messages/send/:userId', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.body.message && req.body.message.trim()) {
        await supabase
            .from('messages')
            .insert({ from_user_id: req.session.user.id, to_user_id: req.params.userId, message: req.body.message.trim() });
    }
    res.redirect(`/messages/chat/${req.params.userId}`);
});

// ========== АДМИН-ПАНЕЛЬ ==========
app.get('/admin', async (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/');
    
    const stats = {
        totalUsers: await getActiveUsersCount(),
        totalPosts: (await supabase.from('posts').select('*', { count: 'exact', head: true })).count || 0,
        totalComments: (await supabase.from('comments').select('*', { count: 'exact', head: true })).count || 0,
        totalMessages: (await supabase.from('messages').select('*', { count: 'exact', head: true })).count || 0
    };
    
    const { data: allUsers } = await supabase
        .from('users')
        .select('*')
        .order('reputation', { ascending: false });
    
    const { data: allPosts } = await supabase
        .from('posts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);
    
    res.render('admin', { user: req.session.user, stats, allUsers: allUsers || [], allPosts: allPosts || [], title: 'Админ-панель' });
});

app.post('/admin/user/:id/verify', async (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    
    const { data: user } = await supabase
        .from('users')
        .select('is_verified')
        .eq('id', req.params.id)
        .single();
    
    if (user) {
        const newStatus = user.is_verified === 1 ? 0 : 1;
        await supabase
            .from('users')
            .update({ is_verified: newStatus })
            .eq('id', req.params.id);
        if (newStatus === 1) {
            const { data: u } = await supabase
                .from('users')
                .select('reputation')
                .eq('id', req.params.id)
                .single();
            if (u) {
                await supabase
                    .from('users')
                    .update({ reputation: (u.reputation || 0) + 20 })
                    .eq('id', req.params.id);
            }
        }
    }
    res.redirect('/admin');
});

app.post('/admin/user/:id/ban', async (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    const reason = req.body.reason || 'Нарушение правил';
    await supabase
        .from('users')
        .update({ is_banned: 1, ban_reason: reason })
        .eq('id', req.params.id);
    res.redirect('/admin');
});

app.post('/admin/user/:id/unban', async (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    await supabase
        .from('users')
        .update({ is_banned: 0, ban_reason: '' })
        .eq('id', req.params.id);
    res.redirect('/admin');
});

app.post('/admin/user/:id/makeadmin', async (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    await supabase
        .from('users')
        .update({ is_admin: 1 })
        .eq('id', req.params.id);
    res.redirect('/admin');
});

app.post('/admin/user/:id/removeadmin', async (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    await supabase
        .from('users')
        .update({ is_admin: 0 })
        .eq('id', req.params.id);
    res.redirect('/admin');
});

app.post('/admin/user/:id/addreputation', async (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    const amount = parseInt(req.body.amount) || 0;
    const { data: user } = await supabase
        .from('users')
        .select('reputation')
        .eq('id', req.params.id)
        .single();
    if (user) {
        await supabase
            .from('users')
            .update({ reputation: (user.reputation || 0) + amount })
            .eq('id', req.params.id);
    }
    res.redirect('/admin');
});

app.post('/admin/post/:id/delete', async (req, res) => {
    if (!req.session.user || req.session.user.is_admin !== 1) return res.redirect('/admin');
    await supabase.from('comments').delete().eq('post_id', req.params.id);
    await supabase.from('reactions').delete().eq('post_id', req.params.id);
    await supabase.from('posts').delete().eq('id', req.params.id);
    res.redirect('/admin');
});

// ========== ОБРАБОТКА ОШИБОК ==========
app.use((req, res) => {
    res.status(404).render('error', { 
        user: req.session.user, 
        error: 'Страница не найдена', 
        code: 404, 
        url: req.url 
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен: http://localhost:${PORT}`));