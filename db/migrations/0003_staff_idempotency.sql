-- =====================================================================
-- Altiora Pedidos — 0003: chave anti-duplicados também nos pedidos feitos pela equipa
--
-- Quando um empregado toca duas vezes em "Enviar" (ou a rede falha e ele repete), o pedido
-- não deve ser criado duas vezes. Os pedidos dos clientes já usavam uma chave anti-duplicados
-- (idempotency_key); passa a ser possível também para o empregado e o gerente.
-- A chave continua única por restaurante (índice orders_idem_uq) e imutável depois de criada.
-- =====================================================================
GRANT INSERT (idempotency_key) ON orders TO altiora_waiter, altiora_manager;
