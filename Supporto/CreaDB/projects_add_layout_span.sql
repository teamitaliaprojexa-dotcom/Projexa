-- Aggiunge "layout_span" a projects: quante colonne occupa il campo nella riga (1, 2 o 3).
-- Default 1 (una colonna). Usato dal layout a righe del flyout progetto.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS layout_span INTEGER DEFAULT 1;
UPDATE projects SET layout_span = 1 WHERE layout_span IS NULL;
