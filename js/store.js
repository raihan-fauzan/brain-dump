// IndexedDB-backed note store. No server, no accounts: the browser is the database.

const DB_NAME = "brain-dump";
const DB_VERSION = 1;
const NOTES = "notes";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NOTES)) {
        const store = db.createObjectStore(NOTES, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(NOTES, mode);
        const store = t.objectStore(NOTES);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

/** All notes, newest first. */
export async function listNotes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(NOTES, "readonly").objectStore(NOTES).getAll();
    req.onsuccess = () => {
      const notes = req.result || [];
      notes.sort((a, b) => b.createdAt - a.createdAt);
      resolve(notes);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getNote(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(NOTES, "readonly").objectStore(NOTES).get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** Insert or update. `doc` is the full Markdown document. */
export async function saveNote({ id, doc, createdAt }) {
  const now = Date.now();
  const existing = await getNote(id);
  if (existing) {
    existing.doc = doc;
    existing.updatedAt = now;
    await put(existing);
    return existing;
  }
  const note = { id, doc, createdAt: createdAt ?? now, updatedAt: now };
  await put(note);
  return note;
}

function put(note) {
  return tx("readwrite", (store) => store.put(note));
}

export async function deleteNote(id) {
  await tx("readwrite", (store) => store.delete(id));
}
