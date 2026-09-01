import { join } from 'node:path';
import { openMigratedDatabase } from '../server/db/connection';
import { bootstrapAdminAccount } from '../server/admin/auth/admin-account';

const database = openMigratedDatabase(join(process.env.FLOWPASS_DATA_ROOT ?? join(process.cwd(), '.flowpass-local'), 'data', 'flowpass.sqlite3'));
try {
  const result = await bootstrapAdminAccount(database);
  console.log(result.created ? 'Admin account admin created with one-time bootstrap password.' : 'Admin account admin already exists; password was not changed.');
} finally {
  database.close();
}
