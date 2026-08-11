import { db } from './schema';

/**
 * Backup, restore and export.
 *
 * With no server and no account, the export file *is* your safety net, so it
 * has to be complete, portable and readable in ten years. It is plain JSON,
 * optionally wrapped in authenticated encryption when a passphrase is given —
 * because a diary of everything you eat and weigh is personal, and it is about
 * to be dropped into a cloud folder.
 *
 * Restore merges rather than replaces: every record carries a UUID and an
 * `updatedAt`, so the newer version of each record wins. That makes importing
 * a backup onto a device that has kept logging safe, and is the same rule a
 * future device-to-device sync will use.
 */

const FORMAT = 'fuelflow.backup';
const FORMAT_VERSION = 1;

const TABLES = [
  'profile',
  'foods',
  'entries',
  'recipes',
  'mealTemplates',
  'weights',
  'biometrics',
  'water',
  'exercise',
  'fasts',
  'usage',
  'dayMeta',
  'kv',
] as const;

type TableName = (typeof TABLES)[number];

export interface BackupFile {
  format: typeof FORMAT;
  version: number;
  createdAt: string;
  app: string;
  /** Rows per table. */
  data: Record<string, unknown[]>;
}

export interface EncryptedBackup {
  format: typeof FORMAT;
  version: number;
  encrypted: true;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface ExportOptions {
  /** Omit the bundled USDA foods, which are re-downloadable and dominate size. */
  includeCoreFoods?: boolean;
  passphrase?: string;
}

export async function exportBackup(options: ExportOptions = {}): Promise<Blob> {
  const data: Record<string, unknown[]> = {};

  for (const table of TABLES) {
    const rows = await db.table(table).toArray();
    data[table] =
      table === 'foods' && !options.includeCoreFoods
        ? rows.filter((row: { source?: string }) => row.source !== 'usda')
        : rows;
  }

  const backup: BackupFile = {
    format: FORMAT,
    version: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    app: 'FuelFlow',
    data,
  };

  const json = JSON.stringify(backup);
  if (!options.passphrase) {
    return new Blob([json], { type: 'application/json' });
  }

  const encrypted = await encrypt(json, options.passphrase);
  return new Blob([JSON.stringify(encrypted)], { type: 'application/json' });
}

export interface ImportResult {
  imported: number;
  skipped: number;
  tables: Partial<Record<TableName, number>>;
}

export async function importBackup(file: File | string, passphrase?: string): Promise<ImportResult> {
  const text = typeof file === 'string' ? file : await file.text();
  let parsed: BackupFile | EncryptedBackup;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not a FuelFlow backup.');
  }

  if ('encrypted' in parsed && parsed.encrypted) {
    if (!passphrase) throw new Error('This backup is encrypted. Enter its passphrase to restore it.');
    const decrypted = await decrypt(parsed, passphrase);
    parsed = JSON.parse(decrypted) as BackupFile;
  }

  const backup = parsed as BackupFile;
  if (backup.format !== FORMAT) throw new Error('That file is not a FuelFlow backup.');
  if (backup.version > FORMAT_VERSION) {
    throw new Error('This backup was made by a newer version of FuelFlow. Update the app first.');
  }

  const result: ImportResult = { imported: 0, skipped: 0, tables: {} };

  for (const table of TABLES) {
    const rows = backup.data[table];
    if (!Array.isArray(rows) || rows.length === 0) continue;

    const target = db.table(table);
    const keyPath = target.schema.primKey.keyPath as string;
    const incoming = rows as Record<string, unknown>[];
    const keys = incoming.map((row) => row[keyPath]);
    const existing = await target.bulkGet(keys as never[]);

    const toWrite: unknown[] = [];
    incoming.forEach((row, index) => {
      const current = existing[index] as { updatedAt?: number } | undefined;
      const incomingAt = typeof row.updatedAt === 'number' ? row.updatedAt : 0;
      // Last write wins. Equal timestamps keep what is already on the device,
      // so re-importing the same file is a no-op.
      if (current && (current.updatedAt ?? 0) >= incomingAt) {
        result.skipped++;
        return;
      }
      toWrite.push(row);
    });

    if (toWrite.length > 0) {
      await target.bulkPut(toWrite as never[]);
      result.imported += toWrite.length;
      result.tables[table] = toWrite.length;
    }
  }

  return result;
}

/** Diary export for spreadsheets and for anything that is not FuelFlow. */
export async function exportCsv(): Promise<Blob> {
  const entries = await db.entries.toArray();
  const live = entries.filter((e) => !e.deleted).sort((a, b) => (a.day < b.day ? -1 : 1));

  const header = ['date', 'meal', 'food', 'brand', 'grams', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'];
  const escape = (value: unknown) => {
    const text = value === undefined || value === null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [header.join(',')];
  for (const entry of live) {
    lines.push(
      [
        entry.day,
        entry.mealId,
        entry.name,
        entry.brand ?? '',
        Math.round(entry.grams * 10) / 10,
        Math.round(entry.nutrients[208] ?? 0),
        round1(entry.nutrients[203]),
        round1(entry.nutrients[205]),
        round1(entry.nutrients[204]),
        round1(entry.nutrients[291]),
      ]
        .map(escape)
        .join(','),
    );
  }
  return new Blob([lines.join('\n')], { type: 'text/csv' });
}

function round1(value: number | undefined): string {
  return value === undefined ? '' : String(Math.round(value * 10) / 10);
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

const ITERATIONS = 310_000; // OWASP guidance for PBKDF2-HMAC-SHA256.

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encrypt(plaintext: string, passphrase: string): Promise<EncryptedBackup> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );

  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    encrypted: true,
    kdf: 'PBKDF2-SHA256',
    iterations: ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

async function decrypt(backup: EncryptedBackup, passphrase: string): Promise<string> {
  const salt = fromBase64(backup.salt);
  const iv = fromBase64(backup.iv);
  const key = await deriveKey(passphrase, salt);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      fromBase64(backup.ciphertext) as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // AES-GCM authentication failure is indistinguishable from a wrong key,
    // which is exactly the property that makes it safe.
    throw new Error('Wrong passphrase, or the file is damaged.');
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Trigger a browser download; on native, Capacitor's share sheet takes over. */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const { Capacitor } = await import('@capacitor/core');

  if (Capacitor.isNativePlatform()) {
    const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
      import('@capacitor/filesystem'),
      import('@capacitor/share'),
    ]);
    const text = await blob.text();
    const { uri } = await Filesystem.writeFile({
      path: filename,
      data: text,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    await Share.share({ title: filename, url: uri });
    return;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
