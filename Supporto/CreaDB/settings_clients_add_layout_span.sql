-- Aggiunge "layout_span" a settings e clients (stessa logica di layout dei progetti):
-- quante colonne occupa il campo nella riga (default 1).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS layout_span INTEGER DEFAULT 1;
UPDATE settings SET layout_span = 1 WHERE layout_span IS NULL;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS layout_span INTEGER DEFAULT 1;
UPDATE clients SET layout_span = 1 WHERE layout_span IS NULL;
