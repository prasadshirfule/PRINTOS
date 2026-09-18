-- ============================================================================
-- PRINTOS Database Schema Migration 00004: Multi-Shop / Multi-Tenancy Isolation
-- Target: PostgreSQL 15+ / Supabase
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. SHOPS TABLE (TENANT DEFINITION & METADATA)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    phone TEXT NULL,
    address TEXT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shops_slug ON shops(slug);
CREATE INDEX IF NOT EXISTS idx_shops_active ON shops(is_active);

-- ----------------------------------------------------------------------------
-- 2. SEED DEFAULT FLAGSHIP SHOP
-- ----------------------------------------------------------------------------
INSERT INTO shops (id, name, slug, phone, address, currency, is_active)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'PRINTOS Flagship Shop',
    'main-shop',
    '+919999999999',
    'Shop No. 1, Front Counter Hub',
    'INR',
    true
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    phone = EXCLUDED.phone,
    address = EXCLUDED.address;

-- ----------------------------------------------------------------------------
-- 3. ENSURE FOREIGN KEYS & BACKFILL SHOP_ID ON CORE TABLES
-- ----------------------------------------------------------------------------

-- Printers
ALTER TABLE printers ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE CASCADE;
UPDATE printers SET shop_id = '00000000-0000-0000-0000-000000000001' WHERE shop_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_printers_shop ON printers(shop_id, status);

-- Print Agents
ALTER TABLE print_agents ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE CASCADE;
UPDATE print_agents SET shop_id = '00000000-0000-0000-0000-000000000001' WHERE shop_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_print_agents_shop ON print_agents(shop_id, status);

-- Print Settings
ALTER TABLE print_settings ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE CASCADE;
UPDATE print_settings SET shop_id = '00000000-0000-0000-0000-000000000001' WHERE shop_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_print_settings_shop ON print_settings(shop_id);

-- Print Orders
ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE CASCADE;
UPDATE print_orders SET shop_id = '00000000-0000-0000-0000-000000000001' WHERE shop_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_print_orders_shop ON print_orders(shop_id, status, created_at DESC);

-- Print Jobs
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE CASCADE;
UPDATE print_jobs pj
SET shop_id = COALESCE(po.shop_id, '00000000-0000-0000-0000-000000000001')
FROM print_orders po
WHERE pj.order_id = po.id AND pj.shop_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_print_jobs_shop ON print_jobs(shop_id, status, priority DESC, created_at ASC);

-- WhatsApp Conversations
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE CASCADE;
UPDATE whatsapp_conversations SET shop_id = '00000000-0000-0000-0000-000000000001' WHERE shop_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_shop ON whatsapp_conversations(shop_id, customer_phone);

-- WhatsApp Inbox & Outbox
ALTER TABLE whatsapp_inbox ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_outbox ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbox_shop ON whatsapp_inbox(shop_id, status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_shop ON whatsapp_outbox(shop_id, status);

-- Payment Transactions
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_payment_transactions_shop ON payment_transactions(shop_id, provider, transaction_id);

-- ----------------------------------------------------------------------------
-- 4. TENANT-AWARE ATOMIC JOB CLAIMING STORED PROCEDURE
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_next_print_job(
    p_agent_id UUID,
    p_printer_id UUID DEFAULT NULL,
    p_shop_id UUID DEFAULT NULL
)
RETURNS TABLE (
    job_id UUID,
    order_id UUID,
    order_number TEXT,
    storage_path TEXT,
    original_filename TEXT,
    print_options JSONB,
    copies INT,
    paper_size TEXT,
    color_mode TEXT,
    print_sides TEXT,
    page_selection TEXT
)
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job_id UUID;
    v_target_shop_id UUID;
BEGIN
    -- Determine effective shop_id from agent if not explicitly passed
    IF p_shop_id IS NULL THEN
        SELECT pa.shop_id INTO v_target_shop_id
        FROM print_agents pa
        WHERE pa.id = p_agent_id;
    ELSE
        v_target_shop_id := p_shop_id;
    END IF;

    -- Atomically select the next eligible job matching tenant shop and printer
    SELECT pj.id INTO v_job_id
    FROM print_jobs pj
    WHERE pj.status IN ('QUEUED', 'RETRY_PENDING')
      AND (v_target_shop_id IS NULL OR pj.shop_id = v_target_shop_id OR pj.shop_id IS NULL)
      AND (p_printer_id IS NULL OR pj.printer_id = p_printer_id OR pj.printer_id IS NULL)
    ORDER BY pj.priority DESC, pj.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF v_job_id IS NULL THEN
        RETURN;
    END IF;

    -- Update job status to CLAIMED
    UPDATE print_jobs
    SET status = 'CLAIMED',
        agent_id = p_agent_id,
        claimed_at = now(),
        attempt_count = attempt_count + 1
    WHERE id = v_job_id;

    -- Update order status to PRINTING
    UPDATE print_orders po
    SET status = 'PRINTING',
        started_at = COALESCE(po.started_at, now())
    FROM print_jobs pj
    WHERE pj.id = v_job_id AND po.id = pj.order_id;

    -- Record event in audit trail
    INSERT INTO print_order_events (order_id, event_type, message, metadata)
    SELECT pj.order_id, 'PRINT_CLAIMED', 'Job claimed by tenant agent', jsonb_build_object('agent_id', p_agent_id, 'job_id', v_job_id, 'shop_id', v_target_shop_id)
    FROM print_jobs pj
    WHERE pj.id = v_job_id;

    -- Return full job context to the agent
    RETURN QUERY
    SELECT 
        pj.id AS job_id,
        po.id AS order_id,
        po.order_number,
        po.storage_path,
        po.original_filename,
        pj.print_options,
        po.copies,
        po.paper_size,
        po.color_mode,
        po.print_sides,
        po.page_selection
    FROM print_jobs pj
    JOIN print_orders po ON po.id = pj.order_id
    WHERE pj.id = v_job_id;
END;
$$ LANGUAGE plpgsql;

-- Permissions
REVOKE EXECUTE ON FUNCTION claim_next_print_job(UUID, UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_next_print_job(UUID, UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION claim_next_print_job(UUID, UUID, UUID) TO service_role;

-- ----------------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY (RLS) POLICIES FOR TENANT ISOLATION
-- ----------------------------------------------------------------------------
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE printers ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_outbox ENABLE ROW LEVEL SECURITY;

-- Allow service_role full bypass
CREATE POLICY "service_role_all_shops" ON shops FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_printers" ON printers FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_print_agents" ON print_agents FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_print_settings" ON print_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_print_orders" ON print_orders FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_print_jobs" ON print_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_conversations" ON whatsapp_conversations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_inbox" ON whatsapp_inbox FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_outbox" ON whatsapp_outbox FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Grant permissions to service_role and postgres
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO postgres, service_role;
