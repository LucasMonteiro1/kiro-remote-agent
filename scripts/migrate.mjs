// Applies every migrations/*.sql file, in filename order, against
// DATABASE_URL. Only needed if you set DATABASE_URL for the hub's optional
// durability backup (src/hub.ts) — skip this entirely if running in-memory
// only. Safe to re-run: every statement uses CREATE TABLE/INDEX IF NOT
// EXISTS.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrate.mjs
// or drop DATABASE_URL into .env and just run:
//   yarn db:migrate
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { neon } from '@neondatabase/serverless';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');

function loadDotEnvIfPresent() {
  if (process.env.DATABASE_URL) return;
  const envPath = path.join(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function splitSqlStatements(content) {
  const withoutComments = content
    .split('\n')
    .map((line) => {
      const commentIndex = line.indexOf('--');
      return commentIndex === -1 ? line : line.slice(0, commentIndex);
    })
    .join('\n');

  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  loadDotEnvIfPresent();

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'DATABASE_URL não definido. Isso só é necessário se você quiser backup periódico do log de eventos — sem ele, o hub roda inteiramente em memória.',
    );
    process.exit(1);
  }

  const sql = neon(url);
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    console.log(`Aplicando ${file}...`);
    const content = readFileSync(path.join(migrationsDir, file), 'utf8');
    const statements = splitSqlStatements(content);

    for (const statement of statements) {
      await sql.query(statement);
    }
  }

  console.log(`Migrations aplicadas com sucesso (${files.length} arquivo(s)).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
