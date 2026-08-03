-- P0.8: queue payload-free processing error alerts through Telegram.
-- Configure dedicated bot/chat values in Supabase Vault; never commit them.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

-- Browser writes are limited to the fields exposed by lib/store.ts. Pipeline
-- state/results and row creation remain behind the service/RPC boundary.
REVOKE INSERT, UPDATE ON TABLE public.tenders FROM authenticated;
GRANT UPDATE (notes, source_link, submission_link, status, updated_at)
    ON TABLE public.tenders TO authenticated;

CREATE OR REPLACE FUNCTION public.queue_tender_processing_alert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_bot_token text;
    v_chat_id text;
    v_message text;
BEGIN
    IF NEW.processing_status IS DISTINCT FROM 'error'
       OR NEW.processing_stage IS NULL
       OR NEW.processing_error_code IS NULL
       OR NEW.processing_error_at IS NULL
       OR NEW.processing_correlation_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.processing_status = 'error'
       AND OLD.processing_correlation_id IS NOT DISTINCT FROM NEW.processing_correlation_id THEN
        RETURN NEW;
    END IF;

    SELECT secret.decrypted_secret
    INTO v_bot_token
    FROM vault.decrypted_secrets AS secret
    WHERE secret.name = 'telegram_alert_bot_token'
    ORDER BY secret.created_at DESC
    LIMIT 1;

    SELECT secret.decrypted_secret
    INTO v_chat_id
    FROM vault.decrypted_secrets AS secret
    WHERE secret.name = 'telegram_alert_chat_id'
    ORDER BY secret.created_at DESC
    LIMIT 1;

    IF v_bot_token IS NULL OR v_chat_id IS NULL THEN
        RAISE WARNING 'PROCESSING_ALERT_NOT_CONFIGURED';
        RETURN NEW;
    END IF;

    IF v_bot_token !~ '^[0-9]{6,12}:[A-Za-z0-9_-]{30,64}$'
       OR v_chat_id !~ '^-?[0-9]{1,20}$' THEN
        RAISE WARNING 'PROCESSING_ALERT_CONFIG_INVALID';
        RETURN NEW;
    END IF;

    v_message := format(
        E'Tenderly pipeline alert\nStage: %s\nCode: %s\nCorrelation: %s\nTime: %s',
        NEW.processing_stage,
        NEW.processing_error_code,
        NEW.processing_correlation_id,
        to_char(NEW.processing_error_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );

    PERFORM net.http_post(
        url := format('https://api.telegram.org/bot%s/sendMessage', v_bot_token),
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object(
            'chat_id', v_chat_id,
            'text', v_message,
            'disable_web_page_preview', true
        ),
        timeout_milliseconds := 5000
    );

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Alert delivery must never roll back the durable processing failure.
    RAISE WARNING 'PROCESSING_ALERT_QUEUE_FAILED';
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_tender_processing_alert()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS tenders_queue_processing_alert ON public.tenders;
CREATE TRIGGER tenders_queue_processing_alert
AFTER INSERT OR UPDATE ON public.tenders
FOR EACH ROW
EXECUTE FUNCTION public.queue_tender_processing_alert();

COMMIT;
