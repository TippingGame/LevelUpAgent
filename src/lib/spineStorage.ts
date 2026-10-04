import { validateSpineProject, type SpineProject } from "./spine";

export type SpineProjectSummary = Pick<
  SpineProject,
  "id" | "name" | "updatedAt"
>;
let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("levelup-spine-studio", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("projects", { keyPath: "id" });
      request.result.createObjectStore("summaries", { keyPath: "id" });
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      database = undefined;
      reject(new Error("Close other app windows to upgrade Spine storage."));
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
  }));
}
export async function listSpineProjects(): Promise<SpineProjectSummary[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("summaries")
      .objectStore("summaries")
      .getAll();
    request.onsuccess = () =>
      resolve(
        (request.result as SpineProjectSummary[]).sort(
          (a, b) => b.updatedAt - a.updatedAt,
        ),
      );
    request.onerror = () => reject(request.error);
  });
}
export async function loadSpineProject(
  id: string,
): Promise<SpineProject | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("projects").objectStore("projects").get(id);
    request.onsuccess = () => {
      try {
        resolve(
          request.result ? validateSpineProject(request.result) : undefined,
        );
      } catch (error) {
        reject(error);
      }
    };
    request.onerror = () => reject(request.error);
  });
}
export async function saveSpineProject(project: SpineProject): Promise<void> {
  validateSpineProject(project);
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(["projects", "summaries"], "readwrite");
    transaction.objectStore("projects").put(project);
    transaction
      .objectStore("summaries")
      .put({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
      });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Spine save was aborted."));
  });
}
