-- =====================================================================
-- Altiora Pedidos — 0002: perfis de base de dados, regras de estado e RLS
--
-- Como funciona o isolamento:
--  1. O servidor liga-se com UM utilizador da base de dados e, em cada transação,
--     muda para um perfil restrito com  SET LOCAL ROLE altiora_<perfil>.
--  2. O servidor indica o contexto (restaurante, utilizador, mesa...) com
--     set_config('app.restaurant_id', ...) — só vale dentro da transação.
--  3. As políticas RLS abaixo usam esse contexto: cada perfil só vê (e só altera)
--     as linhas do SEU restaurante, e só as colunas que lhe foram concedidas.
--  Assim, mesmo que exista um erro no código do servidor, a base de dados recusa
--  o acesso entre restaurantes. Os perfis anon/authenticated do Supabase não têm
--  qualquer acesso a este esquema.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Perfis
-- ---------------------------------------------------------------------
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['altiora_public', 'altiora_kitchen', 'altiora_waiter', 'altiora_manager', 'altiora_platform'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', r);
    END IF;
    -- Permite ao utilizador de ligação usar SET ROLE para este perfil.
    -- PostgreSQL 16 ou mais recente: ser "membro" já não basta; é preciso a opção SET. Um utilizador sem
    -- superpoderes (como o "postgres" do Supabase) recebe apenas a opção ADMIN ao criar o perfil, e sem este
    -- passo o servidor não conseguiria mudar de perfil ("permission denied to set role").
    -- Só concedemos SET (sem herdar os privilégios do perfil), o mínimo necessário.
    IF current_setting('server_version_num')::int >= 160000 THEN
      IF NOT pg_has_role(current_user, r, 'SET') THEN
        EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', r, current_user);
      END IF;
    ELSIF NOT pg_has_role(current_user, r, 'MEMBER') THEN
      EXECUTE format('GRANT %I TO %I', r, current_user);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Funções de contexto (lidas das definições da transação)
-- ---------------------------------------------------------------------
CREATE FUNCTION app_rid() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.restaurant_id', true), '')::uuid $$;

CREATE FUNCTION app_uid() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_table_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.table_id', true), '')::uuid $$;

CREATE FUNCTION app_session_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.table_session_id', true), '')::uuid $$;

CREATE FUNCTION app_public_code() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.public_code', true), '') $$;

-- Perfil efetivo da ligação (não pode ser falsificado pela aplicação).
CREATE FUNCTION app_db_role() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT CASE current_user
    WHEN 'altiora_public'   THEN 'public'
    WHEN 'altiora_kitchen'  THEN 'kitchen'
    WHEN 'altiora_waiter'   THEN 'waiter'
    WHEN 'altiora_manager'  THEN 'manager'
    WHEN 'altiora_platform' THEN 'platform'
    ELSE 'system'
  END
$$;

-- ---------------------------------------------------------------------
-- Ciclo de vida do pedido: quem pode fazer cada transição
-- ---------------------------------------------------------------------
CREATE FUNCTION order_transition_allowed(p_role text, p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_from = p_to THEN false
    WHEN p_role = 'system' THEN p_from IN ('novo','em_preparacao','pronto','entregue','cancelado')
                            AND p_to   IN ('novo','em_preparacao','pronto','entregue','cancelado')
    -- cozinha e gerente: aceitar/preparar e marcar como pronto
    WHEN p_role IN ('kitchen', 'manager') AND p_from = 'novo'          AND p_to = 'em_preparacao' THEN true
    WHEN p_role IN ('kitchen', 'manager') AND p_from = 'em_preparacao' AND p_to = 'pronto'        THEN true
    -- empregado e gerente: confirmar a entrega
    WHEN p_role IN ('waiter', 'manager')  AND p_from = 'pronto'        AND p_to = 'entregue'      THEN true
    -- gerente: cancelar (com motivo)
    WHEN p_role = 'manager' AND p_to = 'cancelado' AND p_from IN ('novo', 'em_preparacao', 'pronto') THEN true
    -- gerente: correções (com motivo)
    WHEN p_role = 'manager' AND p_from = 'em_preparacao' AND p_to = 'novo'          THEN true
    WHEN p_role = 'manager' AND p_from = 'pronto'        AND p_to = 'em_preparacao' THEN true
    WHEN p_role = 'manager' AND p_from = 'entregue'      AND p_to = 'pronto'        THEN true
    WHEN p_role = 'manager' AND p_from = 'cancelado'     AND p_to = 'novo'          THEN true
    ELSE false
  END
$$;

CREATE FUNCTION order_transition_needs_reason(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_to = 'cancelado'
      OR (p_from, p_to) IN (('em_preparacao', 'novo'), ('pronto', 'em_preparacao'), ('entregue', 'pronto'), ('cancelado', 'novo'))
$$;

-- Atribui o número curto do dia (#1, #2, ...) no fuso horário do restaurante
-- e guarda uma cópia do número/designação da mesa.
CREATE FUNCTION orders_assign_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = altiora, pg_temp AS $$
DECLARE
  v_tz  text;
  v_day date;
  v_n   integer;
BEGIN
  SELECT timezone INTO v_tz FROM restaurants WHERE id = NEW.restaurant_id;
  IF v_tz IS NULL THEN
    RAISE EXCEPTION 'RESTAURANT_NOT_FOUND' USING ERRCODE = 'AL004';
  END IF;
  SELECT t.table_number, t.label INTO NEW.table_number, NEW.table_label
  FROM restaurant_tables t WHERE t.id = NEW.table_id AND t.restaurant_id = NEW.restaurant_id;
  IF NEW.table_number IS NULL THEN
    RAISE EXCEPTION 'TABLE_NOT_FOUND' USING ERRCODE = 'AL006';
  END IF;
  v_day := (now() AT TIME ZONE v_tz)::date;
  INSERT INTO order_counters (restaurant_id, day, last_number) VALUES (NEW.restaurant_id, v_day, 1)
  ON CONFLICT (restaurant_id, day) DO UPDATE SET last_number = order_counters.last_number + 1
  RETURNING last_number INTO v_n;
  NEW.order_day := v_day;
  NEW.order_number := v_n;
  RETURN NEW;
END $$;

-- Valida alterações a um pedido (corre com os direitos de quem altera).
CREATE FUNCTION orders_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_role   text := app_db_role();
  v_reason text := NULLIF(btrim(coalesce(current_setting('app.reason', true), '')), '');
BEGIN
  IF NEW.id <> OLD.id OR NEW.restaurant_id <> OLD.restaurant_id OR NEW.table_id <> OLD.table_id
     OR NEW.public_code <> OLD.public_code OR NEW.order_day <> OLD.order_day OR NEW.order_number <> OLD.order_number
     OR NEW.subtotal_cents <> OLD.subtotal_cents OR NEW.service_fee_cents <> OLD.service_fee_cents
     OR NEW.total_cents <> OLD.total_cents OR NEW.source <> OLD.source OR NEW.created_at <> OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'ORDER_IMMUTABLE' USING ERRCODE = 'AL003';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT order_transition_allowed(v_role, OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'AL001',
        DETAIL = v_role || ': ' || OLD.status || ' -> ' || NEW.status;
    END IF;
    IF v_role <> 'system' AND order_transition_needs_reason(OLD.status, NEW.status)
       AND (v_reason IS NULL OR length(v_reason) < 3) THEN
      RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = 'AL002';
    END IF;

    IF NEW.status = 'novo' THEN
      NEW.preparing_at := NULL; NEW.ready_at := NULL; NEW.delivered_at := NULL;
      NEW.cancelled_at := NULL; NEW.cancel_reason := NULL;
    ELSIF NEW.status = 'em_preparacao' THEN
      IF OLD.status = 'novo' THEN NEW.preparing_at := now(); END IF;
      NEW.ready_at := NULL; NEW.delivered_at := NULL;
    ELSIF NEW.status = 'pronto' THEN
      NEW.ready_at := now(); NEW.delivered_at := NULL;
    ELSIF NEW.status = 'entregue' THEN
      NEW.delivered_at := now();
    ELSIF NEW.status = 'cancelado' THEN
      NEW.cancelled_at := now();
      NEW.cancel_reason := left(coalesce(v_reason, 'sem motivo'), 300);
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Regista sempre o histórico de estados (hora, utilizador, estado anterior).
CREATE FUNCTION orders_log_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = altiora, pg_temp AS $$
DECLARE
  v_role   text := coalesce(NULLIF(current_setting('app.role', true), ''), 'public');
  v_reason text := NULLIF(btrim(coalesce(current_setting('app.reason', true), '')), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO order_status_history (restaurant_id, order_id, previous_status, new_status, changed_by, changed_by_role, reason)
    VALUES (NEW.restaurant_id, NEW.id, NULL, NEW.status, NEW.created_by, v_role, NULL);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO order_status_history (restaurant_id, order_id, previous_status, new_status, changed_by, changed_by_role, reason)
    VALUES (NEW.restaurant_id, NEW.id, OLD.status, NEW.status, app_uid(), v_role, left(v_reason, 300));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER orders_assign_number_trg BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_assign_number();
CREATE TRIGGER orders_guard_trg BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard();
CREATE TRIGGER orders_log_status_ins_trg AFTER INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_log_status();
CREATE TRIGGER orders_log_status_upd_trg AFTER UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_log_status();

-- ---------------------------------------------------------------------
-- Funções públicas controladas (o cliente não lê tabelas diretamente)
-- ---------------------------------------------------------------------

-- Resolve o token de um QR Code. É a única forma de um cliente descobrir a mesa.
CREATE FUNCTION resolve_table_token(p_token text)
RETURNS TABLE (
  table_id uuid, restaurant_id uuid, table_number integer, table_label text, table_active boolean,
  restaurant_status text, accepting_orders boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = altiora, pg_temp AS $$
  SELECT t.id, t.restaurant_id, t.table_number, t.label, t.active, r.status, r.accepting_orders
  FROM restaurant_tables t
  JOIN restaurants r ON r.id = t.restaurant_id
  WHERE t.qr_token = p_token
$$;

-- Procura um pedido já criado com a mesma chave de idempotência (mesmo restaurante e mesma mesa).
CREATE FUNCTION lookup_idempotent_order(p_key text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = altiora, pg_temp AS $$
  SELECT o.public_code
  FROM orders o
  WHERE o.restaurant_id = app_rid()
    AND o.table_id = app_table_id()
    AND o.idempotency_key = p_key
$$;

-- Estatísticas da mesa atual para limitar abuso (pedidos pendentes e hora do último pedido).
CREATE FUNCTION table_order_stats() RETURNS TABLE (pending integer, last_order_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = altiora, pg_temp AS $$
  SELECT (count(*) FILTER (WHERE o.status = 'novo'))::integer, max(o.created_at)
  FROM orders o
  WHERE o.restaurant_id = app_rid() AND o.table_id = app_table_id()
$$;

-- Resolve o código público de um pedido (link de acompanhamento) para o restaurante a que pertence.
CREATE FUNCTION resolve_order_code(p_code text) RETURNS TABLE (restaurant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = altiora, pg_temp AS $$
  SELECT o.restaurant_id FROM orders o WHERE o.public_code = p_code
$$;

REVOKE ALL ON FUNCTION resolve_table_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION lookup_idempotent_order(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION table_order_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_order_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_table_token(text) TO altiora_public;
GRANT EXECUTE ON FUNCTION lookup_idempotent_order(text) TO altiora_public;
GRANT EXECUTE ON FUNCTION table_order_stats() TO altiora_public;
GRANT EXECUTE ON FUNCTION resolve_order_code(text) TO altiora_public;

-- ---------------------------------------------------------------------
-- Acesso base: esquema, funções auxiliares e remoção de acessos por omissão
-- ---------------------------------------------------------------------
REVOKE ALL ON SCHEMA altiora FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA altiora FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA altiora FROM PUBLIC;
GRANT USAGE ON SCHEMA altiora TO altiora_public, altiora_kitchen, altiora_waiter, altiora_manager, altiora_platform;

-- Perfis automáticos do Supabase: sem qualquer acesso (defesa em profundidade).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA altiora FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA altiora FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA altiora FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA altiora FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- RLS ligado em TODAS as tabelas (tabelas sem política = ninguém, exceto o dono).
ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurants          ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories           ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_options    ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_tables    ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_counters       ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_options   ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs           ENABLE ROW LEVEL SECURITY;

-- users, sessions e order_counters: sem GRANT e sem política para nenhum perfil da aplicação.

-- ---------------------------------------------------------------------
-- restaurants
-- ---------------------------------------------------------------------
GRANT SELECT (id, name, slug, description, logo_url, cover_url, accent_color, currency, service_fee_bps, accepting_orders, status)
  ON restaurants TO altiora_public;
GRANT SELECT (id, name, slug, description, logo_url, cover_url, accent_color, currency, service_fee_bps, accepting_orders, status,
              address, phone, timezone, menu_base_url, created_at)
  ON restaurants TO altiora_kitchen, altiora_waiter;
GRANT SELECT ON restaurants TO altiora_manager;
-- O gerente não altera o domínio dos menus (menu_base_url): isso é feito pela plataforma, porque um valor errado quebraria os QR Codes.
GRANT UPDATE (name, description, logo_url, cover_url, accent_color, address, phone, timezone, service_fee_bps, accepting_orders)
  ON restaurants TO altiora_manager;
GRANT SELECT, INSERT, UPDATE ON restaurants TO altiora_platform;

CREATE POLICY restaurants_tenant_select ON restaurants FOR SELECT
  TO altiora_public, altiora_kitchen, altiora_waiter, altiora_manager
  USING (id = (SELECT app_rid()));
CREATE POLICY restaurants_manager_update ON restaurants FOR UPDATE TO altiora_manager
  USING (id = (SELECT app_rid())) WITH CHECK (id = (SELECT app_rid()));
CREATE POLICY restaurants_platform_all ON restaurants FOR ALL TO altiora_platform
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- restaurant_members (só o gerente, no seu restaurante)
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON restaurant_members TO altiora_manager;
CREATE POLICY restaurant_members_manager_all ON restaurant_members FOR ALL TO altiora_manager
  USING (restaurant_id = (SELECT app_rid())) WITH CHECK (restaurant_id = (SELECT app_rid()));

-- ---------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------
GRANT SELECT ON categories TO altiora_public, altiora_kitchen, altiora_waiter, altiora_manager;
GRANT INSERT, UPDATE, DELETE ON categories TO altiora_manager;
CREATE POLICY categories_public_select ON categories FOR SELECT TO altiora_public
  USING (restaurant_id = (SELECT app_rid()) AND active);
CREATE POLICY categories_staff_select ON categories FOR SELECT TO altiora_kitchen, altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid()));
CREATE POLICY categories_manager_insert ON categories FOR INSERT TO altiora_manager
  WITH CHECK (restaurant_id = (SELECT app_rid()));
CREATE POLICY categories_manager_update ON categories FOR UPDATE TO altiora_manager
  USING (restaurant_id = (SELECT app_rid())) WITH CHECK (restaurant_id = (SELECT app_rid()));
CREATE POLICY categories_manager_delete ON categories FOR DELETE TO altiora_manager
  USING (restaurant_id = (SELECT app_rid()));

-- ---------------------------------------------------------------------
-- menu_items (a cozinha só pode marcar disponível/esgotado)
-- ---------------------------------------------------------------------
GRANT SELECT ON menu_items TO altiora_public, altiora_kitchen, altiora_waiter, altiora_manager;
GRANT INSERT, UPDATE, DELETE ON menu_items TO altiora_manager;
GRANT UPDATE (available) ON menu_items TO altiora_kitchen;
CREATE POLICY menu_items_public_select ON menu_items FOR SELECT TO altiora_public
  USING (restaurant_id = (SELECT app_rid()) AND active);
CREATE POLICY menu_items_staff_select ON menu_items FOR SELECT TO altiora_kitchen, altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid()));
CREATE POLICY menu_items_manager_insert ON menu_items FOR INSERT TO altiora_manager
  WITH CHECK (restaurant_id = (SELECT app_rid()));
CREATE POLICY menu_items_manager_update ON menu_items FOR UPDATE TO altiora_manager
  USING (restaurant_id = (SELECT app_rid())) WITH CHECK (restaurant_id = (SELECT app_rid()));
CREATE POLICY menu_items_kitchen_update ON menu_items FOR UPDATE TO altiora_kitchen
  USING (restaurant_id = (SELECT app_rid())) WITH CHECK (restaurant_id = (SELECT app_rid()));
CREATE POLICY menu_items_manager_delete ON menu_items FOR DELETE TO altiora_manager
  USING (restaurant_id = (SELECT app_rid()));

-- ---------------------------------------------------------------------
-- menu_item_options
-- ---------------------------------------------------------------------
GRANT SELECT ON menu_item_options TO altiora_public, altiora_kitchen, altiora_waiter, altiora_manager;
GRANT INSERT, UPDATE, DELETE ON menu_item_options TO altiora_manager;
CREATE POLICY menu_item_options_public_select ON menu_item_options FOR SELECT TO altiora_public
  USING (restaurant_id = (SELECT app_rid()) AND active);
CREATE POLICY menu_item_options_staff_select ON menu_item_options FOR SELECT TO altiora_kitchen, altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid()));
CREATE POLICY menu_item_options_manager_insert ON menu_item_options FOR INSERT TO altiora_manager
  WITH CHECK (restaurant_id = (SELECT app_rid()));
CREATE POLICY menu_item_options_manager_update ON menu_item_options FOR UPDATE TO altiora_manager
  USING (restaurant_id = (SELECT app_rid())) WITH CHECK (restaurant_id = (SELECT app_rid()));
CREATE POLICY menu_item_options_manager_delete ON menu_item_options FOR DELETE TO altiora_manager
  USING (restaurant_id = (SELECT app_rid()));

-- ---------------------------------------------------------------------
-- restaurant_tables (o token do QR só é visível ao gerente)
-- ---------------------------------------------------------------------
GRANT SELECT (id, restaurant_id, table_number, label, active, created_at, updated_at)
  ON restaurant_tables TO altiora_kitchen, altiora_waiter;
GRANT SELECT, INSERT, UPDATE, DELETE ON restaurant_tables TO altiora_manager;
CREATE POLICY restaurant_tables_staff_select ON restaurant_tables FOR SELECT
  TO altiora_kitchen, altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid()));
CREATE POLICY restaurant_tables_manager_insert ON restaurant_tables FOR INSERT TO altiora_manager
  WITH CHECK (restaurant_id = (SELECT app_rid()));
CREATE POLICY restaurant_tables_manager_update ON restaurant_tables FOR UPDATE TO altiora_manager
  USING (restaurant_id = (SELECT app_rid())) WITH CHECK (restaurant_id = (SELECT app_rid()));
CREATE POLICY restaurant_tables_manager_delete ON restaurant_tables FOR DELETE TO altiora_manager
  USING (restaurant_id = (SELECT app_rid()));

-- ---------------------------------------------------------------------
-- table_sessions
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT ON table_sessions TO altiora_public;
GRANT UPDATE (last_activity_at, closed_at, close_reason) ON table_sessions TO altiora_public;
GRANT SELECT ON table_sessions TO altiora_kitchen, altiora_waiter, altiora_manager;
GRANT INSERT ON table_sessions TO altiora_waiter, altiora_manager;
GRANT UPDATE (last_activity_at, closed_at, closed_by, close_reason) ON table_sessions TO altiora_waiter, altiora_manager;
CREATE POLICY table_sessions_public_select ON table_sessions FOR SELECT TO altiora_public
  USING (restaurant_id = (SELECT app_rid()) AND table_id = (SELECT app_table_id()));
CREATE POLICY table_sessions_public_insert ON table_sessions FOR INSERT TO altiora_public
  WITH CHECK (restaurant_id = (SELECT app_rid()) AND table_id = (SELECT app_table_id()) AND closed_at IS NULL);
CREATE POLICY table_sessions_public_update ON table_sessions FOR UPDATE TO altiora_public
  USING (restaurant_id = (SELECT app_rid()) AND table_id = (SELECT app_table_id()))
  WITH CHECK (restaurant_id = (SELECT app_rid()) AND table_id = (SELECT app_table_id()));
CREATE POLICY table_sessions_staff_select ON table_sessions FOR SELECT TO altiora_kitchen, altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid()));
CREATE POLICY table_sessions_staff_update ON table_sessions FOR UPDATE TO altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid())) WITH CHECK (restaurant_id = (SELECT app_rid()));
CREATE POLICY table_sessions_staff_insert ON table_sessions FOR INSERT TO altiora_waiter, altiora_manager
  WITH CHECK (restaurant_id = (SELECT app_rid()) AND closed_at IS NULL);

-- ---------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------
GRANT SELECT (id, restaurant_id, table_id, table_session_id, table_number, table_label, order_day, order_number,
              public_code, status, source, subtotal_cents, service_fee_cents, total_cents, notes, created_at, updated_at,
              preparing_at, ready_at, delivered_at, cancelled_at)
  ON orders TO altiora_public;
GRANT INSERT (restaurant_id, table_id, table_session_id, public_code, status, source,
              subtotal_cents, service_fee_cents, total_cents, notes, idempotency_key)
  ON orders TO altiora_public;
GRANT SELECT ON orders TO altiora_kitchen, altiora_waiter, altiora_manager;
GRANT INSERT (restaurant_id, table_id, table_session_id, public_code, status, source, created_by,
              subtotal_cents, service_fee_cents, total_cents, notes)
  ON orders TO altiora_waiter, altiora_manager;
GRANT UPDATE (status) ON orders TO altiora_kitchen, altiora_waiter, altiora_manager;

CREATE POLICY orders_public_select ON orders FOR SELECT TO altiora_public
  USING (restaurant_id = (SELECT app_rid())
         AND (public_code = (SELECT app_public_code())
              OR (table_session_id IS NOT NULL AND table_session_id = (SELECT app_session_id()))));
CREATE POLICY orders_public_insert ON orders FOR INSERT TO altiora_public
  WITH CHECK (restaurant_id = (SELECT app_rid()) AND table_id = (SELECT app_table_id())
              AND source = 'qr' AND status = 'novo'
              AND public_code = (SELECT app_public_code()));
CREATE POLICY orders_staff_select ON orders FOR SELECT TO altiora_kitchen, altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid()));
CREATE POLICY orders_staff_insert ON orders FOR INSERT TO altiora_waiter, altiora_manager
  WITH CHECK (restaurant_id = (SELECT app_rid()) AND source = 'staff' AND status = 'novo'
              AND created_by = (SELECT app_uid()));
CREATE POLICY orders_staff_update ON orders FOR UPDATE TO altiora_kitchen, altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid())) WITH CHECK (restaurant_id = (SELECT app_rid()));

-- ---------------------------------------------------------------------
-- order_items e order_item_options
-- (só se inserem na MESMA transação que cria o pedido; depois são imutáveis)
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT ON order_items TO altiora_public, altiora_waiter, altiora_manager;
GRANT SELECT ON order_items TO altiora_kitchen;
CREATE POLICY order_items_public_select ON order_items FOR SELECT TO altiora_public
  USING (restaurant_id = (SELECT app_rid())
         AND EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND o.restaurant_id = order_items.restaurant_id));
CREATE POLICY order_items_public_insert ON order_items FOR INSERT TO altiora_public
  WITH CHECK (restaurant_id = (SELECT app_rid())
              AND EXISTS (SELECT 1 FROM orders o
                          WHERE o.id = order_items.order_id AND o.restaurant_id = order_items.restaurant_id
                            AND o.public_code = (SELECT app_public_code()) AND o.created_at = now()));
CREATE POLICY order_items_staff_select ON order_items FOR SELECT TO altiora_kitchen, altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid()));
CREATE POLICY order_items_staff_insert ON order_items FOR INSERT TO altiora_waiter, altiora_manager
  WITH CHECK (restaurant_id = (SELECT app_rid())
              AND EXISTS (SELECT 1 FROM orders o
                          WHERE o.id = order_items.order_id AND o.restaurant_id = order_items.restaurant_id
                            AND o.created_by = (SELECT app_uid()) AND o.created_at = now()));

GRANT SELECT, INSERT ON order_item_options TO altiora_public, altiora_waiter, altiora_manager;
GRANT SELECT ON order_item_options TO altiora_kitchen;
CREATE POLICY order_item_options_public_select ON order_item_options FOR SELECT TO altiora_public
  USING (restaurant_id = (SELECT app_rid())
         AND EXISTS (SELECT 1 FROM order_items i WHERE i.id = order_item_options.order_item_id AND i.restaurant_id = order_item_options.restaurant_id));
CREATE POLICY order_item_options_public_insert ON order_item_options FOR INSERT TO altiora_public
  WITH CHECK (restaurant_id = (SELECT app_rid())
              AND EXISTS (SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id AND o.restaurant_id = i.restaurant_id
                          WHERE i.id = order_item_options.order_item_id AND i.restaurant_id = order_item_options.restaurant_id
                            AND o.public_code = (SELECT app_public_code()) AND o.created_at = now()));
CREATE POLICY order_item_options_staff_select ON order_item_options FOR SELECT TO altiora_kitchen, altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid()));
CREATE POLICY order_item_options_staff_insert ON order_item_options FOR INSERT TO altiora_waiter, altiora_manager
  WITH CHECK (restaurant_id = (SELECT app_rid())
              AND EXISTS (SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id AND o.restaurant_id = i.restaurant_id
                          WHERE i.id = order_item_options.order_item_id AND i.restaurant_id = order_item_options.restaurant_id
                            AND o.created_by = (SELECT app_uid()) AND o.created_at = now()));

-- ---------------------------------------------------------------------
-- order_status_history (só leitura; escrita apenas pelo trigger)
-- ---------------------------------------------------------------------
GRANT SELECT ON order_status_history TO altiora_kitchen, altiora_waiter, altiora_manager;
CREATE POLICY order_status_history_staff_select ON order_status_history FOR SELECT
  TO altiora_kitchen, altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid()));

-- ---------------------------------------------------------------------
-- payments (empregado e gerente registam; só o gerente corrige)
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT ON payments TO altiora_waiter, altiora_manager;
GRANT UPDATE (status, reference) ON payments TO altiora_manager;
CREATE POLICY payments_staff_select ON payments FOR SELECT TO altiora_waiter, altiora_manager
  USING (restaurant_id = (SELECT app_rid()));
CREATE POLICY payments_staff_insert ON payments FOR INSERT TO altiora_waiter, altiora_manager
  WITH CHECK (restaurant_id = (SELECT app_rid()) AND recorded_by = (SELECT app_uid()));
CREATE POLICY payments_manager_update ON payments FOR UPDATE TO altiora_manager
  USING (restaurant_id = (SELECT app_rid())) WITH CHECK (restaurant_id = (SELECT app_rid()));

-- ---------------------------------------------------------------------
-- audit_logs (acrescentar apenas; leitura pelo gerente e, na plataforma, só ações "platform.*")
-- ---------------------------------------------------------------------
GRANT INSERT ON audit_logs TO altiora_kitchen, altiora_waiter, altiora_manager, altiora_platform;
GRANT SELECT ON audit_logs TO altiora_manager, altiora_platform;
CREATE POLICY audit_logs_staff_insert ON audit_logs FOR INSERT TO altiora_kitchen, altiora_waiter, altiora_manager
  WITH CHECK (restaurant_id = (SELECT app_rid()) AND actor_id = (SELECT app_uid()));
CREATE POLICY audit_logs_manager_select ON audit_logs FOR SELECT TO altiora_manager
  USING (restaurant_id = (SELECT app_rid()));
CREATE POLICY audit_logs_platform_insert ON audit_logs FOR INSERT TO altiora_platform
  WITH CHECK (action LIKE 'platform.%');
CREATE POLICY audit_logs_platform_select ON audit_logs FOR SELECT TO altiora_platform
  USING (action LIKE 'platform.%');
