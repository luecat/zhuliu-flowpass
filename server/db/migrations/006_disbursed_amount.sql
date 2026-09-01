ALTER TABLE cases ADD COLUMN disbursed_amount_twd INTEGER CHECK (disbursed_amount_twd >= 0);
