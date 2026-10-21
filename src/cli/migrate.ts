import 'dotenv/config';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { logger } from '../util/logger.js';

const config = loadConfig();
const db = openDb(path.resolve(config.app.db_file));
const applied = migrate(db);
db.close();
logger.info({ applied, db: config.app.db_file }, applied.length ? 'migrations applied' : 'database is up to date');
