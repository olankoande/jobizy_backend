// Side-effect module: must be the FIRST import of the entrypoint so that
// .env is loaded before any module reads process.env at import time (db pool, stripe, email...).
import { loadEnvFile } from "./env";

loadEnvFile();
