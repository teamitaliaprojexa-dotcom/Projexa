import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;

// Fail-fast: senza un secret configurato i token sarebbero falsificabili.
// Meglio non avviare il server che girare con un fallback debole.
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  throw new Error(
    'JWT_SECRET mancante o troppo corto. Imposta una variabile d\'ambiente JWT_SECRET robusta (>= 16 caratteri).'
  );
}

export default JWT_SECRET;
