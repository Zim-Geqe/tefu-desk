CREATE UNIQUE INDEX "PaymentAttempt_one_unresolved_per_order_key"
ON "PaymentAttempt" ("orderId")
WHERE "status" IN ('CREATED', 'APPROVED', 'CAPTURE_PENDING', 'UNCERTAIN');
