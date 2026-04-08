import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

const env = loadEnvFile(path.resolve(process.cwd(), ".env"));

const pool = mysql.createPool({
  host: env.DB_HOST || "127.0.0.1",
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER || "root",
  password: env.DB_PASSWORD || "",
  database: env.DB_NAME || "jobizy",
  connectionLimit: Number(env.DB_CONNECTION_LIMIT || 10),
});

const now = new Date("2026-03-25T14:00:00-04:00");

function dt(daysOffset, time = "10:00:00") {
  const date = new Date(now);
  date.setDate(date.getDate() + daysOffset);
  const [hours, minutes, seconds] = time.split(":").map(Number);
  date.setHours(hours, minutes, seconds ?? 0, 0);
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function d(daysOffset) {
  return dt(daysOffset, "00:00:00").slice(0, 10);
}

function json(value) {
  return JSON.stringify(value);
}

async function upsert(connection, table, row, updateKeys = Object.keys(row).filter((key) => key !== "id")) {
  const keys = Object.keys(row);
  const placeholders = keys.map(() => "?").join(", ");
  const updates = updateKeys.map((key) => `${key} = VALUES(${key})`).join(", ");
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`;
  await connection.execute(sql, keys.map((key) => row[key]));
}

async function execMany(connection, statements) {
  for (const statement of statements) {
    await upsert(connection, statement.table, statement.row, statement.updateKeys);
  }
}

async function ensureAdminTables(connection) {
  await connection.execute(
    `CREATE TABLE IF NOT EXISTS admin_roles (
      id CHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT DEFAULT NULL,
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      permissions_json JSON DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_admin_roles_code (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  await connection.execute(
    `CREATE TABLE IF NOT EXISTS admin_user_roles (
      id CHAR(36) NOT NULL,
      user_id CHAR(36) NOT NULL,
      admin_role_id CHAR(36) NOT NULL,
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      assigned_by_user_id CHAR(36) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_admin_user_role (user_id, admin_role_id),
      KEY idx_admin_user_roles_user (user_id),
      KEY idx_admin_user_roles_role (admin_role_id),
      CONSTRAINT fk_admin_user_roles_user FOREIGN KEY (user_id) REFERENCES users (id),
      CONSTRAINT fk_admin_user_roles_role FOREIGN KEY (admin_role_id) REFERENCES admin_roles (id),
      CONSTRAINT fk_admin_user_roles_assigned_by FOREIGN KEY (assigned_by_user_id) REFERENCES users (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
}

async function ensureMarketplaceContentColumns(connection) {
  async function ensureColumn(table, column, definition) {
    const [rows] = await connection.query(
      `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    if (Array.isArray(rows) && rows.length > 0) return;
    await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  await ensureColumn("categories", "image_url", "TEXT DEFAULT NULL");
  await ensureColumn("categories", "marketing_title", "VARCHAR(255) DEFAULT NULL");
  await ensureColumn("categories", "marketing_subtitle", "VARCHAR(255) DEFAULT NULL");
  await ensureColumn("subcategories", "image_url", "TEXT DEFAULT NULL");
  await ensureColumn("subcategories", "marketing_title", "VARCHAR(255) DEFAULT NULL");
  await ensureColumn("services", "image_url", "TEXT DEFAULT NULL");
  await ensureColumn("services", "marketing_title", "VARCHAR(255) DEFAULT NULL");
  await ensureColumn("services", "price_label", "VARCHAR(255) DEFAULT NULL");
  await ensureColumn("zones", "image_url", "TEXT DEFAULT NULL");
  await ensureColumn("zones", "marketing_blurb", "TEXT DEFAULT NULL");
}

function flattenIds(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap((entry) => flattenIds(entry));
}

async function deleteWhereIn(connection, table, column, values) {
  if (!values.length) return;
  const placeholders = values.map(() => "?").join(", ");
  await connection.execute(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`, values);
}

async function purgeConflicts(connection) {
  const allSeedIds = [...new Set(flattenIds(ids))];

  await connection.execute("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const table of [
      "admin_user_roles",
      "admin_roles",
      "refresh_tokens",
      "audit_logs",
      "notifications",
      "dispute_messages",
      "disputes",
      "reviews",
      "messages",
      "conversations",
      "missions",
      "quotes",
      "matches",
      "request_attachments",
      "requests",
      "invoices",
      "payments",
      "subscriptions",
      "service_suggestions",
      "availabilities",
      "provider_zones",
      "provider_services",
      "provider_profiles",
      "notification_preferences",
      "plans",
      "zones",
      "services",
      "subcategories",
      "categories",
      "users",
    ]) {
      await deleteWhereIn(connection, table, "id", allSeedIds);
    }

    await deleteWhereIn(connection, "users", "email", [
      "admin@jobizy.local",
      "sophie.martin@jobizy.local",
      "marc.girard@jobizy.local",
      "nadia.chen@jobizy.local",
      "alex.plomberie@jobizy.local",
      "carla.clean@jobizy.local",
      "julien.electrique@jobizy.local",
      "michael.tutor@jobizy.local",
      "sam.peinture@jobizy.local",
      "compte.suspendu@jobizy.local",
    ]);
    await deleteWhereIn(connection, "categories", "slug", ["maison-entretien", "metiers-specialises", "tech-numerique", "cours-formation"]);
    await deleteWhereIn(connection, "subcategories", "slug", ["nettoyage-residentiel", "plomberie", "electricite-residentielle", "support-informatique", "tutorat-scolaire", "peinture-interieure"]);
    await deleteWhereIn(connection, "services", "slug", ["nettoyage-fin-de-bail", "reparation-fuite-eau", "installation-borne-ve", "tutorat-mathematiques-secondaire", "depannage-ordinateur-portable", "peinture-appartement-3-1-2"]);
    await deleteWhereIn(connection, "plans", "code", ["free", "starter", "pro"]);
    await deleteWhereIn(connection, "invoices", "invoice_number", ["INV-SEED-REQ-1001", "INV-SEED-REQ-1002", "INV-SEED-SUB-2001"]);
    await deleteWhereIn(connection, "refresh_tokens", "token_hash", ["hash_seed_admin_active", "hash_seed_sophie_active", "hash_seed_plumber_active", "hash_seed_revoked"]);
    await deleteWhereIn(connection, "admin_roles", "code", ["super_admin", "ops_manager", "support_agent"]);
  } finally {
    await connection.execute("SET FOREIGN_KEY_CHECKS = 1");
  }
}

const ids = {
  users: {
    admin: "usr_seed_admin",
    client1: "usr_seed_sophie",
    client2: "usr_seed_marc",
    client3: "usr_seed_nadia",
    provider1: "usr_seed_plombier",
    provider2: "usr_seed_cleaner",
    provider3: "usr_seed_electric",
    provider4: "usr_seed_tutor",
    provider5: "usr_seed_painter",
    suspended: "usr_seed_suspended",
  },
  categories: {
    home: "cat_seed_home",
    trades: "cat_seed_trades",
    tech: "cat_seed_tech",
    education: "cat_seed_education",
  },
  subcategories: {
    cleaning: "sub_seed_cleaning",
    plumbing: "sub_seed_plumbing",
    electrical: "sub_seed_electrical",
    it: "sub_seed_it",
    tutoring: "sub_seed_tutoring",
    painting: "sub_seed_painting",
  },
  services: {
    moveOutCleaning: "svc_seed_moveout",
    leakRepair: "svc_seed_leak",
    evCharger: "svc_seed_evcharger",
    tutoringMath: "svc_seed_tutormath",
    laptopSupport: "svc_seed_laptop",
    interiorPainting: "svc_seed_paint",
  },
  zones: {
    canada: "zon_seed_canada",
    quebec: "zon_seed_quebec",
    montreal: "zon_seed_montreal",
    plateau: "zon_seed_plateau",
    laval: "zon_seed_laval",
    chomedey: "zon_seed_chomedey",
    longueuil: "zon_seed_longueuil",
    vieuxLongueuil: "zon_seed_vlongueuil",
    quebecCity: "zon_seed_quebeccity",
    sainteFoy: "zon_seed_saintefoy",
  },
  plans: {
    free: "pln_seed_free",
    starter: "pln_seed_starter",
    pro: "pln_seed_pro",
  },
  providerProfiles: {
    plomberie: "prv_seed_plomberie",
    clean: "prv_seed_clean",
    electric: "prv_seed_electric",
    tutor: "prv_seed_tutor",
    paint: "prv_seed_paint",
  },
  suggestions: {
    airQuality: "ssg_seed_airquality",
    dronePhoto: "ssg_seed_dronephoto",
    smartLock: "ssg_seed_smartlock",
  },
  subscriptions: {
    plumberPro: "subscr_seed_plumber",
    electricStarter: "subscr_seed_electric",
    tutorFree: "subscr_seed_tutor",
  },
  payments: {
    reqLeak: "pay_seed_req_leak",
    reqCleaning: "pay_seed_req_clean",
    reqEv: "pay_seed_req_ev",
    subPlumber: "pay_seed_sub_plumber",
    subElectric: "pay_seed_sub_electric",
  },
  invoices: {
    reqLeak: "inv_seed_req_leak",
    reqCleaning: "inv_seed_req_clean",
    subPlumber: "inv_seed_sub_plumber",
  },
  requests: {
    leak: "req_seed_leak",
    cleaning: "req_seed_cleaning",
    ev: "req_seed_ev",
    tutoring: "req_seed_tutoring",
    painting: "req_seed_painting",
    laptop: "req_seed_laptop",
  },
  attachments: {
    leakPhoto: "att_seed_leak",
    cleaningPhoto: "att_seed_clean",
    paintPlan: "att_seed_paint",
  },
  matches: {
    leakPlumber: "mat_seed_leak_plumber",
    leakElectric: "mat_seed_leak_electric",
    cleaningClean: "mat_seed_clean_clean",
    cleaningPaint: "mat_seed_clean_paint",
    tutoringTutor: "mat_seed_tutor_tutor",
    paintingPaint: "mat_seed_paint_paint",
  },
  quotes: {
    leakPlumber: "quo_seed_leak_plumber",
    leakElectric: "quo_seed_leak_electric",
    cleaningClean: "quo_seed_clean_clean",
    cleaningPaint: "quo_seed_clean_paint",
    tutoringTutor: "quo_seed_tutor_tutor",
    paintingPaint: "quo_seed_paint_paint",
  },
  missions: {
    leak: "mis_seed_leak",
    cleaning: "mis_seed_cleaning",
  },
  conversations: {
    leak: "cnv_seed_leak",
    cleaning: "cnv_seed_cleaning",
    tutoring: "cnv_seed_tutoring",
  },
  messages: {
    leak1: "msg_seed_leak_1",
    leak2: "msg_seed_leak_2",
    leak3: "msg_seed_leak_3",
    clean1: "msg_seed_clean_1",
    clean2: "msg_seed_clean_2",
    tutor1: "msg_seed_tutor_1",
  },
  reviews: {
    leakClient: "rev_seed_leak_client",
    leakProvider: "rev_seed_leak_provider",
  },
  disputes: {
    cleaning: "dsp_seed_cleaning",
  },
  disputeMessages: {
    cleaning1: "dmsg_seed_clean_1",
    cleaning2: "dmsg_seed_clean_2",
    cleaning3: "dmsg_seed_clean_3",
  },
  notifications: {
    n1: "ntf_seed_1",
    n2: "ntf_seed_2",
    n3: "ntf_seed_3",
    n4: "ntf_seed_4",
    n5: "ntf_seed_5",
    n6: "ntf_seed_6",
    n7: "ntf_seed_7",
    n8: "ntf_seed_8",
  },
  preferences: {
    admin: "npf_seed_admin",
    client1: "npf_seed_sophie",
    client2: "npf_seed_marc",
    client3: "npf_seed_nadia",
    provider1: "npf_seed_plombier",
    provider2: "npf_seed_cleaner",
    provider3: "npf_seed_electric",
    provider4: "npf_seed_tutor",
    provider5: "npf_seed_painter",
    suspended: "npf_seed_suspend",
  },
  audit: {
    a1: "adt_seed_1",
    a2: "adt_seed_2",
    a3: "adt_seed_3",
    a4: "adt_seed_4",
    a5: "adt_seed_5",
    a6: "adt_seed_6",
  },
  refreshTokens: {
    admin: "rft_seed_admin",
    client1: "rft_seed_sophie",
    provider1: "rft_seed_plombier",
    revoked: "rft_seed_revoked",
  },
  adminRoles: {
    superAdmin: "arole_seed_super_admin",
    opsManager: "arole_seed_ops_manager",
    supportAgent: "arole_seed_support_agent",
  },
  adminAssignments: {
    superAdmin: "aurole_seed_super_admin",
    opsManager: "aurole_seed_ops_manager",
    supportAgent: "aurole_seed_support_agent",
  },
};

const allAdminPermissions = [
  "dashboard.view",
  "users.view",
  "users.edit",
  "providers.view",
  "providers.edit",
  "catalog.view",
  "catalog.edit",
  "zones.view",
  "zones.edit",
  "platform.view",
  "platform.edit",
  "plans.view",
  "plans.edit",
  "subscriptions.view",
  "requests.view",
  "requests.edit",
  "requests.workflow",
  "matching.view",
  "quotes.view",
  "quotes.edit",
  "quotes.workflow",
  "missions.view",
  "missions.edit",
  "missions.workflow",
  "conversations.view",
  "payments.view",
  "invoices.view",
  "reviews.view",
  "disputes.view",
  "disputes.edit",
  "disputes.workflow",
  "notifications.view",
  "audit.view",
  "security.view",
  "security.revoke",
  "admins.view",
  "admins.edit",
];

async function seed() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await ensureAdminTables(connection);
    await ensureMarketplaceContentColumns(connection);
    await purgeConflicts(connection);
    await upsert(
      connection,
      "platform_settings",
      {
        id: 1,
        request_publication_payment_enabled: 1,
        default_request_publication_price_cents: 1900,
        currency: "CAD",
        default_locale: "fr-CA",
        supported_locales: json(["fr-CA", "en-CA"]),
        brand_logo_url: "https://jobizy.local/assets/logo-seed.png",
        pwa_push_enabled: 1,
        updated_at: dt(0, "08:00:00"),
      },
      [
        "request_publication_payment_enabled",
        "default_request_publication_price_cents",
        "currency",
        "default_locale",
        "supported_locales",
        "brand_logo_url",
        "pwa_push_enabled",
        "updated_at",
      ],
    );

    await execMany(connection, [
      { table: "categories", row: { id: ids.categories.home, name: "Maison & Entretien", slug: "maison-entretien", description: "Services d'entretien residentiel et menager.", image_url: "https://images.unsplash.com/photo-1520607162513-77705c0f0d4a?auto=format&fit=crop&w=1200&q=80", marketing_title: "Entretenir votre maison sans friction", marketing_subtitle: "Menage, peinture et entretien avec une lecture claire des offres.", status: "active", sort_order: 1, publication_price_override_cents: 1900, created_at: dt(-90), updated_at: dt(-1) } },
      { table: "categories", row: { id: ids.categories.trades, name: "Metiers specialises", slug: "metiers-specialises", description: "Plomberie, electricite et travaux techniques.", image_url: "https://images.unsplash.com/photo-1504307651254-35680f356dfd?auto=format&fit=crop&w=1200&q=80", marketing_title: "Des interventions locales quand ca compte vraiment", marketing_subtitle: "Urgences, installations et travaux techniques avec delais visibles.", status: "active", sort_order: 2, publication_price_override_cents: 2900, created_at: dt(-90), updated_at: dt(-1) } },
      { table: "categories", row: { id: ids.categories.tech, name: "Tech & Numerique", slug: "tech-numerique", description: "Depannage, configuration et support informatique.", image_url: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1200&q=80", marketing_title: "Support numerique plus lisible", marketing_subtitle: "Depannage et configuration avec un brief plus propre et plus rapide.", status: "active", sort_order: 3, publication_price_override_cents: 1500, created_at: dt(-90), updated_at: dt(-1) } },
      { table: "categories", row: { id: ids.categories.education, name: "Cours & Formation", slug: "cours-formation", description: "Cours particuliers et accompagnement scolaire.", image_url: "https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=1200&q=80", marketing_title: "Des accompagnements reguliers et rassurants", marketing_subtitle: "Cours individuels et tutorat avec disponibilites locales ou a distance.", status: "active", sort_order: 4, publication_price_override_cents: 900, created_at: dt(-90), updated_at: dt(-1) } },
    ]);

    await execMany(connection, [
      { table: "subcategories", row: { id: ids.subcategories.cleaning, category_id: ids.categories.home, name: "Nettoyage residentiel", slug: "nettoyage-residentiel", description: "Grand menage et entretien avant et apres demenagement.", image_url: "https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1200&q=80", marketing_title: "Equipes locales pour les remises en etat exigeantes", status: "active", sort_order: 1, publication_price_override_cents: 1900, created_at: dt(-89), updated_at: dt(-1) } },
      { table: "subcategories", row: { id: ids.subcategories.plumbing, category_id: ids.categories.trades, name: "Plomberie", slug: "plomberie", description: "Urgences, fuites, remplacement et installation.", image_url: "https://images.unsplash.com/photo-1621905252507-b35492cc74b4?auto=format&fit=crop&w=1200&q=80", marketing_title: "Reparations urgentes et installations planifiees", status: "active", sort_order: 1, publication_price_override_cents: 2900, created_at: dt(-89), updated_at: dt(-1) } },
      { table: "subcategories", row: { id: ids.subcategories.electrical, category_id: ids.categories.trades, name: "Electricite residentielle", slug: "electricite-residentielle", description: "Bornes VE, circuits et prises.", image_url: "https://images.unsplash.com/photo-1555963966-b7ae5404b6ed?auto=format&fit=crop&w=1200&q=80", marketing_title: "Bornes, circuits et interventions de confiance", status: "active", sort_order: 2, publication_price_override_cents: 2900, created_at: dt(-89), updated_at: dt(-1) } },
      { table: "subcategories", row: { id: ids.subcategories.it, category_id: ids.categories.tech, name: "Support informatique", slug: "support-informatique", description: "Depannage et optimisation de postes.", image_url: "https://images.unsplash.com/photo-1516321165247-4aa89a48be28?auto=format&fit=crop&w=1200&q=80", marketing_title: "Assistance materielle et logicielle plus claire", status: "active", sort_order: 1, publication_price_override_cents: 1500, created_at: dt(-89), updated_at: dt(-1) } },
      { table: "subcategories", row: { id: ids.subcategories.tutoring, category_id: ids.categories.education, name: "Tutorat scolaire", slug: "tutorat-scolaire", description: "Cours individuels en ligne ou a domicile.", image_url: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?auto=format&fit=crop&w=1200&q=80", marketing_title: "Suivis reguliers et objectifs plus lisibles", status: "active", sort_order: 1, publication_price_override_cents: 900, created_at: dt(-89), updated_at: dt(-1) } },
      { table: "subcategories", row: { id: ids.subcategories.painting, category_id: ids.categories.home, name: "Peinture interieure", slug: "peinture-interieure", description: "Rafraichissement d'appartement et de maison.", image_url: "https://images.unsplash.com/photo-1562259949-e8e7689d7828?auto=format&fit=crop&w=1200&q=80", marketing_title: "Chantiers propres pour rafraichir vite", status: "active", sort_order: 2, publication_price_override_cents: 2200, created_at: dt(-89), updated_at: dt(-1) } },
    ]);

    await execMany(connection, [
      { table: "services", row: { id: ids.services.moveOutCleaning, subcategory_id: ids.subcategories.cleaning, name: "Nettoyage de fin de bail", slug: "nettoyage-fin-de-bail", description: "Grand menage avant remise des cles avec cuisine, salle de bain et vitres.", image_url: "https://images.unsplash.com/photo-1527515637462-cff94eecc1ac?auto=format&fit=crop&w=1200&q=80", marketing_title: "Pour une remise des cles sans stress", price_label: "A partir de 240 $ selon surface", status: "active", base_publication_price_cents: 1900, sort_order: 1, created_at: dt(-88), updated_at: dt(-1) } },
      { table: "services", row: { id: ids.services.leakRepair, subcategory_id: ids.subcategories.plumbing, name: "Reparation de fuite d'eau", slug: "reparation-fuite-eau", description: "Intervention rapide sur fuite sous evier, vanne ou tuyauterie.", image_url: "https://images.unsplash.com/photo-1600566753151-384129cf4e3e?auto=format&fit=crop&w=1200&q=80", marketing_title: "Intervention rapide avec pieces standard", price_label: "Urgence locale, devis en moins d'une heure", status: "active", base_publication_price_cents: 2900, sort_order: 1, created_at: dt(-88), updated_at: dt(-1) } },
      { table: "services", row: { id: ids.services.evCharger, subcategory_id: ids.subcategories.electrical, name: "Installation de borne VE", slug: "installation-borne-ve", description: "Installation residentielle de borne 240V et verification de panneau.", image_url: "https://images.unsplash.com/photo-1617788138017-80ad40651399?auto=format&fit=crop&w=1200&q=80", marketing_title: "Installation residentielle planifiee proprement", price_label: "Projet sur visite technique et capacite du panneau", status: "active", base_publication_price_cents: 2900, sort_order: 2, created_at: dt(-88), updated_at: dt(-1) } },
      { table: "services", row: { id: ids.services.tutoringMath, subcategory_id: ids.subcategories.tutoring, name: "Tutorat mathematiques secondaire", slug: "tutorat-mathematiques-secondaire", description: "Preparation d'examens, suivi hebdomadaire et accompagnement a distance.", image_url: "https://images.unsplash.com/photo-1513258496099-48168024aec0?auto=format&fit=crop&w=1200&q=80", marketing_title: "Suivi hebdomadaire avec objectifs clairs", price_label: "Forfaits hebdomadaires ou intensifs avant examen", status: "active", base_publication_price_cents: 900, sort_order: 1, created_at: dt(-88), updated_at: dt(-1) } },
      { table: "services", row: { id: ids.services.laptopSupport, subcategory_id: ids.subcategories.it, name: "Depannage ordinateur portable", slug: "depannage-ordinateur-portable", description: "Ordinateur lent, migration et remise en etat logicielle.", image_url: "https://images.unsplash.com/photo-1515879218367-8466d910aaa4?auto=format&fit=crop&w=1200&q=80", marketing_title: "Un poste remis en etat sans jargon inutile", price_label: "Diagnostic rapide puis intervention a distance ou sur place", status: "active", base_publication_price_cents: 1500, sort_order: 1, created_at: dt(-88), updated_at: dt(-1) } },
      { table: "services", row: { id: ids.services.interiorPainting, subcategory_id: ids.subcategories.painting, name: "Peinture appartement 3 1/2", slug: "peinture-appartement-3-1-2", description: "Peinture des murs et retouches de finition.", image_url: "https://images.unsplash.com/photo-1565538810643-b5bdb714032a?auto=format&fit=crop&w=1200&q=80", marketing_title: "Rafraichir un logement en une courte fenetre", price_label: "Materiel et finitions inclus selon etat des murs", status: "active", base_publication_price_cents: 2200, sort_order: 1, created_at: dt(-88), updated_at: dt(-1) } },
    ]);

    await execMany(connection, [
      { table: "zones", row: { id: ids.zones.canada, parent_id: null, type: "country", name: "Canada", code: "CA", image_url: null, marketing_blurb: "Couverture nationale, avec un coeur d'activite seed sur le Quebec.", status: "active", latitude: 56.1304, longitude: -106.3468, sort_order: 1, created_at: dt(-100), updated_at: dt(-1) } },
      { table: "zones", row: { id: ids.zones.quebec, parent_id: ids.zones.canada, type: "province", name: "Quebec", code: "QC", image_url: null, marketing_blurb: "Des professionnels locaux organises par ville et secteur.", status: "active", latitude: 52.9399, longitude: -73.5491, sort_order: 1, created_at: dt(-100), updated_at: dt(-1) } },
      { table: "zones", row: { id: ids.zones.montreal, parent_id: ids.zones.quebec, type: "city", name: "Montreal", code: "MTL", image_url: "https://images.unsplash.com/photo-1519178614-68673b201f36?auto=format&fit=crop&w=1200&q=80", marketing_blurb: "Urgences maison, entretien recurrent et specialistes de quartier avec reponses rapides.", status: "active", latitude: 45.5019, longitude: -73.5674, sort_order: 1, created_at: dt(-100), updated_at: dt(-1) } },
      { table: "zones", row: { id: ids.zones.plateau, parent_id: ids.zones.montreal, type: "sector", name: "Le Plateau-Mont-Royal", code: "PLT", status: "active", latitude: 45.5247, longitude: -73.5817, sort_order: 1, created_at: dt(-100), updated_at: dt(-1) } },
      { table: "zones", row: { id: ids.zones.laval, parent_id: ids.zones.quebec, type: "city", name: "Laval", code: "LAV", image_url: "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=1200&q=80", marketing_blurb: "Maisons familiales, condos et services recurrents avec prestataires verifies.", status: "active", latitude: 45.6066, longitude: -73.7124, sort_order: 2, created_at: dt(-100), updated_at: dt(-1) } },
      { table: "zones", row: { id: ids.zones.chomedey, parent_id: ids.zones.laval, type: "sector", name: "Chomedey", code: "CHM", status: "active", latitude: 45.5531, longitude: -73.7425, sort_order: 1, created_at: dt(-100), updated_at: dt(-1) } },
      { table: "zones", row: { id: ids.zones.longueuil, parent_id: ids.zones.quebec, type: "city", name: "Longueuil", code: "LGL", image_url: "https://images.unsplash.com/photo-1460317442991-0ec209397118?auto=format&fit=crop&w=1200&q=80", marketing_blurb: "Services locaux de proximite pour l'entretien, la peinture et les interventions rapides.", status: "active", latitude: 45.5312, longitude: -73.5181, sort_order: 3, created_at: dt(-100), updated_at: dt(-1) } },
      { table: "zones", row: { id: ids.zones.vieuxLongueuil, parent_id: ids.zones.longueuil, type: "sector", name: "Vieux-Longueuil", code: "VLG", status: "active", latitude: 45.5371, longitude: -73.5146, sort_order: 1, created_at: dt(-100), updated_at: dt(-1) } },
      { table: "zones", row: { id: ids.zones.quebecCity, parent_id: ids.zones.quebec, type: "city", name: "Quebec", code: "QBC", image_url: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1200&q=80", marketing_blurb: "Projets planifies, tutorat et travaux interieurs avec delais plus previsibles.", status: "active", latitude: 46.8139, longitude: -71.208, sort_order: 4, created_at: dt(-100), updated_at: dt(-1) } },
      { table: "zones", row: { id: ids.zones.sainteFoy, parent_id: ids.zones.quebecCity, type: "sector", name: "Sainte-Foy", code: "SFO", status: "active", latitude: 46.7702, longitude: -71.286, sort_order: 1, created_at: dt(-100), updated_at: dt(-1) } },
    ]);

    await execMany(connection, [
      { table: "plans", row: { id: ids.plans.free, code: "free", name: "Gratuit", price_cents: 0, currency: "CAD", billing_interval: "monthly", response_limit: 5, priority_level: 0, status: "active", created_at: dt(-120), updated_at: dt(-1) } },
      { table: "plans", row: { id: ids.plans.starter, code: "starter", name: "Starter", price_cents: 2900, currency: "CAD", billing_interval: "monthly", response_limit: 20, priority_level: 1, status: "active", created_at: dt(-120), updated_at: dt(-1) } },
      { table: "plans", row: { id: ids.plans.pro, code: "pro", name: "Pro", price_cents: 7900, currency: "CAD", billing_interval: "monthly", response_limit: null, priority_level: 2, status: "active", created_at: dt(-120), updated_at: dt(-1) } },
    ]);

    await execMany(connection, [
      { table: "users", row: { id: ids.users.admin, email: "admin@jobizy.local", password_hash: "admin123456", first_name: "Ariane", last_name: "Bouchard", phone: "5145550100", avatar_url: "https://i.pravatar.cc/300?img=12", locale: "fr-CA", auth_provider: "local", google_subject_id: null, is_client_enabled: 1, is_provider_enabled: 0, status: "active", email_verified_at: dt(-180), last_login_at: dt(0, "09:05:00"), created_at: dt(-240), updated_at: dt(0, "09:05:00") } },
      { table: "users", row: { id: ids.users.client1, email: "sophie.martin@jobizy.local", password_hash: "client123456", first_name: "Sophie", last_name: "Martin", phone: "5145550111", avatar_url: "https://i.pravatar.cc/300?img=32", locale: "fr-CA", auth_provider: "local", google_subject_id: null, is_client_enabled: 1, is_provider_enabled: 0, status: "active", email_verified_at: dt(-80), last_login_at: dt(-1, "20:14:00"), created_at: dt(-120), updated_at: dt(-1, "20:14:00") } },
      { table: "users", row: { id: ids.users.client2, email: "marc.girard@jobizy.local", password_hash: "client123456", first_name: "Marc", last_name: "Girard", phone: "4385550122", avatar_url: "https://i.pravatar.cc/300?img=14", locale: "fr-CA", auth_provider: "local", google_subject_id: null, is_client_enabled: 1, is_provider_enabled: 0, status: "active", email_verified_at: dt(-70), last_login_at: dt(-2, "18:20:00"), created_at: dt(-110), updated_at: dt(-2, "18:20:00") } },
      { table: "users", row: { id: ids.users.client3, email: "nadia.chen@jobizy.local", password_hash: "client123456", first_name: "Nadia", last_name: "Chen", phone: "5815550133", avatar_url: "https://i.pravatar.cc/300?img=47", locale: "en-CA", auth_provider: "google", google_subject_id: "google-seed-nadia", is_client_enabled: 1, is_provider_enabled: 0, status: "active", email_verified_at: dt(-65), last_login_at: dt(-3, "08:40:00"), created_at: dt(-100), updated_at: dt(-3, "08:40:00") } },
      { table: "users", row: { id: ids.users.provider1, email: "alex.plomberie@jobizy.local", password_hash: "provider123456", first_name: "Alex", last_name: "Lefebvre", phone: "5145550211", avatar_url: "https://i.pravatar.cc/300?img=65", locale: "fr-CA", auth_provider: "local", google_subject_id: null, is_client_enabled: 0, is_provider_enabled: 1, status: "active", email_verified_at: dt(-150), last_login_at: dt(0, "07:10:00"), created_at: dt(-200), updated_at: dt(0, "07:10:00") } },
      { table: "users", row: { id: ids.users.provider2, email: "carla.clean@jobizy.local", password_hash: "provider123456", first_name: "Carla", last_name: "Nguyen", phone: "4505550222", avatar_url: "https://i.pravatar.cc/300?img=49", locale: "fr-CA", auth_provider: "local", google_subject_id: null, is_client_enabled: 0, is_provider_enabled: 1, status: "active", email_verified_at: dt(-140), last_login_at: dt(-1, "16:35:00"), created_at: dt(-190), updated_at: dt(-1, "16:35:00") } },
      { table: "users", row: { id: ids.users.provider3, email: "julien.electrique@jobizy.local", password_hash: "provider123456", first_name: "Julien", last_name: "Roy", phone: "4505550233", avatar_url: "https://i.pravatar.cc/300?img=11", locale: "fr-CA", auth_provider: "local", google_subject_id: null, is_client_enabled: 0, is_provider_enabled: 1, status: "active", email_verified_at: dt(-135), last_login_at: dt(-4, "12:00:00"), created_at: dt(-180), updated_at: dt(-4, "12:00:00") } },
      { table: "users", row: { id: ids.users.provider4, email: "michael.tutor@jobizy.local", password_hash: "provider123456", first_name: "Michael", last_name: "Tran", phone: "5815550244", avatar_url: "https://i.pravatar.cc/300?img=28", locale: "en-CA", auth_provider: "google", google_subject_id: "google-seed-tutor", is_client_enabled: 0, is_provider_enabled: 1, status: "active", email_verified_at: dt(-100), last_login_at: dt(-1, "11:15:00"), created_at: dt(-160), updated_at: dt(-1, "11:15:00") } },
      { table: "users", row: { id: ids.users.provider5, email: "sam.peinture@jobizy.local", password_hash: "provider123456", first_name: "Samir", last_name: "Haddad", phone: "5145550255", avatar_url: "https://i.pravatar.cc/300?img=33", locale: "fr-CA", auth_provider: "local", google_subject_id: null, is_client_enabled: 0, is_provider_enabled: 1, status: "active", email_verified_at: dt(-90), last_login_at: dt(-10, "13:30:00"), created_at: dt(-150), updated_at: dt(-10, "13:30:00") } },
      { table: "users", row: { id: ids.users.suspended, email: "compte.suspendu@jobizy.local", password_hash: "provider123456", first_name: "Leo", last_name: "Benoit", phone: "4385550266", avatar_url: "https://i.pravatar.cc/300?img=52", locale: "fr-CA", auth_provider: "local", google_subject_id: null, is_client_enabled: 1, is_provider_enabled: 1, status: "suspended", email_verified_at: dt(-140), last_login_at: dt(-40, "09:00:00"), created_at: dt(-170), updated_at: dt(-30, "10:20:00") } },
    ]);

    await execMany(connection, [
      { table: "notification_preferences", row: { id: ids.preferences.admin, user_id: ids.users.admin, email_messages_enabled: 1, email_quotes_enabled: 1, email_billing_enabled: 1, email_marketing_enabled: 0, push_enabled: 1, created_at: dt(-240), updated_at: dt(-10) } },
      { table: "notification_preferences", row: { id: ids.preferences.client1, user_id: ids.users.client1, email_messages_enabled: 1, email_quotes_enabled: 1, email_billing_enabled: 1, email_marketing_enabled: 1, push_enabled: 1, created_at: dt(-120), updated_at: dt(-5) } },
      { table: "notification_preferences", row: { id: ids.preferences.client2, user_id: ids.users.client2, email_messages_enabled: 1, email_quotes_enabled: 1, email_billing_enabled: 1, email_marketing_enabled: 0, push_enabled: 0, created_at: dt(-110), updated_at: dt(-8) } },
      { table: "notification_preferences", row: { id: ids.preferences.client3, user_id: ids.users.client3, email_messages_enabled: 1, email_quotes_enabled: 0, email_billing_enabled: 1, email_marketing_enabled: 0, push_enabled: 1, created_at: dt(-100), updated_at: dt(-12) } },
      { table: "notification_preferences", row: { id: ids.preferences.provider1, user_id: ids.users.provider1, email_messages_enabled: 1, email_quotes_enabled: 1, email_billing_enabled: 1, email_marketing_enabled: 0, push_enabled: 1, created_at: dt(-200), updated_at: dt(-2) } },
      { table: "notification_preferences", row: { id: ids.preferences.provider2, user_id: ids.users.provider2, email_messages_enabled: 1, email_quotes_enabled: 1, email_billing_enabled: 1, email_marketing_enabled: 0, push_enabled: 0, created_at: dt(-190), updated_at: dt(-2) } },
      { table: "notification_preferences", row: { id: ids.preferences.provider3, user_id: ids.users.provider3, email_messages_enabled: 1, email_quotes_enabled: 1, email_billing_enabled: 1, email_marketing_enabled: 0, push_enabled: 1, created_at: dt(-180), updated_at: dt(-2) } },
      { table: "notification_preferences", row: { id: ids.preferences.provider4, user_id: ids.users.provider4, email_messages_enabled: 1, email_quotes_enabled: 1, email_billing_enabled: 0, email_marketing_enabled: 0, push_enabled: 1, created_at: dt(-160), updated_at: dt(-2) } },
      { table: "notification_preferences", row: { id: ids.preferences.provider5, user_id: ids.users.provider5, email_messages_enabled: 1, email_quotes_enabled: 1, email_billing_enabled: 1, email_marketing_enabled: 0, push_enabled: 0, created_at: dt(-150), updated_at: dt(-2) } },
      { table: "notification_preferences", row: { id: ids.preferences.suspended, user_id: ids.users.suspended, email_messages_enabled: 0, email_quotes_enabled: 0, email_billing_enabled: 1, email_marketing_enabled: 0, push_enabled: 0, created_at: dt(-170), updated_at: dt(-30) } },
    ]);

    await execMany(connection, [
      { table: "provider_profiles", row: { id: ids.providerProfiles.plomberie, user_id: ids.users.provider1, display_name: "Alex Plomberie Express", business_name: "Plomberie Express Montreal", description: "Specialiste des urgences residentielles avec intervention sous 2 heures dans Montreal et Laval.", logo_url: "https://jobizy.local/seed/logos/plomberie.png", cover_url: "https://jobizy.local/seed/covers/plomberie.jpg", verification_status: "verified", provider_status: "active", rating_avg: 4.9, rating_count: 28, response_rate: 97.5, response_time_avg_minutes: 18, completed_missions_count: 24, is_profile_public: 1, created_at: dt(-200), updated_at: dt(-1) } },
      { table: "provider_profiles", row: { id: ids.providerProfiles.clean, user_id: ids.users.provider2, display_name: "Carla Clean & Co", business_name: "Carla Clean & Co", description: "Equipe de nettoyage de fin de bail et grand menage pour condos et appartements.", logo_url: "https://jobizy.local/seed/logos/clean.png", cover_url: "https://jobizy.local/seed/covers/clean.jpg", verification_status: "verified", provider_status: "active", rating_avg: 4.65, rating_count: 19, response_rate: 92.0, response_time_avg_minutes: 43, completed_missions_count: 17, is_profile_public: 1, created_at: dt(-190), updated_at: dt(-1) } },
      { table: "provider_profiles", row: { id: ids.providerProfiles.electric, user_id: ids.users.provider3, display_name: "Julien Electrique", business_name: "JR Energie Habitat", description: "Installateur de bornes VE et modernisation de circuits residentiels.", logo_url: "https://jobizy.local/seed/logos/electric.png", cover_url: "https://jobizy.local/seed/covers/electric.jpg", verification_status: "verified", provider_status: "active", rating_avg: 4.72, rating_count: 11, response_rate: 88.0, response_time_avg_minutes: 65, completed_missions_count: 8, is_profile_public: 1, created_at: dt(-180), updated_at: dt(-3) } },
      { table: "provider_profiles", row: { id: ids.providerProfiles.tutor, user_id: ids.users.provider4, display_name: "Michael Tran Tutorat", business_name: "MT Learning", description: "Tuteur bilingue en mathematiques et sciences pour secondaire et CEGEP.", logo_url: "https://jobizy.local/seed/logos/tutor.png", cover_url: "https://jobizy.local/seed/covers/tutor.jpg", verification_status: "pending", provider_status: "pending_review", rating_avg: 0, rating_count: 0, response_rate: 100, response_time_avg_minutes: 25, completed_missions_count: 0, is_profile_public: 0, created_at: dt(-160), updated_at: dt(-1) } },
      { table: "provider_profiles", row: { id: ids.providerProfiles.paint, user_id: ids.users.provider5, display_name: "Samir Peinture Design", business_name: "Peinture Design Samir", description: "Peinture interieure residentielle, rafraichissement express et finitions locatives.", logo_url: "https://jobizy.local/seed/logos/paint.png", cover_url: "https://jobizy.local/seed/covers/paint.jpg", verification_status: "verified", provider_status: "suspended", rating_avg: 3.85, rating_count: 7, response_rate: 61, response_time_avg_minutes: 180, completed_missions_count: 5, is_profile_public: 0, created_at: dt(-150), updated_at: dt(-20) } },
    ]);

    await execMany(connection, [
      { table: "provider_services", row: { id: "psv_seed_1", provider_profile_id: ids.providerProfiles.plomberie, service_id: ids.services.leakRepair, status: "active", created_at: dt(-190) } },
      { table: "provider_services", row: { id: "psv_seed_2", provider_profile_id: ids.providerProfiles.clean, service_id: ids.services.moveOutCleaning, status: "active", created_at: dt(-180) } },
      { table: "provider_services", row: { id: "psv_seed_3", provider_profile_id: ids.providerProfiles.electric, service_id: ids.services.evCharger, status: "active", created_at: dt(-170) } },
      { table: "provider_services", row: { id: "psv_seed_4", provider_profile_id: ids.providerProfiles.electric, service_id: ids.services.leakRepair, status: "inactive", created_at: dt(-165) } },
      { table: "provider_services", row: { id: "psv_seed_5", provider_profile_id: ids.providerProfiles.tutor, service_id: ids.services.tutoringMath, status: "active", created_at: dt(-150) } },
      { table: "provider_services", row: { id: "psv_seed_6", provider_profile_id: ids.providerProfiles.paint, service_id: ids.services.interiorPainting, status: "active", created_at: dt(-145) } },
      { table: "provider_services", row: { id: "psv_seed_7", provider_profile_id: ids.providerProfiles.paint, service_id: ids.services.moveOutCleaning, status: "inactive", created_at: dt(-145) } },
    ]);

    await execMany(connection, [
      { table: "provider_zones", row: { id: "pzn_seed_1", provider_profile_id: ids.providerProfiles.plomberie, zone_id: ids.zones.plateau, coverage_type: "primary", created_at: dt(-190) } },
      { table: "provider_zones", row: { id: "pzn_seed_2", provider_profile_id: ids.providerProfiles.plomberie, zone_id: ids.zones.chomedey, coverage_type: "secondary", created_at: dt(-190) } },
      { table: "provider_zones", row: { id: "pzn_seed_3", provider_profile_id: ids.providerProfiles.clean, zone_id: ids.zones.vieuxLongueuil, coverage_type: "primary", created_at: dt(-180) } },
      { table: "provider_zones", row: { id: "pzn_seed_4", provider_profile_id: ids.providerProfiles.clean, zone_id: ids.zones.plateau, coverage_type: "secondary", created_at: dt(-180) } },
      { table: "provider_zones", row: { id: "pzn_seed_5", provider_profile_id: ids.providerProfiles.electric, zone_id: ids.zones.chomedey, coverage_type: "primary", created_at: dt(-170) } },
      { table: "provider_zones", row: { id: "pzn_seed_6", provider_profile_id: ids.providerProfiles.electric, zone_id: ids.zones.plateau, coverage_type: "secondary", created_at: dt(-170) } },
      { table: "provider_zones", row: { id: "pzn_seed_7", provider_profile_id: ids.providerProfiles.tutor, zone_id: ids.zones.sainteFoy, coverage_type: "primary", created_at: dt(-150) } },
      { table: "provider_zones", row: { id: "pzn_seed_8", provider_profile_id: ids.providerProfiles.paint, zone_id: ids.zones.plateau, coverage_type: "primary", created_at: dt(-145) } },
    ]);

    const availabilities = [];
    let availabilityIndex = 1;
    for (const profileId of Object.values(ids.providerProfiles)) {
      for (const weekday of [1, 2, 3, 4, 5]) {
        availabilities.push({
          table: "availabilities",
          row: {
            id: `avl_seed_${availabilityIndex++}`,
            provider_profile_id: profileId,
            weekday,
            start_time: profileId === ids.providerProfiles.tutor ? "16:30:00" : "08:30:00",
            end_time: profileId === ids.providerProfiles.tutor ? "21:00:00" : "17:30:00",
            is_active: 1,
            created_at: dt(-120),
            updated_at: dt(-2),
          },
        });
      }
    }
    await execMany(connection, availabilities);

    await execMany(connection, [
      { table: "service_suggestions", row: { id: ids.suggestions.airQuality, submitted_by_user_id: ids.users.client1, category_id: ids.categories.home, subcategory_id: ids.subcategories.cleaning, suggested_name: "Nettoyage de conduits et qualite de l'air", description: "Service pour condos apres renovation avec poussiere persistante.", status: "pending", reviewed_by_user_id: null, reviewed_at: null, created_at: dt(-7, "13:20:00"), updated_at: dt(-2, "10:00:00") } },
      { table: "service_suggestions", row: { id: ids.suggestions.dronePhoto, submitted_by_user_id: ids.users.client3, category_id: ids.categories.tech, subcategory_id: null, suggested_name: "Prise de vues drone pour inspection toiture", description: "Besoin croissant pour inspection preventive et petites coproprietes.", status: "approved", reviewed_by_user_id: ids.users.admin, reviewed_at: dt(-20, "14:10:00"), created_at: dt(-24, "11:00:00"), updated_at: dt(-20, "14:10:00") } },
      { table: "service_suggestions", row: { id: ids.suggestions.smartLock, submitted_by_user_id: ids.users.client2, category_id: ids.categories.trades, subcategory_id: ids.subcategories.electrical, suggested_name: "Installation de serrure intelligente", description: "Ajout de serrure connectee et configuration application mobile.", status: "rejected", reviewed_by_user_id: ids.users.admin, reviewed_at: dt(-16, "09:30:00"), created_at: dt(-18, "09:00:00"), updated_at: dt(-16, "09:30:00") } },
    ]);

    await execMany(connection, [
      { table: "subscriptions", row: { id: ids.subscriptions.plumberPro, user_id: ids.users.provider1, provider_profile_id: ids.providerProfiles.plomberie, plan_id: ids.plans.pro, stripe_customer_id: "cus_seed_plumber", stripe_subscription_id: "sub_seed_plumber", status: "active", starts_at: dt(-45), ends_at: dt(15), cancel_at_period_end: 0, created_at: dt(-45), updated_at: dt(-1) } },
      { table: "subscriptions", row: { id: ids.subscriptions.electricStarter, user_id: ids.users.provider3, provider_profile_id: ids.providerProfiles.electric, plan_id: ids.plans.starter, stripe_customer_id: "cus_seed_electric", stripe_subscription_id: "sub_seed_electric", status: "past_due", starts_at: dt(-32), ends_at: dt(-2), cancel_at_period_end: 1, created_at: dt(-32), updated_at: dt(-2) } },
      { table: "subscriptions", row: { id: ids.subscriptions.tutorFree, user_id: ids.users.provider4, provider_profile_id: ids.providerProfiles.tutor, plan_id: ids.plans.free, stripe_customer_id: null, stripe_subscription_id: null, status: "trial", starts_at: dt(-4), ends_at: dt(10), cancel_at_period_end: 0, created_at: dt(-4), updated_at: dt(-1) } },
    ]);

    await execMany(connection, [
      { table: "payments", row: { id: ids.payments.reqLeak, user_id: ids.users.client1, payment_type: "request_publication", related_entity_type: "request", related_entity_id: ids.requests.leak, amount_cents: 1900, tax_amount_cents: 285, total_amount_cents: 2185, currency: "CAD", provider: "stripe", provider_payment_intent_id: "pi_seed_req_leak", provider_checkout_session_id: "cs_seed_req_leak", status: "paid", paid_at: dt(-9, "08:06:00"), created_at: dt(-9, "08:00:00"), updated_at: dt(-9, "08:06:00") } },
      { table: "payments", row: { id: ids.payments.reqCleaning, user_id: ids.users.client2, payment_type: "request_publication", related_entity_type: "request", related_entity_id: ids.requests.cleaning, amount_cents: 1900, tax_amount_cents: 285, total_amount_cents: 2185, currency: "CAD", provider: "stripe", provider_payment_intent_id: "pi_seed_req_clean", provider_checkout_session_id: "cs_seed_req_clean", status: "paid", paid_at: dt(-15, "19:12:00"), created_at: dt(-15, "19:00:00"), updated_at: dt(-15, "19:12:00") } },
      { table: "payments", row: { id: ids.payments.reqEv, user_id: ids.users.client3, payment_type: "request_publication", related_entity_type: "request", related_entity_id: ids.requests.ev, amount_cents: 2900, tax_amount_cents: 435, total_amount_cents: 3335, currency: "CAD", provider: "stripe", provider_payment_intent_id: "pi_seed_req_ev", provider_checkout_session_id: "cs_seed_req_ev", status: "pending", paid_at: null, created_at: dt(-1, "12:00:00"), updated_at: dt(-1, "12:00:00") } },
      { table: "payments", row: { id: ids.payments.subPlumber, user_id: ids.users.provider1, payment_type: "provider_subscription", related_entity_type: "subscription", related_entity_id: ids.subscriptions.plumberPro, amount_cents: 7900, tax_amount_cents: 1182, total_amount_cents: 9082, currency: "CAD", provider: "stripe", provider_payment_intent_id: "pi_seed_sub_plumber", provider_checkout_session_id: "cs_seed_sub_plumber", status: "paid", paid_at: dt(-15, "06:30:00"), created_at: dt(-15, "06:15:00"), updated_at: dt(-15, "06:30:00") } },
      { table: "payments", row: { id: ids.payments.subElectric, user_id: ids.users.provider3, payment_type: "provider_subscription", related_entity_type: "subscription", related_entity_id: ids.subscriptions.electricStarter, amount_cents: 2900, tax_amount_cents: 435, total_amount_cents: 3335, currency: "CAD", provider: "stripe", provider_payment_intent_id: "pi_seed_sub_electric", provider_checkout_session_id: "cs_seed_sub_electric", status: "failed", paid_at: null, created_at: dt(-2, "05:45:00"), updated_at: dt(-2, "05:50:00") } },
    ]);

    await execMany(connection, [
      { table: "invoices", row: { id: ids.invoices.reqLeak, payment_id: ids.payments.reqLeak, invoice_number: "INV-SEED-REQ-1001", billing_name: "Sophie Martin", billing_address_json: json({ line1: "4210 Rue Cartier", city: "Montreal", province: "QC", postal_code: "H2H2N4", country: "CA" }), subtotal_cents: 1900, tax_cents: 285, total_cents: 2185, currency: "CAD", pdf_url: "https://jobizy.local/invoices/INV-SEED-REQ-1001.pdf", issued_at: dt(-9, "08:10:00"), created_at: dt(-9, "08:10:00") } },
      { table: "invoices", row: { id: ids.invoices.reqCleaning, payment_id: ids.payments.reqCleaning, invoice_number: "INV-SEED-REQ-1002", billing_name: "Marc Girard", billing_address_json: json({ line1: "82 Rue Saint-Charles O", city: "Longueuil", province: "QC", postal_code: "J4H1C4", country: "CA" }), subtotal_cents: 1900, tax_cents: 285, total_cents: 2185, currency: "CAD", pdf_url: "https://jobizy.local/invoices/INV-SEED-REQ-1002.pdf", issued_at: dt(-15, "19:15:00"), created_at: dt(-15, "19:15:00") } },
      { table: "invoices", row: { id: ids.invoices.subPlumber, payment_id: ids.payments.subPlumber, invoice_number: "INV-SEED-SUB-2001", billing_name: "Plomberie Express Montreal", billing_address_json: json({ line1: "991 Rue Beaubien E", city: "Montreal", province: "QC", postal_code: "H2S1T2", country: "CA" }), subtotal_cents: 7900, tax_cents: 1182, total_cents: 9082, currency: "CAD", pdf_url: "https://jobizy.local/invoices/INV-SEED-SUB-2001.pdf", issued_at: dt(-15, "06:32:00"), created_at: dt(-15, "06:32:00") } },
    ]);

    await execMany(connection, [
      { table: "requests", row: { id: ids.requests.leak, client_user_id: ids.users.client1, service_id: ids.services.leakRepair, zone_id: ids.zones.plateau, title: "Fuite sous l'evier de cuisine a regler aujourd'hui", description: "Depuis ce matin il y a une fuite continue sous l'evier. Le meuble commence a gonfler et je dois couper l'eau a chaque utilisation.", desired_date: d(-8), time_window_start: "13:00:00", time_window_end: "18:00:00", urgency: "urgent", budget_min_cents: 12000, budget_max_cents: 22000, work_mode: "onsite", status: "closed", publication_payment_required: 1, publication_price_cents: 1900, publication_tax_cents: 285, publication_total_cents: 2185, published_at: dt(-9, "08:07:00"), expires_at: dt(-2, "23:59:59"), payment_id: ids.payments.reqLeak, created_at: dt(-9, "07:55:00"), updated_at: dt(-4, "16:40:00") } },
      { table: "requests", row: { id: ids.requests.cleaning, client_user_id: ids.users.client2, service_id: ids.services.moveOutCleaning, zone_id: ids.zones.vieuxLongueuil, title: "Nettoyage complet avant remise du logement", description: "Appartement 4 1/2 a nettoyer apres demenagement: electro, armoires, salle de bain, vitres interieures et planchers.", desired_date: d(-12), time_window_start: "09:00:00", time_window_end: "14:00:00", urgency: "standard", budget_min_cents: 18000, budget_max_cents: 30000, work_mode: "onsite", status: "closed", publication_payment_required: 1, publication_price_cents: 1900, publication_tax_cents: 285, publication_total_cents: 2185, published_at: dt(-15, "19:13:00"), expires_at: dt(-6, "23:59:59"), payment_id: ids.payments.reqCleaning, created_at: dt(-15, "18:40:00"), updated_at: dt(-5, "18:20:00") } },
      { table: "requests", row: { id: ids.requests.ev, client_user_id: ids.users.client3, service_id: ids.services.evCharger, zone_id: ids.zones.chomedey, title: "Demande d'installation d'une borne de recharge 240V", description: "Je veux installer une borne niveau 2 dans le garage. Panneau 200A deja en place mais verification requise.", desired_date: d(12), time_window_start: "08:00:00", time_window_end: "17:00:00", urgency: "standard", budget_min_cents: 90000, budget_max_cents: 180000, work_mode: "onsite", status: "payment_pending", publication_payment_required: 1, publication_price_cents: 2900, publication_tax_cents: 435, publication_total_cents: 3335, published_at: null, expires_at: null, payment_id: ids.payments.reqEv, created_at: dt(-1, "11:55:00"), updated_at: dt(-1, "12:00:00") } },
      { table: "requests", row: { id: ids.requests.tutoring, client_user_id: ids.users.client3, service_id: ids.services.tutoringMath, zone_id: ids.zones.sainteFoy, title: "Tutorat maths secondaire 4 deux fois par semaine", description: "Recherche un tuteur patient pour accompagnement jusqu'aux examens de juin, idealement en ligne le soir.", desired_date: d(4), time_window_start: "18:00:00", time_window_end: "20:30:00", urgency: "low", budget_min_cents: 3000, budget_max_cents: 7000, work_mode: "remote", status: "in_discussion", publication_payment_required: 0, publication_price_cents: 0, publication_tax_cents: 0, publication_total_cents: 0, published_at: dt(-3, "09:45:00"), expires_at: dt(7, "23:59:59"), payment_id: null, created_at: dt(-3, "09:10:00"), updated_at: dt(-1, "20:00:00") } },
      { table: "requests", row: { id: ids.requests.painting, client_user_id: ids.users.client1, service_id: ids.services.interiorPainting, zone_id: ids.zones.plateau, title: "Peinture blanche complete d'un 3 1/2 vacant", description: "Appartement libre entre deux locataires, besoin d'un rafraichissement simple mais rapide.", desired_date: d(-1), time_window_start: "08:00:00", time_window_end: "17:00:00", urgency: "standard", budget_min_cents: 40000, budget_max_cents: 70000, work_mode: "onsite", status: "expired", publication_payment_required: 0, publication_price_cents: 0, publication_tax_cents: 0, publication_total_cents: 0, published_at: dt(-12, "10:15:00"), expires_at: dt(-2, "23:59:59"), payment_id: null, created_at: dt(-12, "09:20:00"), updated_at: dt(-2, "23:59:59") } },
      { table: "requests", row: { id: ids.requests.laptop, client_user_id: ids.users.client2, service_id: ids.services.laptopSupport, zone_id: ids.zones.longueuil, title: "Mon portable est tres lent depuis la migration Windows", description: "Je n'ai pas encore publie, je rassemble les details techniques et les sauvegardes necessaires.", desired_date: d(6), time_window_start: "10:00:00", time_window_end: "15:00:00", urgency: "low", budget_min_cents: 8000, budget_max_cents: 15000, work_mode: "hybrid", status: "draft", publication_payment_required: 0, publication_price_cents: 0, publication_tax_cents: 0, publication_total_cents: 0, published_at: null, expires_at: null, payment_id: null, created_at: dt(-2, "17:30:00"), updated_at: dt(-1, "18:45:00") } },
    ]);

    await execMany(connection, [
      { table: "request_attachments", row: { id: ids.attachments.leakPhoto, request_id: ids.requests.leak, file_url: "https://jobizy.local/seed/requests/fuite-evier.jpg", file_type: "image/jpeg", created_at: dt(-9, "08:02:00") } },
      { table: "request_attachments", row: { id: ids.attachments.cleaningPhoto, request_id: ids.requests.cleaning, file_url: "https://jobizy.local/seed/requests/etat-appartement.jpg", file_type: "image/jpeg", created_at: dt(-15, "18:50:00") } },
      { table: "request_attachments", row: { id: ids.attachments.paintPlan, request_id: ids.requests.painting, file_url: "https://jobizy.local/seed/requests/plan-peinture.pdf", file_type: "application/pdf", created_at: dt(-12, "09:25:00") } },
    ]);

    await execMany(connection, [
      { table: "matches", row: { id: ids.matches.leakPlumber, request_id: ids.requests.leak, provider_profile_id: ids.providerProfiles.plomberie, match_score: 96, match_reason: json({ service: "exact", zone: "primary", availability: "fast" }), is_visible_to_provider: 1, notified_at: dt(-9, "08:10:00"), responded_at: dt(-9, "08:45:00"), created_at: dt(-9, "08:10:00") } },
      { table: "matches", row: { id: ids.matches.leakElectric, request_id: ids.requests.leak, provider_profile_id: ids.providerProfiles.electric, match_score: 71, match_reason: json({ service: "adjacent", zone: "secondary" }), is_visible_to_provider: 1, notified_at: dt(-9, "08:11:00"), responded_at: dt(-9, "11:20:00"), created_at: dt(-9, "08:11:00") } },
      { table: "matches", row: { id: ids.matches.cleaningClean, request_id: ids.requests.cleaning, provider_profile_id: ids.providerProfiles.clean, match_score: 94, match_reason: json({ service: "exact", zone: "primary", subscription: "active" }), is_visible_to_provider: 1, notified_at: dt(-15, "19:20:00"), responded_at: dt(-15, "19:40:00"), created_at: dt(-15, "19:20:00") } },
      { table: "matches", row: { id: ids.matches.cleaningPaint, request_id: ids.requests.cleaning, provider_profile_id: ids.providerProfiles.paint, match_score: 55, match_reason: json({ service: "partial", zone: "secondary", provider_status: "suspended" }), is_visible_to_provider: 0, notified_at: null, responded_at: null, created_at: dt(-15, "19:21:00") } },
      { table: "matches", row: { id: ids.matches.tutoringTutor, request_id: ids.requests.tutoring, provider_profile_id: ids.providerProfiles.tutor, match_score: 92, match_reason: json({ service: "exact", mode: "remote", language: "bilingual" }), is_visible_to_provider: 1, notified_at: dt(-3, "10:00:00"), responded_at: dt(-3, "12:10:00"), created_at: dt(-3, "10:00:00") } },
      { table: "matches", row: { id: ids.matches.paintingPaint, request_id: ids.requests.painting, provider_profile_id: ids.providerProfiles.paint, match_score: 86, match_reason: json({ service: "exact", zone: "primary", provider_status: "suspended" }), is_visible_to_provider: 0, notified_at: null, responded_at: null, created_at: dt(-12, "10:25:00") } },
    ]);

    await execMany(connection, [
      { table: "quotes", row: { id: ids.quotes.leakPlumber, request_id: ids.requests.leak, provider_profile_id: ids.providerProfiles.plomberie, message: "Je peux passer cet apres-midi avec pieces standard pour fuite sous evier.", estimated_price_cents: 16500, proposed_date: d(-8), proposed_time_window: "14:00-16:00", status: "accepted", submitted_at: dt(-9, "08:50:00"), updated_at: dt(-8, "09:10:00") } },
      { table: "quotes", row: { id: ids.quotes.leakElectric, request_id: ids.requests.leak, provider_profile_id: ids.providerProfiles.electric, message: "Je peux verifier si le probleme touche aussi le chauffe-eau ou une alimentation electrique adjacente.", estimated_price_cents: 21000, proposed_date: d(-8), proposed_time_window: "16:00-18:00", status: "rejected", submitted_at: dt(-9, "11:25:00"), updated_at: dt(-8, "08:40:00") } },
      { table: "quotes", row: { id: ids.quotes.cleaningClean, request_id: ids.requests.cleaning, provider_profile_id: ids.providerProfiles.clean, message: "Equipe de 2 personnes, produits inclus, fin de bail complete.", estimated_price_cents: 24000, proposed_date: d(-12), proposed_time_window: "09:30-13:30", status: "accepted", submitted_at: dt(-15, "19:42:00"), updated_at: dt(-14, "09:00:00") } },
      { table: "quotes", row: { id: ids.quotes.cleaningPaint, request_id: ids.requests.cleaning, provider_profile_id: ids.providerProfiles.paint, message: "Je peux sous-traiter le nettoyage avec mon equipe partenaire.", estimated_price_cents: 28500, proposed_date: d(-11), proposed_time_window: "10:00-15:00", status: "closed_lost", submitted_at: dt(-15, "21:10:00"), updated_at: dt(-14, "09:05:00") } },
      { table: "quotes", row: { id: ids.quotes.tutoringTutor, request_id: ids.requests.tutoring, provider_profile_id: ids.providerProfiles.tutor, message: "Disponible deux soirs par semaine en ligne avec suivi d'exercices.", estimated_price_cents: 4500, proposed_date: d(5), proposed_time_window: "18:30-20:00", status: "submitted", submitted_at: dt(-3, "12:12:00"), updated_at: dt(-1, "20:00:00") } },
      { table: "quotes", row: { id: ids.quotes.paintingPaint, request_id: ids.requests.painting, provider_profile_id: ids.providerProfiles.paint, message: "Peinture standard blanc casse, materiel inclus, delai 1 jour.", estimated_price_cents: 52000, proposed_date: d(0), proposed_time_window: "08:00-17:00", status: "withdrawn", submitted_at: dt(-11, "08:40:00"), updated_at: dt(-10, "12:00:00") } },
    ]);

    await execMany(connection, [
      { table: "missions", row: { id: ids.missions.leak, request_id: ids.requests.leak, quote_id: ids.quotes.leakPlumber, client_user_id: ids.users.client1, provider_profile_id: ids.providerProfiles.plomberie, status: "completed", started_at: dt(-8, "14:15:00"), completed_at: dt(-8, "16:05:00"), cancelled_at: null, created_at: dt(-8, "09:15:00"), updated_at: dt(-8, "16:05:00") } },
      { table: "missions", row: { id: ids.missions.cleaning, request_id: ids.requests.cleaning, quote_id: ids.quotes.cleaningClean, client_user_id: ids.users.client2, provider_profile_id: ids.providerProfiles.clean, status: "disputed", started_at: dt(-12, "09:35:00"), completed_at: null, cancelled_at: null, created_at: dt(-14, "09:10:00"), updated_at: dt(-5, "18:20:00") } },
    ]);

    await execMany(connection, [
      { table: "conversations", row: { id: ids.conversations.leak, request_id: ids.requests.leak, mission_id: ids.missions.leak, client_user_id: ids.users.client1, provider_profile_id: ids.providerProfiles.plomberie, status: "archived", created_at: dt(-9, "08:30:00"), updated_at: dt(-8, "16:10:00") } },
      { table: "conversations", row: { id: ids.conversations.cleaning, request_id: ids.requests.cleaning, mission_id: ids.missions.cleaning, client_user_id: ids.users.client2, provider_profile_id: ids.providerProfiles.clean, status: "active", created_at: dt(-15, "19:30:00"), updated_at: dt(-5, "18:00:00") } },
      { table: "conversations", row: { id: ids.conversations.tutoring, request_id: ids.requests.tutoring, mission_id: null, client_user_id: ids.users.client3, provider_profile_id: ids.providerProfiles.tutor, status: "active", created_at: dt(-3, "12:05:00"), updated_at: dt(-1, "20:00:00") } },
    ]);

    await execMany(connection, [
      { table: "messages", row: { id: ids.messages.leak1, conversation_id: ids.conversations.leak, sender_user_id: ids.users.client1, message_type: "text", body: "Bonjour, pouvez-vous venir aujourd'hui ? La fuite empire.", attachment_url: null, read_at: dt(-9, "08:35:00"), created_at: dt(-9, "08:31:00") } },
      { table: "messages", row: { id: ids.messages.leak2, conversation_id: ids.conversations.leak, sender_user_id: ids.users.provider1, message_type: "text", body: "Oui, j'arrive vers 14h avec le materiel necessaire.", attachment_url: null, read_at: dt(-9, "08:38:00"), created_at: dt(-9, "08:36:00") } },
      { table: "messages", row: { id: ids.messages.leak3, conversation_id: ids.conversations.leak, sender_user_id: ids.users.client1, message_type: "text", body: "Parfait, je serai sur place. Merci.", attachment_url: null, read_at: dt(-9, "08:42:00"), created_at: dt(-9, "08:39:00") } },
      { table: "messages", row: { id: ids.messages.clean1, conversation_id: ids.conversations.cleaning, sender_user_id: ids.users.client2, message_type: "text", body: "Il reste des traces sur les plinthes et le four n'est pas completement nettoye.", attachment_url: null, read_at: dt(-5, "18:02:00"), created_at: dt(-5, "17:45:00") } },
      { table: "messages", row: { id: ids.messages.clean2, conversation_id: ids.conversations.cleaning, sender_user_id: ids.users.provider2, message_type: "text", body: "Nous pouvons repasser demain matin ou ouvrir un dossier si besoin.", attachment_url: null, read_at: dt(-5, "18:10:00"), created_at: dt(-5, "18:00:00") } },
      { table: "messages", row: { id: ids.messages.tutor1, conversation_id: ids.conversations.tutoring, sender_user_id: ids.users.provider4, message_type: "text", body: "Je peux proposer une premiere seance de diagnostic mercredi a 18h30.", attachment_url: null, read_at: dt(-1, "20:05:00"), created_at: dt(-1, "19:55:00") } },
    ]);

    await execMany(connection, [
      { table: "reviews", row: { id: ids.reviews.leakClient, mission_id: ids.missions.leak, author_user_id: ids.users.client1, target_provider_profile_id: ids.providerProfiles.plomberie, target_user_id: null, rating: 5, comment: "Intervention tres rapide, explications claires et fuite resolue en une visite.", status: "published", published_at: dt(-7, "09:00:00"), created_at: dt(-7, "09:00:00"), updated_at: dt(-7, "09:00:00") } },
      { table: "reviews", row: { id: ids.reviews.leakProvider, mission_id: ids.missions.leak, author_user_id: ids.users.provider1, target_provider_profile_id: null, target_user_id: ids.users.client1, rating: 5, comment: "Cliente reactive et disponible, acces facile et consignes precises.", status: "published", published_at: dt(-7, "10:10:00"), created_at: dt(-7, "10:10:00"), updated_at: dt(-7, "10:10:00") } },
    ]);

    await execMany(connection, [
      { table: "disputes", row: { id: ids.disputes.cleaning, mission_id: ids.missions.cleaning, request_id: ids.requests.cleaning, opened_by_user_id: ids.users.client2, against_user_id: ids.users.provider2, category: "quality_issue", description: "Le nettoyage final ne correspond pas au niveau attendu avant remise au proprietaire.", status: "under_review", resolution_type: null, resolution_note: null, resolved_at: null, created_at: dt(-5, "18:15:00"), updated_at: dt(-4, "10:00:00") } },
    ]);

    await execMany(connection, [
      { table: "dispute_messages", row: { id: ids.disputeMessages.cleaning1, dispute_id: ids.disputes.cleaning, sender_user_id: ids.users.client2, body: "J'ai ajoute des photos des zones oubliees dans la cuisine.", attachment_url: "https://jobizy.local/seed/disputes/clean-kitchen.jpg", created_at: dt(-5, "18:16:00") } },
      { table: "dispute_messages", row: { id: ids.disputeMessages.cleaning2, dispute_id: ids.disputes.cleaning, sender_user_id: ids.users.provider2, body: "Nous proposons un passage correctif demain matin sans frais supplementaires.", attachment_url: null, created_at: dt(-5, "18:25:00") } },
      { table: "dispute_messages", row: { id: ids.disputeMessages.cleaning3, dispute_id: ids.disputes.cleaning, sender_user_id: ids.users.admin, body: "Le dossier est pris en charge par l'equipe support, merci de partager toute preuve complementaire.", attachment_url: null, created_at: dt(-4, "10:00:00") } },
    ]);

    await execMany(connection, [
      { table: "notifications", row: { id: ids.notifications.n1, user_id: ids.users.client1, type: "request_published", title: "Demande publiee", body: "Votre demande de plomberie est en ligne.", data_json: json({ request_id: ids.requests.leak }), channel: "in_app", is_read: 1, sent_at: dt(-9, "08:07:00"), created_at: dt(-9, "08:07:00") } },
      { table: "notifications", row: { id: ids.notifications.n2, user_id: ids.users.provider1, type: "new_match", title: "Nouvelle demande disponible", body: "Une urgence plomberie correspond a votre profil.", data_json: json({ request_id: ids.requests.leak, match_id: ids.matches.leakPlumber }), channel: "in_app", is_read: 1, sent_at: dt(-9, "08:10:00"), created_at: dt(-9, "08:10:00") } },
      { table: "notifications", row: { id: ids.notifications.n3, user_id: ids.users.client1, type: "new_quote_received", title: "Nouvelle offre recue", body: "Alex Plomberie Express a envoye une offre.", data_json: json({ quote_id: ids.quotes.leakPlumber }), channel: "email", is_read: 1, sent_at: dt(-9, "08:50:00"), created_at: dt(-9, "08:50:00") } },
      { table: "notifications", row: { id: ids.notifications.n4, user_id: ids.users.client2, type: "mission_created", title: "Mission demarree", body: "La mission de nettoyage est en cours.", data_json: json({ mission_id: ids.missions.cleaning }), channel: "in_app", is_read: 1, sent_at: dt(-12, "09:35:00"), created_at: dt(-12, "09:35:00") } },
      { table: "notifications", row: { id: ids.notifications.n5, user_id: ids.users.client2, type: "dispute_opened", title: "Litige ouvert", body: "Votre litige a ete enregistre.", data_json: json({ dispute_id: ids.disputes.cleaning }), channel: "in_app", is_read: 0, sent_at: dt(-5, "18:15:00"), created_at: dt(-5, "18:15:00") } },
      { table: "notifications", row: { id: ids.notifications.n6, user_id: ids.users.provider2, type: "dispute_opened_against_you", title: "Litige sur une mission", body: "Un litige a ete ouvert sur votre mission de nettoyage.", data_json: json({ dispute_id: ids.disputes.cleaning }), channel: "email", is_read: 1, sent_at: dt(-5, "18:20:00"), created_at: dt(-5, "18:20:00") } },
      { table: "notifications", row: { id: ids.notifications.n7, user_id: ids.users.provider4, type: "new_match", title: "Nouvelle demande disponible", body: "Une demande de tutorat correspond a votre profil.", data_json: json({ request_id: ids.requests.tutoring, match_id: ids.matches.tutoringTutor }), channel: "push_pwa", is_read: 0, sent_at: dt(-3, "10:00:00"), created_at: dt(-3, "10:00:00") } },
      { table: "notifications", row: { id: ids.notifications.n8, user_id: ids.users.admin, type: "security_alert", title: "Jeton revoque", body: "Un refresh token a ete revoque pour revision support.", data_json: json({ refresh_token_id: ids.refreshTokens.revoked }), channel: "in_app", is_read: 0, sent_at: dt(-1, "09:15:00"), created_at: dt(-1, "09:15:00") } },
    ]);

    await execMany(connection, [
      { table: "audit_logs", row: { id: ids.audit.a1, actor_user_id: ids.users.admin, entity_type: "service_suggestion", entity_id: ids.suggestions.dronePhoto, action: "suggestion_approved", old_values_json: json({ status: "pending" }), new_values_json: json({ status: "approved" }), ip_address: "127.0.0.1", created_at: dt(-20, "14:10:00") } },
      { table: "audit_logs", row: { id: ids.audit.a2, actor_user_id: ids.users.client1, entity_type: "request", entity_id: ids.requests.leak, action: "request_created", old_values_json: null, new_values_json: json({ status: "draft" }), ip_address: "192.168.1.11", created_at: dt(-9, "07:55:00") } },
      { table: "audit_logs", row: { id: ids.audit.a3, actor_user_id: ids.users.client1, entity_type: "request", entity_id: ids.requests.leak, action: "request_published", old_values_json: json({ status: "draft" }), new_values_json: json({ status: "published" }), ip_address: "192.168.1.11", created_at: dt(-9, "08:07:00") } },
      { table: "audit_logs", row: { id: ids.audit.a4, actor_user_id: ids.users.admin, entity_type: "dispute", entity_id: ids.disputes.cleaning, action: "admin_under_review", old_values_json: json({ status: "open" }), new_values_json: json({ status: "under_review" }), ip_address: "127.0.0.1", created_at: dt(-4, "10:00:00") } },
      { table: "audit_logs", row: { id: ids.audit.a5, actor_user_id: ids.users.admin, entity_type: "admin_user", entity_id: ids.users.admin, action: "admin_user_seeded", old_values_json: null, new_values_json: json({ email: "admin@jobizy.local", roles: ["super_admin", "ops_manager"] }), ip_address: "127.0.0.1", created_at: dt(-1, "08:50:00") } },
      { table: "audit_logs", row: { id: ids.audit.a6, actor_user_id: ids.users.admin, entity_type: "refresh_token", entity_id: ids.refreshTokens.revoked, action: "token_revoked", old_values_json: json({ revoked_at: null }), new_values_json: json({ revoked_at: dt(-1, "09:10:00") }), ip_address: "127.0.0.1", created_at: dt(-1, "09:10:00") } },
    ]);

    await execMany(connection, [
      { table: "refresh_tokens", row: { id: ids.refreshTokens.admin, user_id: ids.users.admin, token_hash: "hash_seed_admin_active", expires_at: dt(14, "23:59:59"), revoked_at: null, ip_address: "127.0.0.1", user_agent: "Jobizy Admin Chrome/135", created_at: dt(-1, "08:45:00") } },
      { table: "refresh_tokens", row: { id: ids.refreshTokens.client1, user_id: ids.users.client1, token_hash: "hash_seed_sophie_active", expires_at: dt(9, "23:59:59"), revoked_at: null, ip_address: "192.168.1.11", user_agent: "iPhone Safari", created_at: dt(-1, "20:14:00") } },
      { table: "refresh_tokens", row: { id: ids.refreshTokens.provider1, user_id: ids.users.provider1, token_hash: "hash_seed_plumber_active", expires_at: dt(12, "23:59:59"), revoked_at: null, ip_address: "172.16.10.4", user_agent: "Android Chrome", created_at: dt(0, "07:10:00") } },
      { table: "refresh_tokens", row: { id: ids.refreshTokens.revoked, user_id: ids.users.client2, token_hash: "hash_seed_revoked", expires_at: dt(5, "23:59:59"), revoked_at: dt(-1, "09:10:00"), ip_address: "10.0.0.44", user_agent: "Windows Edge", created_at: dt(-3, "18:20:00") } },
    ]);

    await execMany(connection, [
      { table: "admin_roles", row: { id: ids.adminRoles.superAdmin, code: "super_admin", name: "Super Admin", description: "Acces complet a la console admin", status: "active", is_system: 1, permissions_json: json(allAdminPermissions), created_at: dt(-240), updated_at: dt(-1) }, updateKeys: ["name", "description", "status", "is_system", "permissions_json", "updated_at"] },
      { table: "admin_roles", row: { id: ids.adminRoles.opsManager, code: "ops_manager", name: "Operations Manager", description: "Pilotage operations, demandes, missions et litiges.", status: "active", is_system: 0, permissions_json: json(["dashboard.view", "requests.view", "requests.edit", "requests.workflow", "matching.view", "quotes.view", "quotes.edit", "quotes.workflow", "missions.view", "missions.edit", "missions.workflow", "conversations.view", "disputes.view", "disputes.edit", "disputes.workflow", "notifications.view", "audit.view", "users.view", "providers.view"]), created_at: dt(-200), updated_at: dt(-1) }, updateKeys: ["name", "description", "status", "is_system", "permissions_json", "updated_at"] },
      { table: "admin_roles", row: { id: ids.adminRoles.supportAgent, code: "support_agent", name: "Support Agent", description: "Lecture des comptes, moderation legere et suivi support.", status: "active", is_system: 0, permissions_json: json(["dashboard.view", "users.view", "providers.view", "requests.view", "quotes.view", "missions.view", "conversations.view", "reviews.view", "disputes.view", "notifications.view", "security.view"]), created_at: dt(-180), updated_at: dt(-1) }, updateKeys: ["name", "description", "status", "is_system", "permissions_json", "updated_at"] },
    ]);

    await execMany(connection, [
      { table: "admin_user_roles", row: { id: ids.adminAssignments.superAdmin, user_id: ids.users.admin, admin_role_id: ids.adminRoles.superAdmin, status: "active", assigned_by_user_id: ids.users.admin, created_at: dt(-200), updated_at: dt(-1) }, updateKeys: ["status", "assigned_by_user_id", "updated_at"] },
      { table: "admin_user_roles", row: { id: ids.adminAssignments.opsManager, user_id: ids.users.provider1, admin_role_id: ids.adminRoles.opsManager, status: "active", assigned_by_user_id: ids.users.admin, created_at: dt(-90), updated_at: dt(-1) }, updateKeys: ["status", "assigned_by_user_id", "updated_at"] },
      { table: "admin_user_roles", row: { id: ids.adminAssignments.supportAgent, user_id: ids.users.provider2, admin_role_id: ids.adminRoles.supportAgent, status: "inactive", assigned_by_user_id: ids.users.admin, created_at: dt(-60), updated_at: dt(-10) }, updateKeys: ["status", "assigned_by_user_id", "updated_at"] },
    ]);

    await connection.commit();
    console.log("Seed scenarios imported successfully.");
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

seed().catch((error) => {
  console.error("Failed to seed scenarios", error);
  process.exit(1);
});
