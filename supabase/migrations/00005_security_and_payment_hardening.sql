-- Security and payment-consistency hardening.

-- Conversations must be unique per tenant, not globally per phone number.
ALTER TABLE whatsapp_conversations DROP CONSTRAINT IF EXISTS whatsapp_conversations_customer_phone_key;
UPDATE whatsapp_conversations
SET shop_id = '00000000-0000-0000-0000-000000000001'
WHERE shop_id IS NULL;
ALTER TABLE whatsapp_conversations ALTER COLUMN shop_id SET NOT NULL;
ALTER TABLE whatsapp_conversations
  ADD CONSTRAINT whatsapp_conversations_shop_phone_key UNIQUE (shop_id, customer_phone);

-- Migration 00001 created shop_id columns before shops existed, so the later
-- ADD COLUMN IF NOT EXISTS statements did not add these foreign keys.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'printers_shop_id_fkey') THEN
    ALTER TABLE printers ADD CONSTRAINT printers_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_agents_shop_id_fkey') THEN
    ALTER TABLE print_agents ADD CONSTRAINT print_agents_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_orders_shop_id_fkey') THEN
    ALTER TABLE print_orders ADD CONSTRAINT print_orders_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_shop_id_fkey') THEN
    ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE;
  END IF;
END $$;

-- One database transaction locks the order, records the gateway event, queues
-- exactly one job, and publishes an audit trail. A partial payment cannot leave
-- a paid order without a job.
CREATE OR REPLACE FUNCTION process_verified_payment(
  p_order_id UUID,
  p_transaction_id TEXT,
  p_provider TEXT,
  p_amount_paisa INT
)
RETURNS TABLE (job_id UUID, is_duplicate BOOLEAN)
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order print_orders%ROWTYPE;
  v_job_id UUID;
BEGIN
  SELECT * INTO v_order FROM print_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id USING ERRCODE = 'P0002';
  END IF;
  IF p_amount_paisa IS DISTINCT FROM v_order.total_amount_paisa THEN
    RAISE EXCEPTION 'Payment amount mismatch for order %', p_order_id USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_job_id FROM print_jobs WHERE order_id = p_order_id;
  IF v_order.payment_status = 'PAID' OR v_job_id IS NOT NULL THEN
    RETURN QUERY SELECT v_job_id, true;
    RETURN;
  END IF;

  IF v_order.status NOT IN ('AWAITING_PAYMENT', 'EXPIRED') THEN
    RAISE EXCEPTION 'Order % is not eligible for payment in status %', p_order_id, v_order.status USING ERRCODE = '22023';
  END IF;

  INSERT INTO payment_transactions (
    shop_id, order_id, provider, transaction_id, idempotency_key,
    amount_paisa, currency, status, raw_payload
  ) VALUES (
    v_order.shop_id, p_order_id, p_provider, p_transaction_id,
    p_provider || ':' || p_transaction_id, p_amount_paisa,
    v_order.currency, 'SUCCESS', jsonb_build_object('verified_by', 'process_verified_payment')
  );

  UPDATE print_orders
  SET payment_status = 'PAID', payment_id = p_transaction_id,
      status = 'QUEUED', paid_at = now(), queued_at = now()
  WHERE id = p_order_id;

  INSERT INTO print_jobs (
    shop_id, order_id, printer_id, agent_id, status, priority,
    attempt_count, max_attempts, document_url, print_options
  ) VALUES (
    v_order.shop_id, p_order_id, v_order.printer_id, NULL, 'QUEUED', 10,
    0, 3, '/api/agent/jobs/' || p_order_id || '/document',
    jsonb_build_object(
      'copies', v_order.copies, 'paperSize', v_order.paper_size,
      'colorMode', v_order.color_mode, 'printSides', v_order.print_sides,
      'pageSelection', v_order.page_selection
    )
  ) RETURNING id INTO v_job_id;

  INSERT INTO print_order_events (order_id, event_type, message, metadata) VALUES
    (p_order_id, 'PAYMENT_VERIFIED', 'Verified payment received', jsonb_build_object('transactionId', p_transaction_id, 'provider', p_provider)),
    (p_order_id, 'PRINT_QUEUED', 'Print job added to printer queue', jsonb_build_object('jobId', v_job_id, 'shopId', v_order.shop_id));

  RETURN QUERY SELECT v_job_id, false;
END;
$$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION process_verified_payment(UUID, TEXT, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION process_verified_payment(UUID, TEXT, TEXT, INT) TO service_role;
