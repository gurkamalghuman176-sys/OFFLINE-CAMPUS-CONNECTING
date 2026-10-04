/**
 * Offline Campus Connect - Main Client Script
 * Manages IndexedDB local state, sync queue, network detection, and backend API integration.
 */

const api_base_url = 'http://localhost:3000';

const DB_NAME = 'CampusConnectDB';
const DB_VERSION = 1;

let db = null;
let isSyncing = false;

// Register Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('[SW] Service Worker registered:', reg.scope))
      .catch(err => console.error('[SW] Registration failed:', err));
  });
}

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await initIndexedDB();
    setupEventListeners();
    updateOnlineStatus();
    await renderTasks();
    await processSyncQueue(); // Process any residual pending changes on startup
  } catch (err) {
    showToast('Failed to initialize local database.', 'error');
    console.error('Init Error:', err);
  }
});

/* ==========================================
   1. INDEXEDDB DATABASE MANAGEMENT
   ========================================== */

function initIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const dbInstance = event.target.result;
      
      // Store 1: Local Tasks cache
      if (!dbInstance.objectStoreNames.contains('tasks')) {
        dbInstance.createObjectStore('tasks', { keyPath: 'id' });
      }

      // Store 2: Offline Synchronization Queue
      if (!dbInstance.objectStoreNames.contains('syncQueue')) {
        dbInstance.createObjectStore('syncQueue', { keyPath: 'queueId', autoIncrement: true });
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      console.log('[IndexedDB] Database initialized');
      resolve(db);
    };

    request.onerror = (event) => {
      console.error('[IndexedDB] Error:', event.target.error);
      reject(event.target.error);
    };
  });
}

// Database Helpers (Promises)
function getAllFromStore(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putToStore(storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(value);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function removeFromStore(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function addQueueItem(operation) {
  return putToStore('syncQueue', operation);
}

/* ==========================================
   2. DOM & UI MANAGERS
   ========================================== */

function setupEventListeners() {
  const form = document.getElementById('task-form');
  form.addEventListener('submit', handleAddTask);

  window.addEventListener('online', handleNetworkChange);
  window.addEventListener('offline', handleNetworkChange);
}

function updateOnlineStatus() {
  const netStatusPill = document.getElementById('net-status');
  const netStatusText = document.getElementById('net-status-text');

  if (navigator.onLine) {
    netStatusPill.className = 'status-pill status-online';
    netStatusText.textContent = '🟢 Online';
  } else {
    netStatusPill.className = 'status-pill status-offline';
    netStatusText.textContent = '🔴 Offline';
  }
}

async function updateSyncStatusUI() {
  const syncStatusText = document.getElementById('sync-status-text');
  const queue = await getAllFromStore('syncQueue');

  if (queue.length === 0) {
    syncStatusText.textContent = '✅ All changes synchronized';
  } else {
    syncStatusText.textContent = `⏳ ${queue.length} change(s) pending sync`;
  }
}

async function renderTasks() {
  const taskList = document.getElementById('task-list');
  const emptyState = document.getElementById('empty-state');
  const taskCount = document.getElementById('task-count');

  const tasks = await getAllFromStore('tasks');
  taskList.innerHTML = '';

  // Sort by updatedAt descending
  tasks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  taskCount.textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;

  if (tasks.length === 0) {
    emptyState.style.display = 'block';
  } else {
    emptyState.style.display = 'none';
    tasks.forEach(task => {
      const li = document.createElement('li');
      li.className = 'task-item';
      li.innerHTML = `
        <span class="task-text">${escapeHTML(task.text)}</span>
        <button class="btn btn-danger" onclick="handleDeleteTask('${task.id}')">Delete</button>
      `;
      taskList.appendChild(li);
    });
  }

  await updateSyncStatusUI();
}

function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

/* ==========================================
   3. TASK OPERATIONS (CREATE & DELETE)
   ========================================== */

async function handleAddTask(e) {
  e.preventDefault();
  const input = document.getElementById('task-input');
  const text = input.value.trim();

  if (!text) {
    showToast('Task description cannot be empty.', 'error');
    return;
  }

  const newTask = {
    id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    text: text,
    updatedAt: new Date().toISOString()
  };

  // 1. Immediately save to local IndexedDB (Optimistic UI)
  await putToStore('tasks', newTask);
  input.value = '';
  await renderTasks();

  // 2. Queue for synchronization
  await addQueueItem({
    type: 'CREATE',
    task: newTask
  });

  await updateSyncStatusUI();

  // 3. Trigger immediate sync if online
  if (navigator.onLine) {
    processSyncQueue();
  } else {
    showToast('Saved offline. Will sync when reconnected.', 'info');
  }
}

async function handleDeleteTask(id) {
  // 1. Delete from local IndexedDB
  await removeFromStore('tasks', id);
  await renderTasks();

  // 2. Queue operation
  await addQueueItem({
    type: 'DELETE',
    taskId: id
  });

  await updateSyncStatusUI();

  // 3. Trigger sync if online
  if (navigator.onLine) {
    processSyncQueue();
  } else {
    showToast('Deleted offline. Will sync when reconnected.', 'info');
  }
}

/* ==========================================
   4. NETWORK CHANGE & SYNC ENGINE
   ========================================== */

async function handleNetworkChange() {
  updateOnlineStatus();
  if (navigator.onLine) {
    showToast('Network restored. Syncing with server...', 'info');
    await fetchLatestServerTasks(); // Pull latest server data
    await processSyncQueue();       // Push pending offline queue
  } else {
    showToast('Network disconnected. Operating in Offline Mode.', 'warning');
  }
}

async function fetchLatestServerTasks() {
  try {
    const res = await fetch(API_URL);
    if (!res.ok) return;
    const serverTasks = await res.json();

    for (const sTask of serverTasks) {
      const localTask = await getTaskById(sTask.id);
      if (!localTask || new Date(sTask.updatedAt) > new Date(localTask.updatedAt)) {
        await putToStore('tasks', sTask);
      }
    }
    await renderTasks();
  } catch (err) {
    console.warn('[Sync] Fetching server tasks failed (Server down or network error)');
  }
}

function getTaskById(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks', 'readonly');
    const request = tx.objectStore('tasks').get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function processSyncQueue() {
  if (isSyncing || !navigator.onLine) return;
  isSyncing = true;

  try {
    const queue = await getAllFromStore('syncQueue');
    if (queue.length === 0) {
      isSyncing = false;
      return;
    }

    for (const item of queue) {
      let success = false;

      try {
        if (item.type === 'CREATE') {
          const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item.task)
          });

          const data = await res.json();

          if (res.ok) {
            success = true;
            // Handle Conflict Check
            if (data.status === 'conflict') {
              showToast(data.message, 'warning');
              // Update local state to server version if server won
              if (data.task) {
                await putToStore('tasks', data.task);
              }
            } else {
              showToast('Task synchronized with server.', 'info');
            }
          } else {
            console.error('Server error sync POST:', data);
          }
        } else if (item.type === 'DELETE') {
          const res = await fetch(`${API_URL}/${item.taskId}`, {
            method: 'DELETE'
          });

          if (res.ok || res.status === 404) { // 404 means it's already gone on server
            success = true;
            showToast('Deletion synchronized with server.', 'info');
          }
        }
      } catch (networkErr) {
        console.warn('[Sync Engine] Backend unreachable during queue processing.');
        // Stop processing loop; retry on next connection trigger
        break;
      }

      if (success) {
        await removeFromStore('syncQueue', item.queueId);
      }
    }
  } catch (err) {
    console.error('[Sync Engine] Critical sync processing error:', err);
  } finally {
    isSyncing = false;
    await renderTasks();
  }
}