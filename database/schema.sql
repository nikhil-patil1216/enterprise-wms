-- =============================================
-- ENTERPRISE WMS - COMPLETE DATABASE SCHEMA
-- Supabase PostgreSQL
-- =============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- =============================================
-- 1. ROLES & PERMISSIONS
-- =============================================
CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    level INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO roles (name, description, level) VALUES
('Super Admin', 'Full system access', 100),
('Admin', 'Administrative access', 90),
('Warehouse Manager', 'Warehouse operations management', 80),
('Supervisor', 'Team supervision', 70),
('Operator', 'Daily operations', 50),
('Auditor', 'Read-only audit access', 30),
('Viewer', 'Read-only access', 10);

CREATE TABLE permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    module VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO permissions (code, name, module) VALUES
('dashboard.view', 'View Dashboard', 'dashboard'),
('vehicles.create', 'Create Vehicle Entry', 'inbound'),
('vehicles.edit', 'Edit Vehicle Entry', 'inbound'),
('vehicles.delete', 'Delete Vehicle Entry', 'inbound'),
('vehicles.view', 'View Vehicle Entry', 'inbound'),
('invoices.create', 'Create Invoice', 'inbound'),
('invoices.edit', 'Edit Invoice', 'inbound'),
('invoices.delete', 'Delete Invoice', 'inbound'),
('invoices.view', 'View Invoice', 'inbound'),
('unload.perform', 'Perform Unload', 'inbound'),
('unload.view', 'View Unload Records', 'inbound'),
('putaway.perform', 'Perform Putaway', 'putaway'),
('putaway.view', 'View Putaway Records', 'putaway'),
('piv.perform', 'Perform PIV', 'piv'),
('piv.view', 'View PIV Records', 'piv'),
('location.view', 'View Location Master', 'location'),
('location.edit', 'Edit Location Master', 'location'),
('location.delete', 'Delete Location Master', 'location'),
('location.export', 'Export Location Master', 'location'),
('picking.create', 'Create Picking Report', 'picking'),
('picking.view', 'View Picking Reports', 'picking'),
('picking.edit', 'Edit Picking Report', 'picking'),
('picking.delete', 'Delete Picking Report', 'picking'),
('rack.create', 'Create Rack', 'rack'),
('rack.edit', 'Edit Rack', 'rack'),
('rack.delete', 'Delete Rack', 'rack'),
('rack.view', 'View Rack Master', 'rack'),
('material.create', 'Create Material', 'material'),
('material.edit', 'Edit Material', 'material'),
('material.delete', 'Delete Material', 'material'),
('material.view', 'View Material Master', 'material'),
('material.scan', 'Scan Material', 'material'),
('users.create', 'Create User', 'users'),
('users.edit', 'Edit User', 'users'),
('users.delete', 'Deactivate User', 'users'),
('users.view', 'View Users', 'users'),
('users.reset_pwd', 'Reset Password', 'users'),
('reports.view', 'View Reports', 'reports'),
('reports.export', 'Export Reports', 'reports'),
('reports.email', 'Email Reports', 'reports'),
('audit.view', 'View Audit Log', 'audit'),
('settings.view', 'View Settings', 'settings'),
('settings.edit', 'Edit Settings', 'settings'),
('scanner.use', 'Use Scanner', 'scanner'),
('camera.use', 'Use Camera', 'camera'),
('mobile.access', 'Mobile Access', 'mobile'),
('upload.bulk', 'Bulk Upload', 'upload'),
('download.data', 'Download Data', 'download'),
('delete.data', 'Delete Data', 'delete'),
('ai.assistant', 'AI Assistant', 'ai'),
('notifications.view', 'View Notifications', 'notifications');

CREATE TABLE role_permissions (
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- Super Admin gets all permissions
INSERT INTO role_permissions
SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'Super Admin';

-- Admin gets most permissions
INSERT INTO role_permissions
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Admin' AND p.code NOT IN ('settings.edit', 'users.create', 'users.delete');

-- Warehouse Manager
INSERT INTO role_permissions
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Warehouse Manager'
AND p.module IN ('dashboard','inbound','putaway','piv','location','picking','rack','material','reports','scanner','camera','mobile','upload','download','ai','notifications');

-- Supervisor
INSERT INTO role_permissions
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Supervisor'
AND p.code IN ('dashboard.view','vehicles.create','vehicles.view','invoices.create','invoices.view','unload.perform','unload.view','putaway.perform','putaway.view','piv.perform','piv.view','location.view','picking.create','picking.view','picking.edit','rack.view','material.view','material.scan','reports.view','scanner.use','camera.use','mobile.access','notifications.view','ai.assistant');

-- Operator
INSERT INTO role_permissions
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Operator'
AND p.code IN ('dashboard.view','vehicles.create','vehicles.view','invoices.create','invoices.view','unload.perform','putaway.perform','piv.perform','location.view','material.view','material.scan','scanner.use','camera.use','mobile.access','notifications.view');

-- Auditor
INSERT INTO role_permissions
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Auditor'
AND p.code IN ('dashboard.view','vehicles.view','invoices.view','unload.view','putaway.view','piv.view','location.view','picking.view','rack.view','material.view','reports.view','reports.export','audit.view');

-- Viewer
INSERT INTO role_permissions
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Viewer'
AND p.code IN ('dashboard.view','vehicles.view','invoices.view','location.view','material.view','rack.view','reports.view');

-- =============================================
-- 2. USERS
-- =============================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(200) NOT NULL,
    phone VARCHAR(20),
    role_id UUID REFERENCES roles(id),
    avatar TEXT,
    is_active BOOLEAN DEFAULT true,
    is_locked BOOLEAN DEFAULT false,
    failed_login_count INTEGER DEFAULT 0,
    force_password_change BOOLEAN DEFAULT false,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role_id);
CREATE INDEX idx_users_active ON users(is_active);

-- Default Super Admin (password: Admin@123)
INSERT INTO users (username, email, password_hash, full_name, role_id, force_password_change)
VALUES (
    'admin',
    'admin@wms.com',
    crypt('Admin@123', gen_salt('bf')),
    'System Administrator',
    (SELECT id FROM roles WHERE name = 'Super Admin'),
    false
);

-- =============================================
-- 3. LOGIN HISTORY
-- =============================================
CREATE TABLE login_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ip_address VARCHAR(50),
    user_agent TEXT,
    device_type VARCHAR(50),
    login_time TIMESTAMPTZ DEFAULT NOW(),
    logout_time TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'success',
    failure_reason TEXT
);

CREATE INDEX idx_login_history_user ON login_history(user_id);
CREATE INDEX idx_login_history_time ON login_history(login_time);

-- =============================================
-- 4. VEHICLES
-- =============================================
CREATE TABLE vehicles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vehicle_number VARCHAR(50) NOT NULL,
    lr_number VARCHAR(100),
    driver_name VARCHAR(200) NOT NULL,
    driver_mobile VARCHAR(10) CHECK (driver_mobile ~ '^[0-9]{10}$'),
    transport_name VARCHAR(200),
    gate_entry_time TIMESTAMPTZ DEFAULT NOW(),
    dock_number VARCHAR(50),
    vehicle_photo TEXT,
    driver_photo TEXT,
    remarks TEXT,
    status VARCHAR(30) DEFAULT 'Pending Unload',
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_vehicles_number ON vehicles(vehicle_number);
CREATE INDEX idx_vehicles_status ON vehicles(status);
CREATE INDEX idx_vehicles_date ON vehicles(created_at);
CREATE INDEX idx_vehicles_lr ON vehicles(lr_number);

-- =============================================
-- 5. INVOICES
-- =============================================
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vehicle_id UUID REFERENCES vehicles(id) ON DELETE CASCADE,
    invoice_number VARCHAR(100) NOT NULL,
    invoice_date DATE NOT NULL,
    vendor VARCHAR(300) NOT NULL,
    purchase_order VARCHAR(100),
    invoice_file TEXT,
    status VARCHAR(30) DEFAULT 'Pending',
    unload_status VARCHAR(30) DEFAULT 'Pending',
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(vehicle_id, invoice_number)
);

CREATE INDEX idx_invoices_vehicle ON invoices(vehicle_id);
CREATE INDEX idx_invoices_number ON invoices(invoice_number);
CREATE INDEX idx_invoices_vendor ON invoices(vendor);
CREATE INDEX idx_invoices_status ON invoices(status);

-- =============================================
-- 6. INVOICE MATERIALS
-- =============================================
CREATE TABLE invoice_materials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
    ean VARCHAR(100),
    material_name VARCHAR(300) NOT NULL,
    description TEXT,
    brand VARCHAR(200),
    division VARCHAR(100),
    packing VARCHAR(100),
    unit VARCHAR(50) DEFAULT 'PCS',
    invoice_qty DECIMAL(15,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_inv_mat_invoice ON invoice_materials(invoice_id);
CREATE INDEX idx_inv_mat_ean ON invoice_materials(ean);
CREATE INDEX idx_inv_mat_material ON invoice_materials(material_name);

-- =============================================
-- 7. UNLOAD RECORDS
-- =============================================
CREATE TABLE unload_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vehicle_id UUID REFERENCES vehicles(id) ON DELETE CASCADE,
    invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
    invoice_material_id UUID REFERENCES invoice_materials(id) ON DELETE SET NULL,
    ean VARCHAR(100),
    material_name VARCHAR(300) NOT NULL,
    invoice_qty DECIMAL(15,2) NOT NULL,
    unloaded_qty DECIMAL(15,2) NOT NULL,
    difference_qty DECIMAL(15,2) GENERATED ALWAYS AS (invoice_qty - unloaded_qty) STORED,
    difference_pct DECIMAL(5,2) GENERATED ALWAYS AS (
        CASE WHEN invoice_qty > 0 THEN ROUND(((invoice_qty - unloaded_qty) / invoice_qty) * 100, 2) ELSE 0 END
    ) STORED,
    difference_reason TEXT,
    approval_status VARCHAR(30) DEFAULT 'Pending',
    approved_by UUID REFERENCES users(id),
    scan_method VARCHAR(50) DEFAULT 'manual',
    unloaded_by UUID REFERENCES users(id),
    unloaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_unload_vehicle ON unload_records(vehicle_id);
CREATE INDEX idx_unload_invoice ON unload_records(invoice_id);
CREATE INDEX idx_unload_ean ON unload_records(ean);
CREATE INDEX idx_unload_status ON unload_records(approval_status);
CREATE INDEX idx_unload_date ON unload_records(unloaded_at);

-- =============================================
-- 8. DIFFERENCE REPORTS
-- =============================================
CREATE TABLE difference_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    diff_number VARCHAR(50) UNIQUE NOT NULL,
    vehicle_id UUID REFERENCES vehicles(id),
    invoice_id UUID REFERENCES invoices(id),
    unload_record_id UUID REFERENCES unload_records(id),
    ean VARCHAR(100),
    material_name VARCHAR(300),
    invoice_qty DECIMAL(15,2),
    received_qty DECIMAL(15,2),
    difference_qty DECIMAL(15,2),
    difference_pct DECIMAL(5,2),
    reason TEXT,
    status VARCHAR(30) DEFAULT 'Pending',
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_diff_vehicle ON difference_reports(vehicle_id);
CREATE INDEX idx_diff_number ON difference_reports(diff_number);
CREATE INDEX idx_diff_status ON difference_reports(status);

-- =============================================
-- 9. RACK MASTER
-- =============================================
CREATE TABLE rack_master (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rack_code VARCHAR(50) UNIQUE NOT NULL,
    rack_type VARCHAR(50) DEFAULT 'Standard',
    zone VARCHAR(50),
    warehouse VARCHAR(100),
    capacity DECIMAL(10,2) DEFAULT 0,
    current_load DECIMAL(10,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'Empty',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_rack_code ON rack_master(rack_code);
CREATE INDEX idx_rack_zone ON rack_master(zone);
CREATE INDEX idx_rack_status ON rack_master(status);

-- =============================================
-- 10. MATERIAL MASTER
-- =============================================
CREATE TABLE material_master (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    material_code VARCHAR(100) UNIQUE NOT NULL,
    material_name VARCHAR(300) NOT NULL,
    description TEXT,
    ean VARCHAR(100) UNIQUE,
    brand VARCHAR(200),
    division VARCHAR(100),
    packing VARCHAR(100),
    unit VARCHAR(50) DEFAULT 'PCS',
    weight DECIMAL(10,3),
    min_stock DECIMAL(15,2) DEFAULT 0,
    current_stock DECIMAL(15,2) DEFAULT 0,
    image TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_mat_code ON material_master(material_code);
CREATE INDEX idx_mat_ean ON material_master(ean);
CREATE INDEX idx_mat_name ON material_master(material_name);
CREATE INDEX idx_mat_brand ON material_master(brand);
CREATE INDEX idx_mat_division ON material_master(division);
CREATE INDEX idx_mat_stock ON material_master(current_stock);

-- =============================================
-- 11. LOCATION MASTER
-- =============================================
CREATE TABLE location_master (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rack_code VARCHAR(50) NOT NULL,
    ean VARCHAR(100),
    material_name VARCHAR(300) NOT NULL,
    description TEXT,
    brand VARCHAR(200),
    division VARCHAR(100),
    packing VARCHAR(100),
    box_number VARCHAR(100),
    quantity DECIMAL(15,2) NOT NULL DEFAULT 0,
    action_type VARCHAR(30) NOT NULL,
    user_id UUID REFERENCES users(id),
    action_date TIMESTAMPTZ DEFAULT NOW(),
    invoice_id UUID REFERENCES invoices(id),
    vehicle_id UUID REFERENCES vehicles(id)
);

CREATE INDEX idx_loc_rack ON location_master(rack_code);
CREATE INDEX idx_loc_ean ON location_master(ean);
CREATE INDEX idx_loc_material ON location_master(material_name);
CREATE INDEX idx_loc_action ON location_master(action_type);
CREATE INDEX idx_loc_date ON location_master(action_date);
CREATE INDEX idx_loc_brand ON location_master(brand);
CREATE INDEX idx_loc_division ON location_master(division);

-- =============================================
-- 12. PIV RECORDS
-- =============================================
CREATE TABLE piv_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ean VARCHAR(100),
    material_name VARCHAR(300) NOT NULL,
    description TEXT,
    packing VARCHAR(100),
    box_number VARCHAR(100),
    quantity DECIMAL(15,2) NOT NULL,
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_piv_ean ON piv_records(ean);
CREATE INDEX idx_piv_material ON piv_records(material_name);
CREATE INDEX idx_piv_date ON piv_records(created_at);

-- =============================================
-- 13. PICKING REPORTS
-- =============================================
CREATE TABLE picking_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    report_number VARCHAR(50) UNIQUE NOT NULL,
    picker_name VARCHAR(200) NOT NULL,
    status VARCHAR(30) DEFAULT 'Open',
    total_items INTEGER DEFAULT 0,
    total_qty DECIMAL(15,2) DEFAULT 0,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pick_number ON picking_reports(report_number);
CREATE INDEX idx_pick_status ON picking_reports(status);
CREATE INDEX idx_pick_picker ON picking_reports(picker_name);
CREATE INDEX idx_pick_date ON picking_reports(created_at);

-- =============================================
-- 14. PICKING REPORT ITEMS
-- =============================================
CREATE TABLE picking_report_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    report_id UUID REFERENCES picking_reports(id) ON DELETE CASCADE,
    ean VARCHAR(100),
    material_name VARCHAR(300) NOT NULL,
    description TEXT,
    rack_code VARCHAR(50),
    required_qty DECIMAL(15,2) NOT NULL,
    picked_qty DECIMAL(15,2) DEFAULT 0,
    status VARCHAR(30) DEFAULT 'Pending'
);

CREATE INDEX idx_pri_report ON picking_report_items(report_id);
CREATE INDEX idx_pri_ean ON picking_report_items(ean);

-- =============================================
-- 15. PICK MATERIAL HISTORY (AUDIT FOR PICKING)
-- =============================================
CREATE TABLE pick_material_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    action_number VARCHAR(50) UNIQUE NOT NULL,
    report_id UUID REFERENCES picking_reports(id),
    item_id UUID REFERENCES picking_report_items(id),
    ean VARCHAR(100),
    material_name VARCHAR(300),
    action_type VARCHAR(30) NOT NULL,
    old_qty DECIMAL(15,2),
    new_qty DECIMAL(15,2),
    old_rack VARCHAR(50),
    new_rack VARCHAR(50),
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pmh_action ON pick_material_history(action_number);
CREATE INDEX idx_pmh_report ON pick_material_history(report_id);
CREATE INDEX idx_pmh_date ON pick_material_history(created_at);

-- =============================================
-- 16. AUDIT LOG
-- =============================================
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    action_number VARCHAR(50) UNIQUE NOT NULL,
    module VARCHAR(50) NOT NULL,
    action VARCHAR(50) NOT NULL,
    table_name VARCHAR(100),
    record_id UUID,
    old_value JSONB,
    new_value JSONB,
    user_id UUID REFERENCES users(id),
    ip_address VARCHAR(50),
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_module ON audit_log(module);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_user ON audit_log(user_id);
CREATE INDEX idx_audit_date ON audit_log(created_at);
CREATE INDEX idx_audit_number ON audit_log(action_number);
CREATE INDEX idx_audit_record ON audit_log(record_id);

-- =============================================
-- 17. NOTIFICATIONS
-- =============================================
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(300) NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'info',
    module VARCHAR(50),
    reference_id UUID,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notif_user ON notifications(user_id);
CREATE INDEX idx_notif_read ON notifications(is_read);
CREATE INDEX idx_notif_date ON notifications(created_at);

-- =============================================
-- 18. SETTINGS
-- =============================================
CREATE TABLE settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key VARCHAR(100) UNIQUE NOT NULL,
    value TEXT,
    type VARCHAR(30) DEFAULT 'string',
    category VARCHAR(50) DEFAULT 'general',
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO settings (key, value, type, category) VALUES
('company_name', 'Enterprise WMS', 'string', 'general'),
('company_logo', '', 'string', 'general'),
('theme', 'dark', 'string', 'general'),
('session_timeout', '30', 'number', 'security'),
('max_failed_logins', '5', 'number', 'security'),
('password_min_length', '8', 'number', 'security'),
('password_require_uppercase', 'true', 'boolean', 'security'),
('password_require_number', 'true', 'boolean', 'security'),
('password_require_special', 'true', 'boolean', 'security'),
('smtp_host', '', 'string', 'email'),
('smtp_port', '587', 'number', 'email'),
('smtp_user', '', 'string', 'email'),
('smtp_pass', '', 'string', 'email'),
('smtp_from', '', 'string', 'email'),
('scanner_type', 'usb', 'string', 'scanner'),
('camera_facing', 'environment', 'string', 'camera'),
('low_stock_threshold', '10', 'number', 'warehouse'),
('warehouse_name', 'Main Warehouse', 'string', 'warehouse'),
('auto_suggest_rack', 'true', 'boolean', 'ai'),
('ai_assistant', 'true', 'boolean', 'ai');

-- =============================================
-- 19. SEQUENCES
-- =============================================
CREATE SEQUENCE diff_number_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE pick_number_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE audit_number_seq START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE pick_history_number_seq START WITH 1 INCREMENT BY 1;

-- =============================================
-- 20. FUNCTIONS & TRIGGERS
-- =============================================

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
 $$ LANGUAGE plpgsql;

CREATE TRIGGER tr_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_vehicles_updated BEFORE UPDATE ON vehicles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_invoices_updated BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_rack_updated BEFORE UPDATE ON rack_master
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_material_updated BEFORE UPDATE ON material_master
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_picking_updated BEFORE UPDATE ON picking_reports
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_settings_updated BEFORE UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-update material stock from location master
CREATE OR REPLACE FUNCTION update_material_stock()
RETURNS TRIGGER AS $$ BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE material_master
        SET current_stock = current_stock + NEW.quantity
        WHERE ean = NEW.ean;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE material_master
        SET current_stock = GREATEST(0, current_stock - OLD.quantity)
        WHERE ean = OLD.ean;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
 $$ LANGUAGE plpgsql;

CREATE TRIGGER tr_location_stock AFTER INSERT OR DELETE ON location_master
    FOR EACH ROW EXECUTE FUNCTION update_material_stock();

-- Update rack status based on location master
CREATE OR REPLACE FUNCTION update_rack_status()
RETURNS TRIGGER AS $$ DECLARE
    total DECIMAL;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT COALESCE(SUM(quantity), 0) INTO total
        FROM location_master WHERE rack_code = NEW.rack_code;
        UPDATE rack_master
        SET current_load = total,
            status = CASE WHEN total > 0 THEN 'Occupied' ELSE 'Empty' END
        WHERE rack_code = NEW.rack_code;
    ELSIF TG_OP = 'DELETE' THEN
        SELECT COALESCE(SUM(quantity), 0) INTO total
        FROM location_master WHERE rack_code = OLD.rack_code;
        UPDATE rack_master
        SET current_load = total,
            status = CASE WHEN total > 0 THEN 'Occupied' ELSE 'Empty' END
        WHERE rack_code = OLD.rack_code;
    END IF;
    RETURN NULL;
END;
 $$ LANGUAGE plpgsql;

CREATE TRIGGER tr_rack_load AFTER INSERT OR DELETE ON location_master
    FOR EACH ROW EXECUTE FUNCTION update_rack_status();

-- Auto-check vehicle unload completion
CREATE OR REPLACE FUNCTION check_vehicle_unload_complete()
RETURNS TRIGGER AS $$ DECLARE
    all_done BOOLEAN;
    veh_id UUID;
BEGIN
    veh_id := NEW.vehicle_id;
    SELECT NOT EXISTS (
        SELECT 1 FROM invoices WHERE vehicle_id = veh_id AND unload_status != 'Completed'
    ) INTO all_done;
    IF all_done THEN
        UPDATE vehicles SET status = 'Unloaded' WHERE id = veh_id;
    END IF;
    RETURN NULL;
END;
 $$ LANGUAGE plpgsql;

CREATE TRIGGER tr_check_unload AFTER UPDATE ON invoices
    FOR EACH ROW
    WHEN (NEW.unload_status = 'Completed' AND OLD.unload_status != 'Completed')
    EXECUTE FUNCTION check_vehicle_unload_complete();

-- Generate audit number
CREATE OR REPLACE FUNCTION get_audit_number()
RETURNS VARCHAR AS $$ BEGIN
    RETURN 'AUD-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(nextval('audit_number_seq')::TEXT, 5, '0');
END;
 $$ LANGUAGE plpgsql;

-- Generate diff number
CREATE OR REPLACE FUNCTION get_diff_number()
RETURNS VARCHAR AS $$ BEGIN
    RETURN 'DIF-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(nextval('diff_number_seq')::TEXT, 5, '0');
END;
 $$ LANGUAGE plpgsql;

-- Generate pick number
CREATE OR REPLACE FUNCTION get_pick_number()
RETURNS VARCHAR AS $$ BEGIN
    RETURN 'PCK-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(nextval('pick_number_seq')::TEXT, 5, '0');
END;
 $$ LANGUAGE plpgsql;

-- Generate pick history action number
CREATE OR REPLACE FUNCTION get_pick_history_number()
RETURNS VARCHAR AS $$ BEGIN
    RETURN 'PHA-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(nextval('pick_history_number_seq')::TEXT, 5, '0');
END;
 $$ LANGUAGE plpgsql;

-- =============================================
-- 21. VIEWS FOR DASHBOARD
-- =============================================

CREATE OR REPLACE VIEW v_dashboard_stats AS
SELECT
    (SELECT COUNT(*) FROM vehicles WHERE DATE(created_at) = CURRENT_DATE) AS total_vehicles_today,
    (SELECT COUNT(*) FROM vehicles WHERE status = 'Pending Unload') AS vehicles_waiting,
    (SELECT COUNT(*) FROM invoices WHERE unload_status = 'Pending') AS pending_unload,
    (SELECT COUNT(*) FROM location_master WHERE action_type = 'PUTAWAY' AND DATE(action_date) = CURRENT_DATE) AS today_putaway,
    (SELECT COUNT(*) FROM piv_records WHERE DATE(created_at) = CURRENT_DATE) AS today_piv,
    (SELECT COUNT(*) FROM picking_reports WHERE DATE(created_at) = CURRENT_DATE) AS today_picking,
    (SELECT COUNT(*) FROM material_master WHERE is_active = true) AS total_material,
    (SELECT COUNT(*) FROM rack_master WHERE is_active = true) AS total_rack,
    (SELECT COUNT(*) FROM rack_master WHERE status = 'Occupied') AS occupied_rack,
    (SELECT COUNT(*) FROM rack_master WHERE status = 'Empty') AS empty_rack,
    (SELECT COUNT(*) FROM difference_reports WHERE DATE(created_at) = CURRENT_DATE) AS today_difference,
    (SELECT COUNT(*) FROM picking_reports WHERE DATE(created_at) = CURRENT_DATE) AS today_reports;

-- =============================================
-- 22. SEED DATA - SAMPLE RACKS
-- =============================================
INSERT INTO rack_master (rack_code, rack_type, zone, warehouse, capacity) VALUES
('A-01-01', 'Standard', 'Zone A', 'Main Warehouse', 500),
('A-01-02', 'Standard', 'Zone A', 'Main Warehouse', 500),
('A-01-03', 'Standard', 'Zone A', 'Main Warehouse', 500),
('A-02-01', 'Standard', 'Zone A', 'Main Warehouse', 500),
('A-02-02', 'Standard', 'Zone A', 'Main Warehouse', 500),
('B-01-01', 'Heavy Duty', 'Zone B', 'Main Warehouse', 1000),
('B-01-02', 'Heavy Duty', 'Zone B', 'Main Warehouse', 1000),
('B-02-01', 'Cold Storage', 'Zone B', 'Main Warehouse', 300),
('C-01-01', 'Standard', 'Zone C', 'Main Warehouse', 500),
('C-01-02', 'Standard', 'Zone C', 'Main Warehouse', 500),
('C-02-01', 'High Rise', 'Zone C', 'Main Warehouse', 800),
('D-01-01', 'Standard', 'Zone D', 'Main Warehouse', 500),
('D-01-02', 'Standard', 'Zone D', 'Main Warehouse', 500),
('D-02-01', 'Standard', 'Zone D', 'Main Warehouse', 500),
('E-01-01', 'Bulk', 'Zone E', 'Main Warehouse', 2000);

-- =============================================
-- 23. SEED DATA - SAMPLE MATERIALS
-- =============================================
INSERT INTO material_master (material_code, material_name, description, ean, brand, division, packing, unit, weight, min_stock) VALUES
('MAT-001', 'Premium Basmati Rice 5kg', 'Long grain basmati rice', '8901234567001', 'Tata', 'FMCG', '5 KG Bag', 'BAG', 5.0, 50),
('MAT-002', 'Refined Sunflower Oil 1L', 'Pure sunflower cooking oil', '8901234567002', 'Fortune', 'FMCG', '1 Ltr Bottle', 'LTR', 1.0, 100),
('MAT-003', 'Wheat Flour Atta 10kg', 'Whole wheat flour', '8901234567003', 'Aashirvaad', 'FMCG', '10 KG Bag', 'BAG', 10.0, 30),
('MAT-004', 'Toor Dal 2kg', 'Pigeon peas', '8901234567004', 'Tata', 'FMCG', '2 KG Pouch', 'PCS', 2.0, 40),
('MAT-005', 'Sugar 5kg', 'White crystal sugar', '8901234567005', 'Madhur', 'FMCG', '5 KG Bag', 'BAG', 5.0, 60),
('MAT-006', 'Salt 1kg', 'Iodized salt', '8901234567006', 'Tata', 'FMCG', '1 KG Pouch', 'PCS', 1.0, 80),
('MAT-007', 'Tea 500g', 'Premium tea leaves', '8901234567007', 'Tata Gold', 'FMCG', '500 GM Box', 'BOX', 0.5, 50),
('MAT-008', 'Soap Bar 150g', 'Bathing soap', '8901234567008', 'Dove', 'Personal Care', '150 GM Bar', 'PCS', 0.15, 100),
('MAT-009', 'Shampoo 500ml', 'Hair shampoo', '8901234567009', 'Head & Shoulders', 'Personal Care', '500 ML Bottle', 'PCS', 0.5, 80),
('MAT-010', 'Detergent Powder 1kg', 'Laundry detergent', '8901234567010', 'Surf Excel', 'Home Care', '1 KG Box', 'BOX', 1.0, 60);

-- =============================================
-- 24. SEED DATA - SAMPLE USERS
-- =============================================
INSERT INTO users (username, email, password_hash, full_name, phone, role_id) VALUES
('whmanager', 'whmanager@wms.com', crypt('Whm@1234', gen_salt('bf')), 'Rajesh Kumar', '9876543210', (SELECT id FROM roles WHERE name = 'Warehouse Manager')),
('supervisor1', 'supervisor1@wms.com', crypt('Sup@1234', gen_salt('bf')), 'Amit Sharma', '9876543211', (SELECT id FROM roles WHERE name = 'Supervisor')),
('operator1', 'operator1@wms.com', crypt('Opr@1234', gen_salt('bf')), 'Suresh Patel', '9876543212', (SELECT id FROM roles WHERE name = 'Operator')),
('auditor1', 'auditor1@wms.com', crypt('Aud@1234', gen_salt('bf')), 'Priya Singh', '9876543213', (SELECT id FROM roles WHERE name = 'Auditor'));

-- =============================================
-- 25. RL POLICIES FOR SUPABASE
-- =============================================

-- Enable RLS
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE unload_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE difference_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE rack_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE piv_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE picking_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE picking_report_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE pick_material_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- Service role full access (for backend)
CREATE POLICY "Service role full access" ON roles FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON permissions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON role_permissions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON users FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON login_history FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON vehicles FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON invoices FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON invoice_materials FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON unload_records FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON difference_reports FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON rack_master FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON material_master FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON location_master FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON piv_records FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON picking_reports FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON picking_report_items FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON pick_material_history FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON audit_log FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON notifications FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON settings FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- DONE! SCHEMA COMPLETE
-- =============================================