-- valore3: da INTEGER a NUMERIC con 2 decimali su settings, clients, projects.
-- I valori interi esistenti si convertono senza perdite.
ALTER TABLE settings ALTER COLUMN valore3 TYPE NUMERIC(12,2) USING valore3::numeric(12,2);
ALTER TABLE clients  ALTER COLUMN valore3 TYPE NUMERIC(12,2) USING valore3::numeric(12,2);
ALTER TABLE projects ALTER COLUMN valore3 TYPE NUMERIC(12,2) USING valore3::numeric(12,2);
