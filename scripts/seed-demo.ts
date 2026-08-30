import { join } from 'node:path';
import { openMigratedDatabase } from '../server/db/connection';
import { seedDemoFixtures, seedDemoProgram } from '../server/domain/program-service';

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const dataRoot = option('--data-root') ?? join(process.cwd(), '.flowpass-local');
const applicationStart = option('--application-start');
const applicationEnd = option('--application-end');
const purchaseStart = option('--purchase-start');
const purchaseEnd = option('--purchase-end');
if (!applicationStart || !applicationEnd || !purchaseStart || !purchaseEnd) {
  throw new Error('Provide --application-start, --application-end, --purchase-start, and --purchase-end explicitly');
}

const database = openMigratedDatabase(join(dataRoot, 'data', 'flowpass.sqlite3'));
try {
  const program = seedDemoProgram(database, { applicationStart, applicationEnd, purchaseStart, purchaseEnd });
  console.log(JSON.stringify({ program, fixtures: seedDemoFixtures(database, program) }, null, 2));
} finally {
  database.close();
}
