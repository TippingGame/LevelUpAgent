import type { SpineComfyJob } from "./spineComfy";
let database: Promise<IDBDatabase> | undefined;
function open() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("levelup-spine-local-jobs", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("jobs", { keyPath: "id" });
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      database = undefined;
      reject(
        new Error(
          "Local job storage is blocked by another app window. Close that window and reopen this workspace.",
        ),
      );
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
  }));
}
export async function listSpineComfyJobs(): Promise<SpineComfyJob[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction("jobs").objectStore("jobs").getAll();
    req.onsuccess = () =>
      resolve(
        req.result.sort(
          (a: SpineComfyJob, b: SpineComfyJob) => b.createdAt - a.createdAt,
        ),
      );
    req.onerror = () => reject(req.error);
  });
}
export async function saveSpineComfyJob(job: SpineComfyJob): Promise<void> {
  if (JSON.stringify(job).length > 1024 * 1024)
    throw new Error("Job receipt exceeds 1 MiB");
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("jobs", "readwrite");
    transaction.objectStore("jobs").put(job);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
