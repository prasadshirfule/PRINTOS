-- ============================================================================
-- PRINTOS Database Schema Migration 00001
-- PostgreSQL / Supabase
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------------------
-- 1. PRINTERS TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS printers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NULL,
    name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT 'Front Counter',
    status TEXT NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('ONLINE', 'OFFLINE', 'BUSY', 'ERROR', 'PAUSED')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    supports_color BOOLEAN NOT NULL DEFAULT false,
    supports_duplex BOOLEAN NOT NULL DEFAULT false,
    supported_paper_sizes TEXT[] NOT NULL DEFAULT '{"A4"}',
    last_seen_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 2. PRINT AGENTS TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NULL,
    agent_name TEXT NOT NULL UNIQUE,
    api_key_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('ONLINE', 'OFFLINE', 'BUSY', 'ERROR')),
    version TEXT NOT NULL DEFAULT '1.0.0',
    capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_seen_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 3. PRINT SETTINGS TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NULL,
    default_paper TEXT NOT NULL DEFAULT 'A4',
    bw_price_paisa INT NOT NULL DEFAULT 200,          -- ₹2.00
    color_price_paisa INT NOT NULL DEFAULT 1000,      -- ₹10.00
    duplex_price_paisa INT NOT NULL DEFAULT 200,      -- ₹2.00 per sheet/side
    a5_bw_price_paisa INT NOT NULL DEFAULT 100,       -- ₹1.00
    a5_color_price_paisa INT NOT NULL DEFAULT 500,    -- ₹5.00
    max_copies INT NOT NULL DEFAULT 50,
    max_file_size_bytes BIGINT NOT NULL DEFAULT 52428800, -- 50MB
    allowed_file_types TEXT[] NOT NULL DEFAULT '{"pdf", "jpg", "jpeg", "png"}',
    retention_hours INT NOT NULL DEFAULT 24,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 4. PRINT ORDERS TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NULL,
    order_number TEXT UNIQUE NOT NULL,
    customer_phone TEXT NOT NULL,
    customer_name TEXT NULL,
    status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (
        status IN (
            'RECEIVED',
            'CONFIGURING',
            'AWAITING_PAYMENT',
            'PAID',
            'QUEUED',
            'WAITING_FOR_PRINTER',
            'PRINTING',
            'COMPLETED',
            'FAILED',
            'CANCELLED'
        )
    ),
    original_filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    file_type TEXT NOT NULL CHECK (file_type IN ('pdf', 'jpg', 'jpeg', 'png')),
    file_size BIGINT NOT NULL,
    page_count INT NOT NULL DEFAULT 1,
    paper_size TEXT NOT NULL DEFAULT 'A4' CHECK (paper_size IN ('A4', 'A5')),
    color_mode TEXT NOT NULL DEFAULT 'BW' CHECK (color_mode IN ('BW', 'COLOR')),
    print_sides TEXT NOT NULL DEFAULT 'ONE_SIDED' CHECK (print_sides IN ('ONE_SIDED', 'BOTH_SIDES')),
    copies INT NOT NULL DEFAULT 1 CHECK (copies > 0),
    page_selection TEXT NULL,
    selected_page_count INT NOT NULL DEFAULT 1,
    subtotal_paisa INT NOT NULL DEFAULT 0,
    discount_paisa INT NOT NULL DEFAULT 0,
    total_amount_paisa INT NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'INR',
    payment_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING', 'PAID', 'FAILED', 'REFUNDED')),
    payment_id TEXT NULL,
    printer_id UUID REFERENCES printers(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at TIMESTAMPTZ NULL,
    queued_at TIMESTAMPTZ NULL,
    started_at TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL,
    failed_at TIMESTAMPTZ NULL
);

-- ----------------------------------------------------------------------------
-- 5. PRINT ORDER EVENTS TABLE (AUDIT TRAIL)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_order_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES print_orders(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 6. PRINT JOBS TABLE (QUEUE)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Strict idempotency: 1 order can only ever have 1 print job
    order_id UUID UNIQUE NOT NULL REFERENCES print_orders(id) ON DELETE CASCADE,
    printer_id UUID REFERENCES printers(id) ON DELETE SET NULL,
    agent_id UUID REFERENCES print_agents(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (
        status IN ('QUEUED', 'CLAIMED', 'PRINTING', 'COMPLETED', 'FAILED', 'RETRY_PENDING')
    ),
    priority INT NOT NULL DEFAULT 10,
    attempt_count INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    document_url TEXT NULL,
    print_options JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at TIMESTAMPTZ NULL,
    started_at TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL,
    failed_at TIMESTAMPTZ NULL
);

-- ----------------------------------------------------------------------------
-- 7. PAYMENT TRANSACTIONS TABLE (IDEMPOTENT WEBHOOKS)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES print_orders(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    idempotency_key TEXT UNIQUE NOT NULL,
    amount_paisa INT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_payment_provider_tx UNIQUE (provider, transaction_id)
);

-- ----------------------------------------------------------------------------
-- 8. INDEXES FOR HIGH-THROUGHPUT QUEUING AND LOOKUPS
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_print_orders_status ON print_orders(status);
CREATE INDEX IF NOT EXISTS idx_print_orders_customer_phone ON print_orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_print_orders_created_at ON print_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status_priority ON print_jobs(status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_print_order_events_order_id ON print_order_events(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_tx ON payment_transactions(provider, transaction_id);

-- ----------------------------------------------------------------------------
-- 9. ATOMIC JOB CLAIMING STORED PROCEDURE (FOR UPDATE SKIP LOCKED)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_next_print_job(
    p_agent_id UUID,
    p_printer_id UUID DEFAULT NULL
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
) AS $$
DECLARE
    v_job_id UUID;
BEGIN
    -- Atomically select the next eligible job using SKIP LOCKED
    SELECT pj.id INTO v_job_id
    FROM print_jobs pj
    WHERE pj.status IN ('QUEUED', 'RETRY_PENDING')
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
    SELECT pj.order_id, 'PRINT_CLAIMED', 'Job claimed by agent', jsonb_build_object('agent_id', p_agent_id, 'job_id', v_job_id)
    FROM print_jobs pj
    WHERE pj.id = v_job_id;

    -- Return full job context to agent
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

-- ----------------------------------------------------------------------------
-- 10. DEFAULT SEED DATA (MOCK PRINTER & AGENT & SETTINGS)
-- ----------------------------------------------------------------------------
INSERT INTO print_settings (
    default_paper,
    bw_price_paisa,
    color_price_paisa,
    duplex_price_paisa,
    a5_bw_price_paisa,
    a5_color_price_paisa,
    max_copies,
    max_file_size_bytes
) VALUES (
    'A4',
    200,
    1000,
    200,
    100,
    500,
    50,
    52428800
) ON CONFLICT DO NOTHING;

INSERT INTO printers (
    id,
    name,
    location,
    status,
    is_active,
    supports_color,
    supports_duplex,
    supported_paper_sizes
) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Mock Shop Laser Printer',
    'Main Desk',
    'ONLINE',
    true,
    true,
    true,
    '{"A4", "A5"}'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO print_agents (
    id,
    agent_name,
    api_key_hash,
    status,
    version,
    capabilities
) VALUES (
    '00000000-0000-0000-0000-000000000002',
    'shop-pc-01',
    -- sha256 of 'mock-agent-secret-token'
    '9b66236b285b0d09a5b3a3c26b9a8cfefefb54cf21d2e1c4a035728a47401c10',
    'ONLINE',
    '1.0.0',
    '{"printer": "Mock Shop Laser Printer", "duplex": true, "color": true}'::jsonb
) ON CONFLICT (agent_name) DO NOTHING;
