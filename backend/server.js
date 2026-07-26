// ═══════════════════════════════════════════════════════════
// ENTERPRISE WMS — COMPLETE BACKEND SERVER
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// ─── CONFIG ───────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 5000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(path.join(UPLOAD_DIR, 'vehicles'))) fs.mkdirSync(path.join(UPLOAD_DIR, 'vehicles'), { recursive: true });
if (!fs.existsSync(path.join(UPLOAD_DIR, 'invoices'))) fs.mkdirSync(path.join(UPLOAD_DIR, 'invoices'), { recursive: true });
if (!fs.existsSync(path.join(UPLOAD_DIR, 'materials'))) fs.mkdirSync(path.join(UPLOAD_DIR, 'materials'), { recursive: true });
if (!fs.existsSync(path.join(UPLOAD_DIR, 'exports'))) fs.mkdirSync(path.join(UPLOAD_DIR, 'exports'), { recursive: true });

// ─── SUPABASE ────────────────────────────────────────────
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── MIDDLEWARE ──────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }
}));
app.use(compression());
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR)));

// Rate limiter
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Auth rate limiter (stricter)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many login attempts. Account may be locked.' }
});

// Multer config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let folder = 'vehicles';
        if (file.fieldname === 'invoice_file') folder = 'invoices';
        if (file.fieldname === 'material_image') folder = 'materials';
        if (file.fieldname === 'bulk_file') folder = 'exports';
        cb(null, path.join(UPLOAD_DIR, folder));
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${Date.now()}-${uuidv4()}${ext}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.xlsx', '.xls', '.csv'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Invalid file type'));
    }
});

// ─── HELPERS ─────────────────────────────────────────────
function sanitize(str) {
    if (!str) return '';
    return String(str).replace(/[<>\"'&;(){}]/g, '').trim();
}

function validatePhone(phone) {
    return /^[0-9]{10}$/.test(String(phone));
}

function generateToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role_name, roleId: user.role_id },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
}

async function hasPermission(userId, permissionCode) {
    const { data } = await supabase
        .from('users')
        .select('role_id, roles:role_id(role_permissions(permission_id, permissions(code)))')
        .eq('id', userId)
        .single();
    if (!data || !data.roles) return false;
    const perms = data.roles.role_permissions || [];
    return perms.some(rp => rp.permissions && rp.permissions.code === permissionCode);
}

async function logAudit(userId, module, action, tableName, recordId, oldValue, newValue, req) {
    const { data: num } = await supabase.rpc('get_audit_number');
    const actionNumber = num || ('AUD-' + Date.now());
    await supabase.from('audit_log').insert({
        action_number: actionNumber,
        module, action, table_name: tableName, record_id: recordId,
        old_value: oldValue, new_value: newValue,
        user_id: userId,
        ip_address: req ? (req.headers['x-forwarded-for'] || req.ip) : null,
        user_agent: req ? req.headers['user-agent'] : null
    });
    return actionNumber;
}

async function createNotification(userId, title, message, type, module, refId) {
    await supabase.from('notifications').insert({
        user_id: userId, title, message, type, module, reference_id: refId
    });
}

// Notify admins/supervisors/managers
async function notifyRoles(title, message, type, module, refId) {
    const { data: users } = await supabase
        .from('users')
        .select('id')
        .in('role_id', (await supabase.from('roles').select('id').in('name', ['Super Admin', 'Admin', 'Warehouse Manager', 'Supervisor'])).data.map(r => r.id))
        .eq('is_active', true);
    if (users && users.length) {
        const notifs = users.map(u => ({
            user_id: u.id, title, message, type, module, reference_id: refId
        }));
        await supabase.from('notifications').insert(notifs);
    }
}

// ─── AUTH MIDDLEWARE ─────────────────────────────────────
const authMiddleware = async (req, res, next) => {
    try {
        const header = req.headers.authorization;
        if (!header || !header.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }
        const token = header.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const { data: user } = await supabase
            .from('users')
            .select('id, username, email, full_name, phone, role_id, is_active, is_locked, force_password_change, last_login, roles(role_id, name, level)')
            .eq('id', decoded.id)
            .single();
        if (!user || !user.is_active || user.is_locked) {
            return res.status(401).json({ error: 'User inactive or locked' });
        }
        req.user = {
            id: user.id, username: user.username, email: user.email,
            full_name: user.full_name, phone: user.phone,
            role_id: user.role_id, role_name: user.roles ? user.roles.name : 'Viewer',
            role_level: user.roles ? user.roles.level : 0,
            force_password_change: user.force_password_change
        };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};

const requirePermission = (code) => async (req, res, next) => {
    const ok = await hasPermission(req.user.id, code);
    if (!ok) return res.status(403).json({ error: 'Permission denied' });
    next();
};

// ─── ERROR HANDLER ───────────────────────────────────────
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: 'File upload error: ' + err.message });
    }
    if (err.message === 'Invalid file type') {
        return res.status(400).json({ error: 'Invalid file type. Allowed: jpg, png, pdf, xlsx, csv' });
    }
    console.error('Server Error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ═══════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

        const { data: user, error } = await supabase
            .from('users')
            .select('id, username, email, full_name, password_hash, role_id, is_active, is_locked, failed_login_count, last_login, roles(name)')
            .eq('username', username)
            .single();

        if (error || !user) {
            await supabase.from('login_history').insert({
                ip_address: req.headers['x-forwarded-for'] || req.ip,
                user_agent: req.headers['user-agent'],
                status: 'failed', failure_reason: 'User not found'
            });
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (!user.is_active) return res.status(401).json({ error: 'Account deactivated' });
        if (user.is_locked) return res.status(401).json({ error: 'Account locked. Contact admin.' });

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            const newCount = (user.failed_login_count || 0) + 1;
            const maxFails = 5;
            const updates = { failed_login_count: newCount };
            if (newCount >= maxFails) {
                updates.is_locked = true;
                await supabase.from('login_history').insert({
                    user_id: user.id,
                    ip_address: req.headers['x-forwarded-for'] || req.ip,
                    user_agent: req.headers['user-agent'],
                    status: 'failed', failure_reason: 'Account locked after ' + maxFails + ' failed attempts'
                });
                await supabase.from('users').update(updates).eq('id', user.id);
                await notifyRoles('Account Locked', `User ${user.username} locked after ${maxFails} failed logins`, 'danger', 'auth', user.id);
                return res.status(401).json({ error: 'Account locked due to multiple failed attempts' });
            }
            await supabase.from('users').update(updates).eq('id', user.id);
            await supabase.from('login_history').insert({
                user_id: user.id,
                ip_address: req.headers['x-forwarded-for'] || req.ip,
                user_agent: req.headers['user-agent'],
                status: 'failed', failure_reason: 'Wrong password'
            });
            return res.status(401).json({ error: 'Invalid credentials', remaining: maxFails - newCount });
        }

        // Success
        await supabase.from('users').update({
            failed_login_count: 0, last_login: new Date().toISOString()
        }).eq('id', user.id);

        await supabase.from('login_history').insert({
            user_id: user.id,
            ip_address: req.headers['x-forwarded-for'] || req.ip,
            user_agent: req.headers['user-agent'],
            device_type: /mobile/i.test(req.headers['user-agent']) ? 'Mobile' : 'Desktop',
            status: 'success'
        });

        const token = generateToken({
            id: user.id, username: user.username,
            role_name: user.roles ? user.roles.name : 'Viewer',
            role_id: user.role_id
        });

        // Get permissions
        const { data: perms } = await supabase
            .from('role_permissions')
            .select('permissions(code, name, module)')
            .eq('role_id', user.role_id);

        const permissionList = (perms || []).map(p => p.permissions ? p.permissions.code : '');

        res.json({
            token,
            user: {
                id: user.id, username: user.username, email: user.email,
                full_name: user.full_name, role: user.roles ? user.roles.name : 'Viewer',
                role_id: user.role_id, last_login: user.last_login,
                force_password_change: user.force_password_change,
                permissions: permissionList
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
        if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        if (!/[A-Z]/.test(new_password)) return res.status(400).json({ error: 'Password must contain uppercase letter' });
        if (!/[0-9]/.test(new_password)) return res.status(400).json({ error: 'Password must contain number' });
        if (!/[!@#$%^&*(),.?":{}|<>]/.test(new_password)) return res.status(400).json({ error: 'Password must contain special character' });

        const { data: user } = await supabase.from('users').select('password_hash').eq('id', req.user.id).single();
        const valid = await bcrypt.compare(current_password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

        const hash = await bcrypt.hash(new_password, 12);
        await supabase.from('users').update({
            password_hash: hash, force_password_change: false
        }).eq('id', req.user.id);

        await logAudit(req.user.id, 'auth', 'change_password', 'users', req.user.id, null, { changed: true }, req);
        res.json({ message: 'Password changed successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Password change failed' });
    }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const { data: user } = await supabase
            .from('users')
            .select('id, username, email, full_name, phone, role_id, last_login, force_password_change, roles(name, level)')
            .eq('id', req.user.id)
            .single();
        const { data: perms } = await supabase
            .from('role_permissions')
            .select('permissions(code, name, module)')
            .eq('role_id', user.role_id);
        const permissionList = (perms || []).map(p => p.permissions ? p.permissions.code : '');
        res.json({
            ...user, role_name: user.roles.name, role_level: user.roles.level,
            permissions: permissionList
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

app.get('/api/auth/login-history', authMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const from = (page - 1) * limit;
        const { data, count } = await supabase
            .from('login_history')
            .select('*, users(full_name, username)', { count: 'exact' })
            .order('login_time', { ascending: false })
            .range(from, from + limit - 1);
        res.json({ data, total: count, page: +page, limit: +limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch login history' });
    }
});

app.post('/api/auth/logout', authMiddleware, async (req, res) => {
    try {
        const { data: lastLogin } = await supabase
            .from('login_history')
            .select('id')
            .eq('user_id', req.user.id)
            .eq('status', 'success')
            .is('logout_time', null)
            .order('login_time', { ascending: false })
            .limit(1);
        if (lastLogin && lastLogin.length) {
            await supabase.from('login_history').update({ logout_time: new Date().toISOString() }).eq('id', lastLogin[0].id);
        }
        res.json({ message: 'Logged out' });
    } catch (err) {
        res.status(500).json({ error: 'Logout failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// DASHBOARD ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/dashboard/stats', authMiddleware, async (req, res) => {
    try {
        const { data } = await supabase.from('v_dashboard_stats').select('*').single();
        res.json(data || {});
    } catch (err) {
        res.status(500).json({ error: 'Failed to load stats' });
    }
});

app.get('/api/dashboard/recent-vehicles', authMiddleware, async (req, res) => {
    try {
        const { data } = await supabase
            .from('vehicles')
            .select('id, vehicle_number, driver_name, status, gate_entry_time, transport_name')
            .order('created_at', { ascending: false })
            .limit(10);
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.get('/api/dashboard/recent-actions', authMiddleware, async (req, res) => {
    try {
        const { data } = await supabase
            .from('audit_log')
            .select('action_number, module, action, created_at, users(full_name)')
            .order('created_at', { ascending: false })
            .limit(15);
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.get('/api/dashboard/low-stock', authMiddleware, async (req, res) => {
    try {
        const { data } = await supabase
            .from('material_master')
            .select('id, material_name, ean, current_stock, min_stock, unit')
            .lt('current_stock', 'min_stock')
            .order('current_stock', { ascending: true })
            .limit(20);
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.get('/api/dashboard/rack-utilization', authMiddleware, async (req, res) => {
    try {
        const { data: total } = await supabase.from('rack_master').select('id', { count: 'exact', head: true }).eq('is_active', true);
        const { data: occupied } = await supabase.from('rack_master').select('id', { count: 'exact', head: true }).eq('status', 'Occupied');
        const { data: empty } = await supabase.from('rack_master').select('id', { count: 'exact', head: true }).eq('status', 'Empty');
        const { data: byZone } = await supabase
            .from('rack_master')
            .select('zone, status, count')
            .eq('is_active', true);
        res.json({
            total: total || 0, occupied: occupied || 0, empty: empty || 0,
            byZone: byZone || []
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.get('/api/dashboard/vehicle-timeline', authMiddleware, async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const { data } = await supabase
            .from('vehicles')
            .select('id, vehicle_number, driver_name, status, gate_entry_time, transport_name')
            .gte('created_at', today)
            .order('gate_entry_time', { ascending: false });
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.get('/api/dashboard/top-materials', authMiddleware, async (req, res) => {
    try {
        const { data } = await supabase
            .from('location_master')
            .select('material_name, ean, sum(quantity) as total_moved')
            .order('total_moved', { ascending: false })
            .limit(10);
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// VEHICLE ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/vehicles', authMiddleware, requirePermission('vehicles.create'),
    upload.fields([{ name: 'vehicle_photo', maxCount: 1 }, { name: 'driver_photo', maxCount: 1 }]),
    async (req, res) => {
        try {
            const { vehicle_number, lr_number, driver_name, driver_mobile, transport_name, dock_number, remarks } = req.body;
            if (!vehicle_number || !driver_name) return res.status(400).json({ error: 'Vehicle number and driver name required' });
            if (driver_mobile && !validatePhone(driver_mobile)) {
                return res.status(400).json({ error: 'Driver mobile must be exactly 10 digits' });
            }
            const vehicle_photo = req.files && req.files.vehicle_photo ? `/uploads/vehicles/${req.files.vehicle_photo[0].filename}` : null;
            const driver_photo = req.files && req.files.driver_photo ? `/uploads/vehicles/${req.files.driver_photo[0].filename}` : null;

            const { data, error } = await supabase.from('vehicles').insert({
                vehicle_number: sanitize(vehicle_number),
                lr_number: sanitize(lr_number),
                driver_name: sanitize(driver_name),
                driver_mobile: driver_mobile ? sanitize(driver_mobile) : null,
                transport_name: sanitize(transport_name),
                dock_number: sanitize(dock_number),
                vehicle_photo, driver_photo,
                remarks: sanitize(remarks),
                status: 'Pending Unload',
                created_by: req.user.id
            }).select().single();

            if (error) throw error;
            await logAudit(req.user.id, 'inbound', 'create_vehicle', 'vehicles', data.id, null, data, req);
            res.json({ message: 'Vehicle entry created', data });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to create vehicle entry' });
        }
    });

app.get('/api/vehicles', authMiddleware, requirePermission('vehicles.view'), async (req, res) => {
    try {
        const { page = 1, limit = 20, search, status, from_date, to_date } = req.query;
        let query = supabase.from('vehicles').select('*, users(full_name)', { count: 'exact' });
        if (search) query = query.or(`vehicle_number.ilike.%${search}%,driver_name.ilike.%${search}%,lr_number.ilike.%${search}%,transport_name.ilike.%${search}%`);
        if (status) query = query.eq('status', status);
        if (from_date) query = query.gte('created_at', from_date);
        if (to_date) query = query.lte('created_at', to_date + 'T23:59:59');
        const from = (page - 1) * limit;
        const { data, count } = await query.order('created_at', { ascending: false }).range(from, from + limit - 1);
        res.json({ data: data || [], total: count || 0, page: +page, limit: +limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch vehicles' });
    }
});

app.get('/api/vehicles/:id', authMiddleware, requirePermission('vehicles.view'), async (req, res) => {
    try {
        const { data } = await supabase.from('vehicles').select('*').eq('id', req.params.id).single();
        if (!data) return res.status(404).json({ error: 'Vehicle not found' });
        const { data: invoices } = await supabase
            .from('invoices')
            .select('*, invoice_materials(*)')
            .eq('vehicle_id', req.params.id)
            .order('created_at', { ascending: true });
        res.json({ ...data, invoices: invoices || [] });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch vehicle' });
    }
});

app.put('/api/vehicles/:id', authMiddleware, requirePermission('vehicles.edit'), async (req, res) => {
    try {
        const { vehicle_number, lr_number, driver_name, driver_mobile, transport_name, dock_number, remarks, status } = req.body;
        if (driver_mobile && !validatePhone(driver_mobile)) {
            return res.status(400).json({ error: 'Driver mobile must be exactly 10 digits' });
        }
        const { data: old } = await supabase.from('vehicles').select('*').eq('id', req.params.id).single();
        const updates = {};
        if (vehicle_number !== undefined) updates.vehicle_number = sanitize(vehicle_number);
        if (lr_number !== undefined) updates.lr_number = sanitize(lr_number);
        if (driver_name !== undefined) updates.driver_name = sanitize(driver_name);
        if (driver_mobile !== undefined) updates.driver_mobile = sanitize(driver_mobile);
        if (transport_name !== undefined) updates.transport_name = sanitize(transport_name);
        if (dock_number !== undefined) updates.dock_number = sanitize(dock_number);
        if (remarks !== undefined) updates.remarks = sanitize(remarks);
        if (status !== undefined) updates.status = sanitize(status);

        const { data, error } = await supabase.from('vehicles').update(updates).eq('id', req.params.id).select().single();
        if (error) throw error;
        await logAudit(req.user.id, 'inbound', 'edit_vehicle', 'vehicles', req.params.id, old, data, req);
        res.json({ message: 'Vehicle updated', data });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to update vehicle' });
    }
});

app.delete('/api/vehicles/:id', authMiddleware, requirePermission('vehicles.delete'), async (req, res) => {
    try {
        const { data: old } = await supabase.from('vehicles').select('*').eq('id', req.params.id).single();
        if (!old) return res.status(404).json({ error: 'Vehicle not found' });
        if (old.status !== 'Pending Unload') return res.status(400).json({ error: 'Cannot delete vehicle in ' + old.status + ' status' });
        const { error } = await supabase.from('vehicles').delete().eq('id', req.params.id);
        if (error) throw error;
        await logAudit(req.user.id, 'inbound', 'delete_vehicle', 'vehicles', req.params.id, old, null, req);
        res.json({ message: 'Vehicle deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to delete vehicle' });
    }
});

// Pending unload vehicles
app.get('/api/vehicles/pending-unload', authMiddleware, async (req, res) => {
    try {
        const { data } = await supabase
            .from('vehicles')
            .select('id, vehicle_number, driver_name, transport_name, gate_entry_time, dock_number')
            .eq('status', 'Pending Unload')
            .order('gate_entry_time', { ascending: true });
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// INVOICE ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/invoices', authMiddleware, requirePermission('invoices.create'),
    upload.single('invoice_file'),
    async (req, res) => {
        try {
            const { vehicle_id, invoice_number, invoice_date, vendor, purchase_order, materials } = req.body;
            if (!vehicle_id || !invoice_number || !invoice_date || !vendor) {
                return res.status(400).json({ error: 'Vehicle, Invoice Number, Date, and Vendor required' });
            }
            const invoice_file = req.file ? `/uploads/invoices/${req.file.filename}` : null;
            let mats = [];
            if (materials) {
                mats = typeof materials === 'string' ? JSON.parse(materials) : materials;
            }

            const { data: invoice, error: invErr } = await supabase.from('invoices').insert({
                vehicle_id, invoice_number: sanitize(invoice_number),
                invoice_date, vendor: sanitize(vendor),
                purchase_order: sanitize(purchase_order),
                invoice_file, status: 'Pending', unload_status: 'Pending',
                created_by: req.user.id
            }).select().single();
            if (invErr) throw invErr;

            if (mats.length > 0) {
                const invMats = mats.map(m => ({
                    invoice_id: invoice.id,
                    ean: sanitize(m.ean || ''),
                    material_name: sanitize(m.material_name),
                    description: sanitize(m.description || ''),
                    brand: sanitize(m.brand || ''),
                    division: sanitize(m.division || ''),
                    packing: sanitize(m.packing || ''),
                    unit: sanitize(m.unit || 'PCS'),
                    invoice_qty: parseFloat(m.quantity) || 0
                }));
                const { error: matErr } = await supabase.from('invoice_materials').insert(invMats);
                if (matErr) throw matErr;
            }

            await logAudit(req.user.id, 'inbound', 'create_invoice', 'invoices', invoice.id, null, invoice, req);
            res.json({ message: 'Invoice created', data: invoice });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to create invoice' });
        }
    });

app.post('/api/invoices/excel-upload/:vehicle_id', authMiddleware, requirePermission('invoices.create'),
    upload.single('bulk_file'),
    async (req, res) => {
        try {
            const vehicleId = req.params.vehicle_id;
            if (!req.file) return res.status(400).json({ error: 'Excel file required' });
            const wb = XLSX.readFile(req.file.path);
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
            if (!rows.length) return res.status(400).json({ error: 'Empty Excel file' });

            const { data: vehicle } = await supabase.from('vehicles').select('*').eq('id', vehicleId).single();
            if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

            let created = 0;
            for (const row of rows) {
                const invNum = String(row['Invoice Number'] || row['invoice_number'] || row['Invoice'] || 'INV-' + Date.now() + '-' + created);
                const invDate = row['Invoice Date'] || row['invoice_date'] || new Date().toISOString().split('T')[0];
                const vendor = String(row['Vendor'] || row['vendor'] || vehicle.transport_name || 'Unknown');
                const po = String(row['Purchase Order'] || row['purchase_order'] || '');
                const matName = String(row['Material'] || row['material'] || row['Material Name'] || row['material_name'] || '');
                const qty = parseFloat(row['Qty'] || row['Quantity'] || row['quantity'] || row['qty'] || 0);
                const ean = String(row['EAN'] || row['ean'] || '');

                if (!matName || !qty) continue;

                // Check if invoice already exists
                let { data: existingInv } = await supabase.from('invoices').select('id').eq('vehicle_id', vehicleId).eq('invoice_number', invNum).single();
                let invId;
                if (existingInv) {
                    invId = existingInv.id;
                } else {
                    const { data: newInv } = await supabase.from('invoices').insert({
                        vehicle_id: vehicleId, invoice_number: invNum,
                        invoice_date: invDate, vendor, purchase_order: po,
                        status: 'Pending', unload_status: 'Pending', created_by: req.user.id
                    }).select().single();
                    invId = newInv.id;
                    created++;
                }

                await supabase.from('invoice_materials').insert({
                    invoice_id: invId, ean, material_name: matName,
                    invoice_qty: qty, unit: 'PCS'
                });
            }

            res.json({ message: `Processed ${rows.length} rows, ${created} invoices created` });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Excel upload failed' });
        }
    });

app.get('/api/invoices/:vehicle_id', authMiddleware, requirePermission('invoices.view'), async (req, res) => {
    try {
        const { data } = await supabase
            .from('invoices')
            .select('*, invoice_materials(*)')
            .eq('vehicle_id', req.params.vehicle_id)
            .order('created_at', { ascending: true });
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.put('/api/invoices/:id', authMiddleware, requirePermission('invoices.edit'), async (req, res) => {
    try {
        const { invoice_number, invoice_date, vendor, purchase_order, status, unload_status } = req.body;
        const { data: old } = await supabase.from('invoices').select('*').eq('id', req.params.id).single();
        const updates = {};
        if (invoice_number !== undefined) updates.invoice_number = sanitize(invoice_number);
        if (invoice_date !== undefined) updates.invoice_date = invoice_date;
        if (vendor !== undefined) updates.vendor = sanitize(vendor);
        if (purchase_order !== undefined) updates.purchase_order = sanitize(purchase_order);
        if (status !== undefined) updates.status = sanitize(status);
        if (unload_status !== undefined) updates.unload_status = sanitize(unload_status);

        const { data, error } = await supabase.from('invoices').update(updates).eq('id', req.params.id).select().single();
        if (error) throw error;
        await logAudit(req.user.id, 'inbound', 'edit_invoice', 'invoices', req.params.id, old, data, req);
        res.json({ message: 'Invoice updated', data });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed' });
    }
});

app.delete('/api/invoices/:id', authMiddleware, requirePermission('invoices.delete'), async (req, res) => {
    try {
        const { data: old } = await supabase.from('invoices').select('*').eq('id', req.params.id).single();
        if (!old) return res.status(404).json({ error: 'Invoice not found' });
        if (old.unload_status === 'Completed') return res.status(400).json({ error: 'Cannot delete completed invoice' });
        await supabase.from('invoices').delete().eq('id', req.params.id);
        await logAudit(req.user.id, 'inbound', 'delete_invoice', 'invoices', req.params.id, old, null, req);
        res.json({ message: 'Invoice deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// UNLOAD ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/unload/invoice-materials/:invoice_id', authMiddleware, async (req, res) => {
    try {
        const { data } = await supabase
            .from('invoice_materials')
            .select('*')
            .eq('invoice_id', req.params.invoice_id);
        // Also get already unloaded qty
        const { data: unloaded } = await supabase
            .from('unload_records')
            .select('invoice_material_id, sum(unloaded_qty) as total_unloaded')
            .eq('invoice_id', req.params.invoice_id)
            .group('invoice_material_id');
        const unloadMap = {};
        (unloaded || []).forEach(u => { unloadMap[u.invoice_material_id] = parseFloat(u.total_unloaded); });
        const result = (data || []).map(m => ({
            ...m,
            already_unloaded: unloadMap[m.id] || 0,
            remaining: m.invoice_qty - (unloadMap[m.id] || 0)
        }));
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.post('/api/unload', authMiddleware, requirePermission('unload.perform'), async (req, res) => {
    try {
        const { vehicle_id, invoice_id, invoice_material_id, ean, material_name, invoice_qty, unloaded_qty, scan_method, difference_reason } = req.body;
        if (!vehicle_id || !invoice_id || !material_name || unloaded_qty === undefined) {
            return res.status(400).json({ error: 'Vehicle, Invoice, Material Name, and Unloaded Qty required' });
        }
        const invQty = parseFloat(invoice_qty) || 0;
        const unldQty = parseFloat(unloaded_qty) || 0;
        const hasDiff = invQty !== unldQty;
        const diffPct = invQty > 0 ? Math.abs(((invQty - unldQty) / invQty) * 100).toFixed(2) : 0;

        const { data: record, error } = await supabase.from('unload_records').insert({
            vehicle_id, invoice_id, invoice_material_id,
            ean: sanitize(ean || ''), material_name: sanitize(material_name),
            invoice_qty: invQty, unloaded_qty: unldQty,
            difference_reason: hasDiff ? sanitize(difference_reason || '') : null,
            approval_status: hasDiff ? 'Pending' : 'Auto-Approved',
            scan_method: sanitize(scan_method || 'manual'),
            unloaded_by: req.user.id
        }).select().single();
        if (error) throw error;

        // If difference, create difference report
        if (hasDiff) {
            const { data: diffNum } = await supabase.rpc('get_diff_number');
            await supabase.from('difference_reports').insert({
                diff_number: diffNum || ('DIF-' + Date.now()),
                vehicle_id, invoice_id, unload_record_id: record.id,
                ean: sanitize(ean || ''), material_name: sanitize(material_name),
                invoice_qty: invQty, received_qty: unldQty,
                difference_qty: invQty - unldQty, difference_pct: parseFloat(diffPct),
                reason: sanitize(difference_reason || ''),
                status: 'Pending', created_by: req.user.id
            });
            await notifyRoles(
                'Quantity Difference Detected',
                `Material: ${material_name}, Invoice: ${invQty}, Received: ${unldQty}, Diff: ${diffPct}%`,
                'warning', 'inbound', record.id
            );
        }

        await logAudit(req.user.id, 'inbound', 'unload_material', 'unload_records', record.id, null, record, req);

        res.json({
            message: 'Unload recorded',
            data: record,
            has_difference: hasDiff,
            difference_qty: invQty - unldQty,
            difference_pct: parseFloat(diffPct)
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Unload failed' });
    }
});

app.get('/api/unload/records/:vehicle_id', authMiddleware, requirePermission('unload.view'), async (req, res) => {
    try {
        const { data } = await supabase
            .from('unload_records')
            .select('*, users:unloaded_by(full_name), invoice_materials(material_name, ean)')
            .eq('vehicle_id', req.params.vehicle_id)
            .order('unloaded_at', { ascending: true });
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.post('/api/unload/complete-invoice/:invoice_id', authMiddleware, requirePermission('unload.perform'), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('invoices')
            .update({ unload_status: 'Completed', status: 'Unloaded' })
            .eq('id', req.params.invoice_id)
            .select().single();
        if (error) throw error;
        await logAudit(req.user.id, 'inbound', 'complete_invoice_unload', 'invoices', req.params.id, null, data, req);
        res.json({ message: 'Invoice unload completed', data });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed' });
    }
});

// EAN scan lookup
app.get('/api/scan/ean/:ean', authMiddleware, async (req, res) => {
    try {
        const ean = req.params.ean;
        const { data } = await supabase
            .from('material_master')
            .select('*')
            .eq('ean', ean)
            .single();
        if (data) {
            // Get last rack
            const { data: lastLoc } = await supabase
                .from('location_master')
                .select('rack_code')
                .eq('ean', ean)
                .order('action_date', { ascending: false })
                .limit(1)
                .single();
            data.last_rack = lastLoc ? lastLoc.rack_code : null;
        }
        res.json(data || null);
    } catch (err) {
        res.status(500).json({ error: 'Scan lookup failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// PUTAWAY ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/putaway', authMiddleware, requirePermission('putaway.perform'), async (req, res) => {
    try {
        const { rack_code, ean, material_name, description, packing, box_number, quantity, invoice_id, vehicle_id, brand, division } = req.body;
        if (!rack_code || !material_name || !quantity) {
            return res.status(400).json({ error: 'Rack, Material Name, and Quantity required' });
        }
        // Check rack exists
        const { data: rack } = await supabase.from('rack_master').select('*').eq('rack_code', rack_code).single();
        if (!rack) return res.status(404).json({ error: 'Rack not found' });

        const { data, error } = await supabase.from('location_master').insert({
            rack_code: sanitize(rack_code), ean: sanitize(ean || ''),
            material_name: sanitize(material_name), description: sanitize(description || ''),
            brand: sanitize(brand || ''), division: sanitize(division || ''),
            packing: sanitize(packing || ''), box_number: sanitize(box_number || ''),
            quantity: parseFloat(quantity), action_type: 'PUTAWAY',
            user_id: req.user.id, invoice_id, vehicle_id
        }).select().single();
        if (error) throw error;

        // Auto-create material if not exists
        if (ean) {
            const { data: existingMat } = await supabase.from('material_master').select('id').eq('ean', ean).single();
            if (!existingMat) {
                await supabase.from('material_master').insert({
                    material_code: 'MAT-' + Date.now(),
                    material_name: sanitize(material_name),
                    description: sanitize(description || ''),
                    ean: sanitize(ean), brand: sanitize(brand || ''),
                    division: sanitize(division || ''),
                    packing: sanitize(packing || ''),
                    unit: 'PCS'
                });
            }
        }

        await logAudit(req.user.id, 'putaway', 'putaway', 'location_master', data.id, null, data, req);
        res.json({ message: 'Putaway completed', data });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Putaway failed' });
    }
});

app.get('/api/putaway', authMiddleware, requirePermission('putaway.view'), async (req, res) => {
    try {
        const { page = 1, limit = 20, search, from_date, to_date } = req.query;
        let query = supabase.from('location_master').select('*, users:user_id(full_name)', { count: 'exact' })
            .eq('action_type', 'PUTAWAY');
        if (search) query = query.or(`material_name.ilike.%${search}%,rack_code.ilike.%${search}%,ean.ilike.%${search}%`);
        if (from_date) query = query.gte('action_date', from_date);
        if (to_date) query = query.lte('action_date', to_date + 'T23:59:59');
        const from = (page - 1) * limit;
        const { data, count } = await query.order('action_date', { ascending: false }).range(from, from + limit - 1);
        res.json({ data: data || [], total: count || 0, page: +page, limit: +limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// PIV ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/piv', authMiddleware, requirePermission('piv.perform'), async (req, res) => {
    try {
        const { ean, material_name, description, packing, box_number, quantity } = req.body;
        if (!material_name || !quantity) return res.status(400).json({ error: 'Material Name and Quantity required' });

        // Save PIV record
        const { data: pivRec, error: pivErr } = await supabase.from('piv_records').insert({
            ean: sanitize(ean || ''), material_name: sanitize(material_name),
            description: sanitize(description || ''), packing: sanitize(packing || ''),
            box_number: sanitize(box_number || ''), quantity: parseFloat(quantity),
            user_id: req.user.id
        }).select().single();
        if (pivErr) throw pivErr;

        // Save to location master as PIV
        const { data: locRec, error: locErr } = await supabase.from('location_master').insert({
            rack_code: sanitize(box_number || 'PIV-AREA'),
            ean: sanitize(ean || ''), material_name: sanitize(material_name),
            description: sanitize(description || ''), packing: sanitize(packing || ''),
            box_number: sanitize(box_number || ''),
            quantity: parseFloat(quantity), action_type: 'PIV', user_id: req.user.id
        }).select().single();
        if (locErr) throw locErr;

        await logAudit(req.user.id, 'piv', 'piv', 'piv_records', pivRec.id, null, pivRec, req);
        res.json({ message: 'PIV recorded', data: pivRec });
    } catch (err) {
        res.status(500).json({ error: err.message || 'PIV failed' });
    }
});

app.get('/api/piv', authMiddleware, requirePermission('piv.view'), async (req, res) => {
    try {
        const { page = 1, limit = 20, search, from_date, to_date } = req.query;
        let query = supabase.from('piv_records').select('*, users:user_id(full_name)', { count: 'exact' });
        if (search) query = query.or(`material_name.ilike.%${search}%,ean.ilike.%${search}%`);
        if (from_date) query = query.gte('created_at', from_date);
        if (to_date) query = query.lte('created_at', to_date + 'T23:59:59');
        const from = (page - 1) * limit;
        const { data, count } = await query.order('created_at', { ascending: false }).range(from, from + limit - 1);
        res.json({ data: data || [], total: count || 0, page: +page, limit: +limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// LOCATION MASTER ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/location', authMiddleware, requirePermission('location.view'), async (req, res) => {
    try {
        const { page = 1, limit = 20, search, rack, ean, material, brand, division, action_type, from_date, to_date, sort_by, sort_order } = req.query;
        let query = supabase.from('location_master').select('*, users:user_id(full_name)', { count: 'exact' });
        if (search) query = query.or(`material_name.ilike.%${search}%,rack_code.ilike.%${search}%,ean.ilike.%${search}%,brand.ilike.%${search}%,division.ilike.%${search}%`);
        if (rack) query = query.eq('rack_code', rack);
        if (ean) query = query.eq('ean', ean);
        if (material) query = query.ilike('material_name', `%${material}%`);
        if (brand) query = query.ilike('brand', `%${brand}%`);
        if (division) query = query.eq('division', division);
        if (action_type) query = query.eq('action_type', action_type);
        if (from_date) query = query.gte('action_date', from_date);
        if (to_date) query = query.lte('action_date', to_date + 'T23:59:59');
        if (sort_by) {
            const order = sort_order === 'asc' ? true : false;
            query = query.order(sort_by, { ascending: order });
        } else {
            query = query.order('action_date', { ascending: false });
        }
        const from = (page - 1) * limit;
        const { data, count } = await query.range(from, from + limit - 1);
        res.json({ data: data || [], total: count || 0, page: +page, limit: +limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.put('/api/location/:id', authMiddleware, requirePermission('location.edit'), async (req, res) => {
    try {
        const { rack_code, quantity, box_number } = req.body;
        const { data: old } = await supabase.from('location_master').select('*').eq('id', req.params.id).single();
        if (!old) return res.status(404).json({ error: 'Record not found' });
        const updates = {};
        if (rack_code !== undefined) updates.rack_code = sanitize(rack_code);
        if (quantity !== undefined) updates.quantity = parseFloat(quantity);
        if (box_number !== undefined) updates.box_number = sanitize(box_number);

        const { data, error } = await supabase.from('location_master').update(updates).eq('id', req.params.id).select().single();
        if (error) throw error;
        await logAudit(req.user.id, 'location', 'edit', 'location_master', req.params.id, old, data, req);
        res.json({ message: 'Location updated', data });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed' });
    }
});

app.delete('/api/location', authMiddleware, requirePermission('location.delete'), async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !ids.length) return res.status(400).json({ error: 'IDs required' });
        // Get old values for audit
        const { data: oldRecords } = await supabase.from('location_master').select('*').in('id', ids);
        const { error } = await supabase.from('location_master').delete().in('id', ids);
        if (error) throw error;
        for (const old of (oldRecords || [])) {
            await logAudit(req.user.id, 'location', 'delete', 'location_master', old.id, old, null, req);
        }
        res.json({ message: `${ids.length} records deleted` });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Delete failed' });
    }
});

// Bulk upload location
app.post('/api/location/bulk-upload', authMiddleware, requirePermission('upload.bulk'),
    upload.single('bulk_file'),
    async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'File required' });
            const wb = XLSX.readFile(req.file.path);
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
            if (!rows.length) return res.status(400).json({ error: 'Empty file' });

            const inserts = rows.map(r => ({
                rack_code: sanitize(String(r['Rack'] || r['rack'] || r['Rack Code'] || '')),
                ean: sanitize(String(r['EAN'] || r['ean'] || '')),
                material_name: sanitize(String(r['Material'] || r['material'] || r['Material Name'] || '')),
                description: sanitize(String(r['Description'] || r['description'] || '')),
                brand: sanitize(String(r['Brand'] || r['brand'] || '')),
                division: sanitize(String(r['Division'] || r['division'] || '')),
                packing: sanitize(String(r['Packing'] || r['packing'] || '')),
                box_number: sanitize(String(r['Box Number'] || r['box_number'] || '')),
                quantity: parseFloat(r['Quantity'] || r['quantity'] || r['Qty'] || r['qty'] || 0),
                action_type: sanitize(String(r['Action'] || r['action'] || 'PUTAWAY')),
                user_id: req.user.id
            })).filter(r => r.material_name && r.rack_code);

            const { error } = await supabase.from('location_master').insert(inserts);
            if (error) throw error;
            await logAudit(req.user.id, 'location', 'bulk_upload', 'location_master', null, null, { count: inserts.length }, req);
            res.json({ message: `${inserts.length} records uploaded` });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Bulk upload failed' });
        }
    });

// ═══════════════════════════════════════════════════════════
// PICKING REPORT ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/picking', authMiddleware, requirePermission('picking.create'), async (req, res) => {
    try {
        const { picker_name, items } = req.body;
        if (!picker_name || !items || !items.length) {
            return res.status(400).json({ error: 'Picker name and items required' });
        }

        const { data: pickNum } = await supabase.rpc('get_pick_number');
        const reportNumber = pickNum || ('PCK-' + Date.now());

        const totalQty = items.reduce((s, i) => s + (parseFloat(i.required_qty) || 0), 0);

        const { data: report, error: repErr } = await supabase.from('picking_reports').insert({
            report_number: reportNumber, picker_name: sanitize(picker_name),
            status: 'Open', total_items: items.length, total_qty: totalQty,
            created_by: req.user.id
        }).select().single();
        if (repErr) throw repErr;

        // Auto-allocate rack for each item
        const reportItems = [];
        for (const item of items) {
            let rackCode = item.rack_code || '';
            // Auto allocate if not provided
            if (!rackCode && item.ean) {
                const { data: loc } = await supabase
                    .from('location_master')
                    .select('rack_code, quantity')
                    .eq('ean', item.ean)
                    .gt('quantity', 0)
                    .order('action_date', { ascending: false })
                    .limit(1)
                    .single();
                if (loc) rackCode = loc.rack_code;
            }
            if (!rackCode && item.material_name) {
                const { data: loc } = await supabase
                    .from('location_master')
                    .select('rack_code, quantity')
                    .ilike('material_name', item.material_name)
                    .gt('quantity', 0)
                    .order('action_date', { ascending: false })
                    .limit(1)
                    .single();
                if (loc) rackCode = loc.rack_code;
            }

            reportItems.push({
                report_id: report.id,
                ean: sanitize(item.ean || ''),
                material_name: sanitize(item.material_name),
                description: sanitize(item.description || ''),
                rack_code: sanitize(rackCode),
                required_qty: parseFloat(item.required_qty) || 0,
                picked_qty: 0, status: 'Pending'
            });
        }

        const { error: itemErr } = await supabase.from('picking_report_items').insert(reportItems);
        if (itemErr) throw itemErr;

        await logAudit(req.user.id, 'picking', 'create_report', 'picking_reports', report.id, null, report, req);
        res.json({ message: 'Picking report created', data: { ...report, items: reportItems } });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to create picking report' });
    }
});

app.get('/api/picking', authMiddleware, requirePermission('picking.view'), async (req, res) => {
    try {
        const { page = 1, limit = 20, search, status, from_date, to_date } = req.query;
        let query = supabase.from('picking_reports').select('*, users:created_by(full_name)', { count: 'exact' });
        if (search) query = query.or(`report_number.ilike.%${search}%,picker_name.ilike.%${search}%`);
        if (status) query = query.eq('status', status);
        if (from_date) query = query.gte('created_at', from_date);
        if (to_date) query = query.lte('created_at', to_date + 'T23:59:59');
        const from = (page - 1) * limit;
        const { data, count } = await query.order('created_at', { ascending: false }).range(from, from + limit - 1);
        res.json({ data: data || [], total: count || 0, page: +page, limit: +limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.get('/api/picking/:id', authMiddleware, requirePermission('picking.view'), async (req, res) => {
    try {
        const { data: report } = await supabase.from('picking_reports').select('*').eq('id', req.params.id).single();
        if (!report) return res.status(404).json({ error: 'Report not found' });
        const { data: items } = await supabase
            .from('picking_report_items')
            .select('*')
            .eq('report_id', req.params.id)
            .order('material_name');
        res.json({ ...report, items: items || [] });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.put('/api/picking/:id/status', authMiddleware, requirePermission('picking.edit'), async (req, res) => {
    try {
        const { status } = req.body;
        const { data, error } = await supabase
            .from('picking_reports')
            .update({ status: sanitize(status) })
            .eq('id', req.params.id)
            .select().single();
        if (error) throw error;
        await logAudit(req.user.id, 'picking', 'update_status', 'picking_reports', req.params.id, null, data, req);
        res.json({ message: 'Status updated', data });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed' });
    }
});

app.delete('/api/picking/:id', authMiddleware, requirePermission('picking.delete'), async (req, res) => {
    try {
        const { data: old } = await supabase.from('picking_reports').select('*').eq('id', req.params.id).single();
        if (!old) return res.status(404).json({ error: 'Report not found' });
        if (old.status === 'Completed') return res.status(400).json({ error: 'Cannot delete completed report' });
        await supabase.from('picking_reports').delete().eq('id', req.params.id);
        await logAudit(req.user.id, 'picking', 'delete_report', 'picking_reports', req.params.id, old, null, req);
        res.json({ message: 'Report deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// PICK MATERIAL HISTORY ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/pick-history', authMiddleware, requirePermission('picking.edit'), async (req, res) => {
    try {
        const { report_id, item_id, action_type, new_qty, new_rack, ean, material_name } = req.body;
        if (!report_id || !item_id || !action_type) {
            return res.status(400).json({ error: 'Report ID, Item ID, and Action Type required' });
        }

        const { data: oldItem } = await supabase.from('picking_report_items').select('*').eq('id', item_id).single();
        if (!oldItem) return res.status(404).json({ error: 'Item not found' });

        const { data: actionNum } = await supabase.rpc('get_pick_history_number');
        const actionNumber = actionNum || ('PHA-' + Date.now());

        let updates = {};
        if (action_type === 'delete') {
            await supabase.from('picking_report_items').delete().eq('id', item_id);
            // Update location master
            if (oldItem.ean && oldItem.picked_qty > 0) {
                await supabase.from('location_master').insert({
                    rack_code: oldItem.rack_code || 'DELETED', ean: oldItem.ean,
                    material_name: oldItem.material_name, quantity: oldItem.picked_qty,
                    action_type: 'PICK_REVERSE', user_id: req.user.id
                });
            }
        } else if (action_type === 'minus_qty') {
            const newPicked = Math.max(0, (oldItem.picked_qty || 0) - (new_qty || 1));
            updates.picked_qty = newPicked;
            if (newPicked === 0) updates.status = 'Pending';
            // Reverse location
            if (oldItem.ean && new_qty > 0) {
                await supabase.from('location_master').insert({
                    rack_code: oldItem.rack_code || 'ADJUST', ean: oldItem.ean,
                    material_name: oldItem.material_name, quantity: new_qty,
                    action_type: 'PICK_REVERSE', user_id: req.user.id
                });
            }
        } else if (action_type === 'edit_qty') {
            const diff = (new_qty || 0) - (oldItem.picked_qty || 0);
            updates.picked_qty = new_qty;
            if (new_qty > 0) updates.status = 'Picked';
            // Adjust location
            if (oldItem.ean && diff !== 0) {
                await supabase.from('location_master').insert({
                    rack_code: oldItem.rack_code || 'ADJUST', ean: oldItem.ean,
                    material_name: oldItem.material_name, quantity: Math.abs(diff),
                    action_type: diff > 0 ? 'PICK' : 'PICK_REVERSE', user_id: req.user.id
                });
            }
        } else if (action_type === 'reassign_rack') {
            updates.rack_code = sanitize(new_rack || '');
            if (oldItem.ean && oldItem.picked_qty > 0) {
                await supabase.from('location_master').insert({
                    rack_code: oldItem.rack_code || 'OLD', ean: oldItem.ean,
                    material_name: oldItem.material_name, quantity: oldItem.picked_qty,
                    action_type: 'PICK_REVERSE', user_id: req.user.id
                });
                await supabase.from('location_master').insert({
                    rack_code: sanitize(new_rack || 'NEW'), ean: oldItem.ean,
                    material_name: oldItem.material_name, quantity: oldItem.picked_qty,
                    action_type: 'PICK', user_id: req.user.id
                });
            }
        }

        if (Object.keys(updates).length && action_type !== 'delete') {
            await supabase.from('picking_report_items').update(updates).eq('id', item_id);
        }

        // Save history
        await supabase.from('pick_material_history').insert({
            action_number: actionNumber, report_id, item_id,
            ean: sanitize(ean || oldItem.ean || ''),
            material_name: sanitize(material_name || oldItem.material_name || ''),
            action_type, old_qty: oldItem.picked_qty, new_qty: new_qty || 0,
            old_rack: oldItem.rack_code, new_rack: new_rack || null,
            user_id: req.user.id
        });

        await logAudit(req.user.id, 'picking', 'pick_history_' + action_type, 'pick_material_history', null, oldItem, { action_type, new_qty, new_rack }, req);
        res.json({ message: 'Action recorded', action_number: actionNumber });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Action failed' });
    }
});

app.get('/api/pick-history/:report_id', authMiddleware, requirePermission('picking.view'), async (req, res) => {
    try {
        const { data } = await supabase
            .from('pick_material_history')
            .select('*, users:user_id(full_name)')
            .eq('report_id', req.params.report_id)
            .order('created_at', { ascending: false });
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// RACK MASTER ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/racks', authMiddleware, requirePermission('rack.view'), async (req, res) => {
    try {
        const { page = 1, limit = 50, search, zone, status, rack_type } = req.query;
        let query = supabase.from('rack_master').select('*', { count: 'exact' }).eq('is_active', true);
        if (search) query = query.or(`rack_code.ilike.%${search}%,zone.ilike.%${search}%`);
        if (zone) query = query.eq('zone', zone);
        if (status) query = query.eq('status', status);
        if (rack_type) query = query.eq('rack_type', rack_type);
        const from = (page - 1) * limit;
        const { data, count } = await query.order('rack_code').range(from, from + limit - 1);
        res.json({ data: data || [], total: count || 0, page: +page, limit: +limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.post('/api/racks', authMiddleware, requirePermission('rack.create'), async (req, res) => {
    try {
        const { racks } = req.body;
        if (!racks || !racks.length) return res.status(400).json({ error: 'Racks data required' });
        const inserts = racks.map(r => ({
            rack_code: sanitize(r.rack_code),
            rack_type: sanitize(r.rack_type || 'Standard'),
            zone: sanitize(r.zone || ''),
            warehouse: sanitize(r.warehouse || 'Main Warehouse'),
            capacity: parseFloat(r.capacity) || 500,
            status: 'Empty'
        }));
        const { data, error } = await supabase.from('rack_master').insert(inserts).select();
        if (error) throw error;
        await logAudit(req.user.id, 'rack', 'create', 'rack_master', null, null, { count: inserts.length }, req);
        res.json({ message: `${inserts.length} racks created`, data });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed' });
    }
});

app.put('/api/racks/:id', authMiddleware, requirePermission('rack.edit'), async (req, res) => {
    try {
        const { rack_code, rack_type, zone, warehouse, capacity, is_active } = req.body;
        const { data: old } = await supabase.from('rack_master').select('*').eq('id', req.params.id).single();
        const updates = {};
        if (rack_code !== undefined) updates.rack_code = sanitize(rack_code);
        if (rack_type !== undefined) updates.rack_type = sanitize(rack_type);
        if (zone !== undefined) updates.zone = sanitize(zone);
        if (warehouse !== undefined) updates.warehouse = sanitize(warehouse);
        if (capacity !== undefined) updates.capacity = parseFloat(capacity);
        if (is_active !== undefined) updates.is_active = is_active;

        const { data, error } = await supabase.from('rack_master').update(updates).eq('id', req.params.id).select().single();
        if (error) throw error;
        await logAudit(req.user.id, 'rack', 'edit', 'rack_master', req.params.id, old, data, req);
        res.json({ message: 'Rack updated', data });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed' });
    }
});

app.delete('/api/racks/:id', authMiddleware, requirePermission('rack.delete'), async (req, res) => {
    try {
        const { data: old } = await supabase.from('rack_master').select('*').eq('id', req.params.id).single();
        if (old.status === 'Occupied') return res.status(400).json({ error: 'Cannot delete occupied rack' });
        await supabase.from('rack_master').update({ is_active: false }).eq('id', req.params.id);
        await logAudit(req.user.id, 'rack', 'delete', 'rack_master', req.params.id, old, null, req);
        res.json({ message: 'Rack deactivated' });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed' });
    }
});

app.post('/api/racks/bulk-upload', authMiddleware, requirePermission('upload.bulk'),
    upload.single('bulk_file'),
    async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'File required' });
            const wb = XLSX.readFile(req.file.path);
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
            const inserts = rows.map(r => ({
                rack_code: sanitize(String(r['Rack'] || r['Rack Code'] || r['rack_code'] || '')),
                rack_type: sanitize(String(r['Type'] || r['Rack Type'] || r['rack_type'] || 'Standard')),
                zone: sanitize(String(r['Zone'] || r['zone'] || '')),
                warehouse: sanitize(String(r['Warehouse'] || r['warehouse'] || 'Main Warehouse')),
                capacity: parseFloat(r['Capacity'] || r['capacity'] || 500)
            })).filter(r => r.rack_code);
            const { error } = await supabase.from('rack_master').insert(inserts);
            if (error) throw error;
            res.json({ message: `${inserts.length} racks uploaded` });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Bulk upload failed' });
        }
    });

// Warehouse map data
app.get('/api/racks/map', authMiddleware, async (req, res) => {
    try {
        const { data } = await supabase
            .from('rack_master')
            .select('rack_code, rack_type, zone, capacity, current_load, status')
            .eq('is_active', true)
            .order('zone')
            .order('rack_code');
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// MATERIAL MASTER ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/materials', authMiddleware, requirePermission('material.view'), async (req, res) => {
    try {
        const { page = 1, limit = 20, search, ean, brand, division } = req.query;
        let query = supabase.from('material_master').select('*', { count: 'exact' }).eq('is_active', true);
        if (search) query = query.or(`material_name.ilike.%${search}%,material_code.ilike.%${search}%,ean.ilike.%${search}%,brand.ilike.%${search}%`);
        if (ean) query = query.eq('ean', ean);
        if (brand) query = query.eq('brand', brand);
        if (division) query = query.eq('division', division);
        const from = (page - 1) * limit;
        const { data, count } = await query.order('material_name').range(from, from + limit - 1);
        res.json({ data: data || [], total: count || 0, page: +page, limit: +limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.post('/api/materials', authMiddleware, requirePermission('material.create'),
    upload.single('material_image'),
    async (req, res) => {
        try {
            const { material_code, material_name, description, ean, brand, division, packing, unit, weight, min_stock } = req.body;
            if (!material_code || !material_name) return res.status(400).json({ error: 'Material Code and Name required' });
            const image = req.file ? `/uploads/materials/${req.file.filename}` : null;
            const { data, error } = await supabase.from('material_master').insert({
                material_code: sanitize(material_code), material_name: sanitize(material_name),
                description: sanitize(description || ''), ean: sanitize(ean || ''),
                brand: sanitize(brand || ''), division: sanitize(division || ''),
                packing: sanitize(packing || ''), unit: sanitize(unit || 'PCS'),
                weight: weight ? parseFloat(weight) : null,
                min_stock: min_stock ? parseFloat(min_stock) : 0, image
            }).select().single();
            if (error) throw error;
            await logAudit(req.user.id, 'material', 'create', 'material_master', data.id, null, data, req);
            res.json({ message: 'Material created', data });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed' });
        }
    });

app.put('/api/materials/:id', authMiddleware, requirePermission('material.edit'), async (req, res) => {
    try {
        const { material_name, description, ean, brand, division, packing, unit, weight, min_stock, is_active } = req.body;
        const { data: old } = await supabase.from('material_master').select('*').eq('id', req.params.id).single();
        const updates = {};
        if (material_name !== undefined) updates.material_name = sanitize(material_name);
        if (description !== undefined) updates.description = sanitize(description);
        if (ean !== undefined) updates.ean = sanitize(ean);
        if (brand !== undefined) updates.brand = sanitize(brand);
        if (division !== undefined) updates.division = sanitize(division);
        if (packing !== undefined) updates.packing = sanitize(packing);
        if (unit !== undefined) updates.unit = sanitize(unit);
        if (weight !== undefined) updates.weight = weight ? parseFloat(weight) : null;
        if (min_stock !== undefined) updates.min_stock = parseFloat(min_stock);
        if (is_active !== undefined) updates.is_active = is_active;

        const { data, error } = await supabase.from('material_master').update(updates).eq('id', req.params.id).select().single();
        if (error) throw error;
        await logAudit(req.user.id, 'material', 'edit', 'material_master', req.params.id, old, data, req);
        res.json({ message: 'Material updated', data });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed' });
    }
});

app.delete('/api/materials/:id', authMiddleware, requirePermission('material.delete'), async (req, res) => {
    try {
        const { data: old } = await supabase.from('material_master').select('*').eq('id', req.params.id).single();
        await supabase.from('material_master').update({ is_active: false }).eq('id', req.params.id);
        await logAudit(req.user.id, 'material', 'delete', 'material_master', req.params.id, old, null, req);
        res.json({ message: 'Material deactivated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.post('/api/materials/bulk-upload', authMiddleware, requirePermission('upload.bulk'),
    upload.single('bulk_file'),
    async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'File required' });
            const wb = XLSX.readFile(req.file.path);
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
            const inserts = rows.map((r, i) => ({
                material_code: sanitize(String(r['Material Code'] || r['material_code'] || 'MAT-BULK-' + (i + 1))),
                material_name: sanitize(String(r['Material'] || r['Material Name'] || r['material_name'] || '')),
                description: sanitize(String(r['Description'] || r['description'] || '')),
                ean: sanitize(String(r['EAN'] || r['ean'] || '')),
                brand: sanitize(String(r['Brand'] || r['brand'] || '')),
                division: sanitize(String(r['Division'] || r['division'] || '')),
                packing: sanitize(String(r['Packing'] || r['packing'] || '')),
                unit: sanitize(String(r['Unit'] || r['unit'] || 'PCS')),
                weight: parseFloat(r['Weight'] || r['weight'] || null),
                min_stock: parseFloat(r['Min Stock'] || r['min_stock'] || 0)
            })).filter(r => r.material_name);
            const { error } = await supabase.from('material_master').insert(inserts);
            if (error) throw error;
            res.json({ message: `${inserts.length} materials uploaded` });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Bulk upload failed' });
        }
    });

// ═══════════════════════════════════════════════════════════
// USER MANAGEMENT ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/users', authMiddleware, requirePermission('users.view'), async (req, res) => {
    try {
        const { page = 1, limit = 20, search, role, status } = req.query;
        let query = supabase.from('users').select('id, username, email, full_name, phone, role_id, is_active, is_locked, failed_login_count, force_password_change, last_login, created_at, roles(name)', { count: 'exact' });
        if (search) query = query.or(`username.ilike.%${search}%,full_name.ilike.%${search}%,email.ilike.%${search}%`);
        if (role) {
            const { data: roleData } = await supabase.from('roles').select('id').eq('name', role).single();
            if (roleData) query = query.eq('role_id', roleData.id);
        }
        if (status === 'active') query = query.eq('is_active', true);
        if (status === 'inactive') query = query.eq('is_active', false);
        if (status === 'locked') query = query.eq('is_locked', true);
        const from = (page - 1) * limit;
        const { data, count } = await query.order('created_at', { ascending: false }).range(from, from + limit - 1);
        res.json({ data: data || [], total: count || 0, page: +page, limit: +limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.post('/api/users', authMiddleware, requirePermission('users.create'), async (req, res) => {
    try {
        const { username, email, password, full_name, phone, role_id, force_password_change } = req.body;
        if (!username || !email || !password || !full_name || !role_id) {
            return res.status(400).json({ error: 'All fields required' });
        }
        if (password.length < 8) return res.status(400).json({ error: 'Password min 8 chars' });
        const hash = await bcrypt.hash(password, 12);
        const { data, error } = await supabase.from('users').insert({
            username: sanitize(username), email: sanitize(email).toLowerCase(),
            password_hash: hash, full_name: sanitize(full_name),
            phone: sanitize(phone || ''), role_id,
            force_password_change: force_password_change !== false
        }).select('id, username, email, full_name, phone, role_id, force_password_change, roles(name)').single();
        if (error) throw error;
        await logAudit(req.user.id, 'users', 'create_user', 'users', data.id, null, data, req);
        res.json({ message: 'User created', data });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to create user' });
    }
});

app.put('/api/users/:id', authMiddleware, requirePermission('users.edit'), async (req, res) => {
    try {
        const { full_name, email, phone, role_id, is_active, force_password_change } = req.body;
        const { data: old } = await supabase.from('users').select('*').eq('id', req.params.id).single();
        const updates = {};
        if (full_name !== undefined) updates.full_name = sanitize(full_name);
        if (email !== undefined) updates.email = sanitize(email).toLowerCase();
        if (phone !== undefined) updates.phone = sanitize(phone);
        if (role_id !== undefined) updates.role_id = role_id;
        if (is_active !== undefined) updates.is_active = is_active;
        if (force_password_change !== undefined) updates.force_password_change = force_password_change;

        const { data, error } = await supabase.from('users').update(updates).eq('id', req.params.id)
            .select('id, username, email, full_name, phone, role_id, is_active, force_password_change, roles(name)').single();
        if (error) throw error;
        await logAudit(req.user.id, 'users', 'edit_user', 'users', req.params.id, old, data, req);
        res.json({ message: 'User updated', data });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed' });
    }
});

app.post('/api/users/:id/reset-password', authMiddleware, requirePermission('users.reset_pwd'), async (req, res) => {
    try {
        const { new_password } = req.body;
        if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'Password min 8 chars' });
        const hash = await bcrypt.hash(new_password, 12);
        await supabase.from('users').update({
            password_hash: hash, force_password_change: true, is_locked: false, failed_login_count: 0
        }).eq('id', req.params.id);
        await logAudit(req.user.id, 'users', 'reset_password', 'users', req.params.id, null, { reset: true }, req);
        res.json({ message: 'Password reset successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

app.get('/api/roles', authMiddleware, async (req, res) => {
    try {
        const { data } = await supabase.from('roles').select('*').order('level', { ascending: false });
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// SETTINGS ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/settings', authMiddleware, requirePermission('settings.view'), async (req, res) => {
    try {
        const { data } = await supabase.from('settings').select('*').order('category');
        const settings = {};
        (data || []).forEach(s => { settings[s.key] = s.value; });
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.put('/api/settings', authMiddleware, requirePermission('settings.edit'), async (req, res) => {
    try {
        const updates = req.body;
        if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Settings object required' });
        for (const [key, value] of Object.entries(updates)) {
            await supabase.from('settings').update({ value: String(value), updated_by: req.user.id }).eq('key', key);
        }
        await logAudit(req.user.id, 'settings', 'update', 'settings', null, null, updates, req);
        res.json({ message: 'Settings updated' });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// AUDIT LOG ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/audit', authMiddleware, requirePermission('audit.view'), async (req, res) => {
    try {
        const { page = 1, limit = 20, search, module, action, from_date, to_date } = req.query;
        let query = supabase.from('audit_log').select('*, users(full_name, username)', { count: 'exact' });
        if (search) query = query.or(`action_number.ilike.%${search}%,module.ilike.%${search}%,action.ilike.%${search}%`);
        if (module) query = query.eq('module', module);
        if (action) query = query.eq('action', action);
        if (from_date) query = query.gte('created_at', from_date);
        if (to_date) query = query.lte('created_at', to_date + 'T23:59:59');
        const from = (page - 1) * limit;
        const { data, count } = await query.order('created_at', { ascending: false }).range(from, from + limit - 1);
        res.json({ data: data || [], total: count || 0, page: +page, limit: +limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.get('/api/audit/:action_number', authMiddleware, requirePermission('audit.view'), async (req, res) => {
    try {
        const { data } = await supabase
            .from('audit_log')
            .select('*, users(full_name, username)')
            .eq('action_number', req.params.action_number);
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// NOTIFICATION ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/notifications', authMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const from = (page - 1) * limit;
        const { data, count } = await supabase
            .from('notifications')
            .select('*', { count: 'exact' })
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .range(from, from + limit - 1);
        const { count: unreadCount } = await supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', req.user.id)
            .eq('is_read', false);
        res.json({ data: data || [], total: count || 0, unread: unreadCount || 0, page: +page, limit: +limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.put('/api/notifications/read-all', authMiddleware, async (req, res) => {
    try {
        await supabase.from('notifications').update({ is_read: true }).eq('user_id', req.user.id).eq('is_read', false);
        res.json({ message: 'All marked as read' });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.put('/api/notifications/:id/read', authMiddleware, async (req, res) => {
    try {
        await supabase.from('notifications').update({ is_read: true }).eq('id', req.params.id);
        res.json({ message: 'Marked as read' });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// DIFFERENCE REPORTS ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/differences', authMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20, status, from_date, to_date } = req.query;
        let query = supabase.from('difference_reports').select('*, users:created_by(full_name)', { count: 'exact' });
        if (status) query = query.eq('status', status);
        if (from_date) query = query.gte('created_at', from_date);
        if (to_date) query = query.lte('created_at', to_date + 'T23:59:59');
        const from = (page - 1) * limit;
        const { data, count } = await query.order('created_at', { ascending: false }).range(from, from + limit - 1);
        res.json({ data: data || [], total: count || 0, page: +page, limit: +limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.put('/api/differences/:id/approve', authMiddleware, async (req, res) => {
    try {
        const { status } = req.body;
        const { data, error } = await supabase
            .from('difference_reports')
            .update({ status: sanitize(status || 'Approved'), approved_by: req.user.id })
            .eq('id', req.params.id)
            .select().single();
        if (error) throw error;
        // Also update unload record
        await supabase.from('unload_records').update({ approval_status: sanitize(status || 'Approved'), approved_by: req.user.id })
            .eq('id', data.unload_record_id);
        await logAudit(req.user.id, 'inbound', 'approve_difference', 'difference_reports', req.params.id, null, data, req);
        res.json({ message: 'Difference ' + status, data });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// EXPORT ROUTES — EXCEL
// ═══════════════════════════════════════════════════════════

app.get('/api/export/excel/:module', authMiddleware, requirePermission('reports.export'), async (req, res) => {
    try {
        const { module } = req.params;
        const { from_date, to_date, search, status } = req.query;
        let data = [];
        let filename = module + '_export.xlsx';

        if (module === 'location') {
            let q = supabase.from('location_master').select('*');
            if (search) q = q.or(`material_name.ilike.%${search}%,rack_code.ilike.%${search}%,ean.ilike.%${search}%`);
            if (from_date) q = q.gte('action_date', from_date);
            if (to_date) q = q.lte('action_date', to_date + 'T23:59:59');
            const { data: d } = await q.order('action_date', { ascending: false }).limit(10000);
            data = (d || []).map(r => ({
                Date: r.action_date ? r.action_date.split('T')[0] : '',
                Rack: r.rack_code, EAN: r.ean, Material: r.material_name,
                Description: r.description || '', Brand: r.brand || '',
                Division: r.division || '', Packing: r.packing || '',
                'Box Number': r.box_number || '', Quantity: r.quantity,
                Action: r.action_type
            }));
            filename = 'location_master_export.xlsx';
        } else if (module === 'vehicles') {
            let q = supabase.from('vehicles').select('*');
            if (from_date) q = q.gte('created_at', from_date);
            if (to_date) q = q.lte('created_at', to_date + 'T23:59:59');
            if (status) q = q.eq('status', status);
            const { data: d } = await q.order('created_at', { ascending: false }).limit(10000);
            data = (d || []).map(r => ({
                'Vehicle Number': r.vehicle_number, 'LR Number': r.lr_number || '',
                'Driver Name': r.driver_name, 'Driver Mobile': r.driver_mobile || '',
                Transport: r.transport_name || '', 'Dock Number': r.dock_number || '',
                'Gate Entry': r.gate_entry_time || '', Status: r.status, Remarks: r.remarks || ''
            }));
            filename = 'vehicles_export.xlsx';
        } else if (module === 'materials') {
            let q = supabase.from('material_master').select('*').eq('is_active', true);
            const { data: d } = await q.order('material_name').limit(10000);
            data = (d || []).map(r => ({
                'Material Code': r.material_code, 'Material Name': r.material_name,
                Description: r.description || '', EAN: r.ean || '',
                Brand: r.brand || '', Division: r.division || '',
                Packing: r.packing || '', Unit: r.unit || 'PCS',
                Weight: r.weight || '', 'Min Stock': r.min_stock || 0,
                'Current Stock': r.current_stock || 0
            }));
            filename = 'materials_export.xlsx';
        } else if (module === 'racks') {
            const { data: d } = await supabase.from('rack_master').select('*').eq('is_active', true).order('rack_code');
            data = (d || []).map(r => ({
                'Rack Code': r.rack_code, 'Type': r.rack_type, Zone: r.zone || '',
                Warehouse: r.warehouse || '', Capacity: r.capacity || 0,
                'Current Load': r.current_load || 0, Status: r.status
            }));
            filename = 'racks_export.xlsx';
        } else if (module === 'picking') {
            let q = supabase.from('picking_reports').select('*, picking_report_items(*)');
            if (from_date) q = q.gte('created_at', from_date);
            if (to_date) q = q.lte('created_at', to_date + 'T23:59:59');
            const { data: d } = await q.order('created_at', { ascending: false }).limit(10000);
            const rows = [];
            (d || []).forEach(r => {
                (r.picking_report_items || []).forEach(item => {
                    rows.push({
                        'Report Number': r.report_number, 'Picker Name': r.picker_name,
                        'Material': item.material_name, EAN: item.ean || '',
                        Rack: item.rack_code || '', 'Required Qty': item.required_qty,
                        'Picked Qty': item.picked_qty, Status: item.status
                    });
                });
            });
            data = rows;
            filename = 'picking_export.xlsx';
        } else if (module === 'differences') {
            let q = supabase.from('difference_reports').select('*');
            if (from_date) q = q.gte('created_at', from_date);
            if (to_date) q = q.lte('created_at', to_date + 'T23:59:59');
            if (status) q = q.eq('status', status);
            const { data: d } = await q.order('created_at', { ascending: false }).limit(10000);
            data = (d || []).map(r => ({
                'Diff Number': r.diff_number, Material: r.material_name,
                EAN: r.ean || '', 'Invoice Qty': r.invoice_qty,
                'Received Qty': r.received_qty, 'Difference': r.difference_qty,
                'Diff %': r.difference_pct, Reason: r.reason || '', Status: r.status
            }));
            filename = 'differences_export.xlsx';
        } else if (module === 'audit') {
            let q = supabase.from('audit_log').select('*');
            if (from_date) q = q.gte('created_at', from_date);
            if (to_date) q = q.lte('created_at', to_date + 'T23:59:59');
            const { data: d } = await q.order('created_at', { ascending: false }).limit(10000);
            data = (d || []).map(r => ({
                'Action Number': r.action_number, Module: r.module,
                Action: r.action, 'IP Address': r.ip_address || '',
                'Date Time': r.created_at || ''
            }));
            filename = 'audit_export.xlsx';
        }

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(data);
        XLSX.utils.book_append_sheet(wb, ws, 'Data');
        const filePath = path.join(UPLOAD_DIR, 'exports', filename);
        XLSX.writeFile(wb, filePath);
        res.download(filePath, filename);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Export failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// EXPORT ROUTES — PDF
// ═══════════════════════════════════════════════════════════

app.get('/api/export/pdf/:module', authMiddleware, requirePermission('reports.export'), async (req, res) => {
    try {
        const { module } = req.params;
        const { from_date, to_date, search, status } = req.query;
        let data = [];
        let title = module.toUpperCase() + ' REPORT';

        if (module === 'location') {
            let q = supabase.from('location_master').select('*');
            if (search) q = q.or(`material_name.ilike.%${search}%,rack_code.ilike.%${search}%`);
            if (from_date) q = q.gte('action_date', from_date);
            if (to_date) q = q.lte('action_date', to_date + 'T23:59:59');
            const { data: d } = await q.order('action_date', { ascending: false }).limit(500);
            data = d || [];
            title = 'LOCATION MASTER REPORT';
        } else if (module === 'picking') {
            let q = supabase.from('picking_reports').select('*, picking_report_items(*)');
            if (from_date) q = q.gte('created_at', from_date);
            const { data: d } = await q.order('created_at', { ascending: false }).limit(100);
            data = d || [];
            title = 'PICKING REPORTS';
        } else if (module === 'differences') {
            let q = supabase.from('difference_reports').select('*');
            if (from_date) q = q.gte('created_at', from_date);
            const { data: d } = await q.order('created_at', { ascending: false }).limit(500);
            data = d || [];
            title = 'DIFFERENCE REPORT';
        } else if (module === 'vehicles') {
            let q = supabase.from('vehicles').select('*');
            if (from_date) q = q.gte('created_at', from_date);
            const { data: d } = await q.order('created_at', { ascending: false }).limit(500);
            data = d || [];
            title = 'VEHICLE REPORT';
        } else if (module === 'materials') {
            const { data: d } = await supabase.from('material_master').select('*').eq('is_active', true).limit(500);
            data = d || [];
            title = 'MATERIAL MASTER REPORT';
        } else {
            return res.status(400).json({ error: 'Invalid module for PDF' });
        }

        const filename = module + '_report.pdf';
        const filePath = path.join(UPLOAD_DIR, 'exports', filename);
        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        // Header
        doc.fontSize(18).font('Helvetica-Bold').text(title, { align: 'center' });
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica').text('Generated: ' + new Date().toLocaleString(), { align: 'center' });
        if (from_date || to_date) {
            doc.text('Period: ' + (from_date || 'All') + ' to ' + (to_date || 'All'), { align: 'center' });
        }
        doc.moveDown(1);

        // Table
        let y = doc.y;
        const colWidths = module === 'location'
            ? [60, 70, 80, 60, 50, 50, 50]
            : [100, 120, 80, 80, 80];
        const headers = module === 'location'
            ? ['Date', 'Rack', 'Material', 'EAN', 'Packing', 'Qty', 'Action']
            : ['ID/Number', 'Name', 'Status', 'Qty', 'Date'];

        // Header row
        doc.fontSize(7).font('Helvetica-Bold');
        let x = 40;
        headers.forEach((h, i) => {
            doc.rect(x, y, colWidths[i], 16).fill('#1a1a2e').stroke();
            doc.fillColor('#fff').text(h, x + 2, y + 4, { width: colWidths[i] - 4, align: 'left' });
            x += colWidths[i];
        });
        doc.fillColor('#000');
        y += 16;

        // Data rows
        doc.font('Helvetica').fontSize(6.5);
        data.forEach((row, idx) => {
            if (y > 750) {
                doc.addPage();
                y = 40;
            }
            let cells;
            if (module === 'location') {
                cells = [
                    (row.action_date || '').split('T')[0],
                    row.rack_code || '', row.material_name || '',
                    row.ean || '', row.packing || '',
                    String(row.quantity || ''), row.action_type || ''
                ];
            } else if (module === 'picking') {
                cells = [
                    row.report_number || '', row.picker_name || '',
                    row.status || '', String(row.total_items || ''),
                    (row.created_at || '').split('T')[0]
                ];
            } else if (module === 'differences') {
                cells = [
                    row.diff_number || '', row.material_name || '',
                    row.status || '', String(row.difference_qty || ''),
                    (row.created_at || '').split('T')[0]
                ];
            } else if (module === 'vehicles') {
                cells = [
                    row.vehicle_number || '', row.driver_name || '',
                    row.status || '', '',
                    (row.created_at || '').split('T')[0]
                ];
            } else {
                cells = [
                    row.material_code || '', row.material_name || '',
                    String(row.current_stock || 0), row.unit || '',
                    ''
                ];
            }

            x = 40;
            const bgColor = idx % 2 === 0 ? '#f8f9fa' : '#ffffff';
            cells.forEach((cell, i) => {
                doc.rect(x, y, colWidths[i], 14).fill(bgColor).stroke('#dee2e6');
                doc.fillColor('#000').text(String(cell).substring(0, 30), x + 2, y + 3, { width: colWidths[i] - 4 });
                x += colWidths[i];
            });
            y += 14;
        });

        // Footer
        doc.fontSize(8).text('Total Records: ' + data.length, 40, y + 10);
        doc.end();

        stream.on('finish', () => {
            res.download(filePath, filename);
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'PDF export failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// QR CODE GENERATION
// ═══════════════════════════════════════════════════════════

app.get('/api/qrcode/:data', authMiddleware, async (req, res) => {
    try {
        const qrData = decodeURIComponent(req.params.data);
        const qrPng = await QRCode.toBuffer(qrData, { width: 200, margin: 1 });
        res.type('png').send(qrPng);
    } catch (err) {
        res.status(500).json({ error: 'QR generation failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// AI ASSISTANT ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/ai/search', authMiddleware, async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Query required' });
        const q = sanitize(query);

        // Smart material search
        const { data: materials } = await supabase
            .from('material_master')
            .select('*')
            .or(`material_name.ilike.%${q}%,ean.ilike.%${q}%,brand.ilike.%${q}%,description.ilike.%${q}%,material_code.ilike.%${q}%`)
            .eq('is_active', true)
            .limit(10);

        // Location search
        const { data: locations } = await supabase
            .from('location_master')
            .select('rack_code, material_name, ean, quantity, action_date')
            .or(`material_name.ilike.%${q}%,ean.ilike.%${q}%,rack_code.ilike.%${q}%`)
            .order('action_date', { ascending: false })
            .limit(10);

        // Vehicle search
        const { data: vehicles } = await supabase
            .from('vehicles')
            .select('vehicle_number, driver_name, status, gate_entry_time')
            .or(`vehicle_number.ilike.%${q}%,driver_name.ilike.%${q}%,lr_number.ilike.%${q}%`)
            .order('created_at', { ascending: false })
            .limit(5);

        // Rack suggestion
        let rackSuggestion = null;
        if (materials && materials.length) {
            const ean = materials[0].ean;
            if (ean) {
                const { data: lastLoc } = await supabase
                    .from('location_master')
                    .select('rack_code')
                    .eq('ean', ean)
                    .order('action_date', { ascending: false })
                    .limit(1)
                    .single();
                if (lastLoc) rackSuggestion = lastLoc.rack_code;
                // Find empty rack in same zone if no history
                if (!rackSuggestion) {
                    const { data: emptyRack } = await supabase
                        .from('rack_master')
                        .select('rack_code')
                        .eq('status', 'Empty')
                        .eq('is_active', true)
                        .limit(1)
                        .single();
                    if (emptyRack) rackSuggestion = emptyRack.rack_code + ' (Empty - Auto Suggested)';
                }
            }
        }

        // Duplicate detection
        let duplicates = [];
        if (materials && materials.length > 1) {
            duplicates = materials.slice(1).map(m => ({
                code: m.material_code, name: m.material_name, ean: m.ean
            }));
        }

        res.json({
            materials: materials || [],
            locations: locations || [],
            vehicles: vehicles || [],
            rack_suggestion: rackSuggestion,
            duplicates,
            query: q
        });
    } catch (err) {
        res.status(500).json({ error: 'AI search failed' });
    }
});

app.post('/api/ai/suggest-rack', authMiddleware, async (req, res) => {
    try {
        const { ean, material_name, zone } = req.body;

        // Find last rack for this material
        if (ean) {
            const { data: lastLoc } = await supabase
                .from('location_master')
                .select('rack_code')
                .eq('ean', ean)
                .order('action_date', { ascending: false })
                .limit(1)
                .single();
            if (lastLoc) {
                return res.json({ suggestion: lastLoc.rack_code, reason: 'Last used rack for this EAN' });
            }
        }

        // Find empty rack in preferred zone
        let q = supabase.from('rack_master').select('rack_code, zone, capacity').eq('status', 'Empty').eq('is_active', true);
        if (zone) q = q.eq('zone', zone);
        const { data: emptyRacks } = await q.order('rack_code').limit(5);
        if (emptyRacks && emptyRacks.length) {
            return res.json({ suggestion: emptyRacks[0].rack_code, reason: `Empty rack available in ${zone || 'default'} zone`, alternatives: emptyRacks.slice(1).map(r => r.rack_code) });
        }

        // Find rack with minimum load
        const { data: lowLoad } = await supabase
            .from('rack_master')
            .select('rack_code, zone, current_load, capacity')
            .eq('is_active', true)
            .order('current_load', { ascending: true })
            .limit(5);
        if (lowLoad && lowLoad.length) {
            return res.json({ suggestion: lowLoad[0].rack_code, reason: 'Rack with minimum load', alternatives: lowLoad.slice(1).map(r => r.rack_code) });
        }

        res.json({ suggestion: null, reason: 'No racks available' });
    } catch (err) {
        res.status(500).json({ error: 'Rack suggestion failed' });
    }
});

app.post('/api/ai/stock-verify', authMiddleware, async (req, res) => {
    try {
        const { ean, expected_qty, rack_code } = req.body;
        if (!ean) return res.status(400).json({ error: 'EAN required' });

        const { data: material } = await supabase.from('material_master').select('*').eq('ean', ean).single();
        if (!material) return res.json({ found: false, message: 'Material not found in master' });

        const { data: locations } = await supabase
            .from('location_master')
            .select('rack_code, quantity, action_date')
            .eq('ean', ean);
        const totalInRacks = (locations || []).reduce((s, l) => s + (l.quantity || 0), 0);

        const discrepancy = material.current_stock !== totalInRacks;

        res.json({
            found: true,
            material: material.material_name,
            master_stock: material.current_stock,
            rack_total: totalInRacks,
            discrepancy,
            locations: locations || [],
            message: discrepancy ? 'Stock discrepancy detected! Master does not match rack total.' : 'Stock verified. No discrepancy.'
        });
    } catch (err) {
        res.status(500).json({ error: 'Stock verification failed' });
    }
});

app.post('/api/ai/chat', authMiddleware, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: 'Message required' });
        const msg = message.toLowerCase();
        let reply = '';

        // Smart responses based on keywords
        if (msg.includes('pending') && msg.includes('unload')) {
            const { count } = await supabase.from('vehicles').select('*', { count: 'exact', head: true }).eq('status', 'Pending Unload');
            reply = `There are ${count || 0} vehicles waiting for unload.`;
        } else if (msg.includes('empty') && msg.includes('rack')) {
            const { count } = await supabase.from('rack_master').select('*', { count: 'exact', head: true }).eq('status', 'Empty');
            reply = `There are ${count || 0} empty racks available.`;
        } else if (msg.includes('low stock') || msg.includes('shortage')) {
            const { data } = await supabase.from('material_master').select('material_name, current_stock, min_stock').lt('current_stock', 'min_stock').limit(5);
            if (data && data.length) {
                reply = 'Low stock items: ' + data.map(d => `${d.material_name} (${d.current_stock}/${d.min_stock})`).join(', ');
            } else {
                reply = 'No low stock items found. All materials are above minimum stock level.';
            }
        } else if (msg.includes('today') && msg.includes('putaway')) {
            const today = new Date().toISOString().split('T')[0];
            const { count } = await supabase.from('location_master').select('*', { count: 'exact', head: true }).eq('action_type', 'PUTAWAY').gte('action_date', today);
            reply = `${count || 0} putaway operations completed today.`;
        } else if (msg.includes('today') && msg.includes('picking')) {
            const today = new Date().toISOString().split('T')[0];
            const { count } = await supabase.from('picking_reports').select('*', { count: 'exact', head: true }).gte('created_at', today);
            reply = `${count || 0} picking reports generated today.`;
        } else if (msg.includes('difference') || msg.includes('discrepancy')) {
            const today = new Date().toISOString().split('T')[0];
            const { count } = await supabase.from('difference_reports').select('*', { count: 'exact', head: true }).gte('created_at', today);
            reply = `${count || 0} quantity differences reported today.`;
        } else if (msg.includes('total') && msg.includes('material')) {
            const { count } = await supabase.from('material_master').select('*', { count: 'exact', head: true }).eq('is_active', true);
            reply = `Total ${count || 0} active materials in the system.`;
        } else if (msg.includes('help') || msg.includes('what can')) {
            reply = 'I can help with: pending unloads, empty racks, low stock, today\'s putaway, today\'s picking, differences, total materials, stock verification, and material search. Just ask!';
        } else {
            // Try to search material
            const { data: materials } = await supabase
                .from('material_master')
                .select('material_name, ean, current_stock, unit')
                .or(`material_name.ilike.%${sanitize(message)}%,ean.ilike.%${sanitize(message)}%`)
                .eq('is_active', true)
                .limit(5);
            if (materials && materials.length) {
                reply = 'Found materials: ' + materials.map(m => `${m.material_name} (Stock: ${m.current_stock} ${m.unit})`).join(' | ');
            } else {
                reply = 'I didn\'t understand that. Try asking about pending unloads, empty racks, low stock, or search for a material by name or EAN.';
            }
        }

        res.json({ reply, message });
    } catch (err) {
        res.status(500).json({ error: 'AI chat failed' });
    }
});

// ═══════════════════════════════════════════════════════════
// FILE UPLOAD ROUTE (General)
// ═══════════════════════════════════════════════════════════

app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ url: `/uploads/${req.file.destination.split('/').pop()}/${req.file.filename}`, filename: req.file.filename });
});

// ═══════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ─── 404 ─────────────────────────────────────────────────
app.use('/api/', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});

// ─── START SERVER ────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════════╗
    ║   Enterprise WMS Backend Running          ║
    ║   Port: ${PORT}                            ║
    ║   Env: ${process.env.NODE_ENV || 'development'}                       ║
    ║   Time: ${new Date().toLocaleString()}    ║
    ╚══════════════════════════════════════════╝
    `);
});

module.exports = app;