/**
 * IndexedDB-backed order cache with 7-day TTL
 */

let db;
const DB_NAME = 'FunPrintingPartnerDB';
const STORE_NAME = 'ordersCache';

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'orderId' });
      }
    };
    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
      setTimeout(cleanupExpiredCache, 2000);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

async function cleanupExpiredCache() {
  if (!db) return;
  try {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const now = Date.now();
      request.result.forEach(order => {
        if (order.expiry && order.expiry < now) {
          store.delete(order.orderId);
        }
      });
    };
  } catch (e) {
    console.error("Cache cleanup failed", e);
  }
}

async function cacheOrder(order) {
  if (!db) await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    order.lastAccessed = Date.now();
    order.expiry = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 days TTL
    store.put(order);
    transaction.oncomplete = () => resolve();
    transaction.onerror = (e) => reject(e);
  });
}

async function getCachedOrder(orderId) {
  if (!db) await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(orderId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e);
  });
}

async function getAllCachedOrders() {
  if (!db) await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e);
  });
}

function getDB() { return db; }
function getStoreName() { return STORE_NAME; }
