import { lstatSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Local bridge/proof configuration may select files only inside the application workspace. */
export function confinedLocalPath(value) {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value)) throw new Error("Invalid local path");
  const target = resolve(value);
  const roots = [resolve(process.cwd())];
  if (process.env.NODE_ENV === "test") roots.push(resolve(tmpdir()));
  for (const root of roots) {
    const child = relative(root, target);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) continue;
    const physicalRoot = realpathSync(root);
    let current = root;
    for (const segment of child.split(sep)) {
      current = resolve(current, segment);
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error("Local bridge paths cannot traverse symbolic links");
        const physicalChild = relative(physicalRoot, realpathSync(current));
        if (physicalChild === ".." || physicalChild.startsWith(`..${sep}`) || isAbsolute(physicalChild)) throw new Error("Local bridge paths must remain inside the application workspace");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return resolve(root, child);
  }
  throw new Error("Local bridge paths must remain inside the application workspace");
}

/** Publish a complete private file without following or truncating a preexisting temporary file. */
export async function atomicWriteLocalFile(value, contents) {
  return publishLocalFile(value, contents, 0o600);
}

/** Only the explicitly configured transport queue may use cross-UID group access. */
export async function atomicWriteQueueFile(value, contents) {
  const destination = confinedLocalPath(value);
  let mode = 0o600;
  if (process.env.APTLSS_CODEX_SHARED_QUEUE === "true") {
    const configured = process.env.APTLSS_CODEX_QUEUE_DIR;
    if (!configured) throw new Error("Shared Codex transport requires an explicit queue");
    const root = confinedLocalPath(configured);
    const child = relative(root, destination);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error("Shared Codex transport must remain inside its queue");
    }
    const info = lstatSync(root);
    for (let parent = dirname(destination); ; parent = dirname(parent)) {
      const directory = lstatSync(parent);
      if (!directory.isDirectory() || directory.gid !== info.gid || (directory.mode & 0o2077) !== 0o2070) {
        throw new Error("Shared Codex queue requires group-only setgid directories");
      }
      if (parent === root) break;
    }
    mode = 0o660;
  }
  return publishLocalFile(destination, contents, mode);
}

async function publishLocalFile(value, contents, mode) {
  const destination = confinedLocalPath(value);
  const temporary = confinedLocalPath(resolve(dirname(destination), `.${basename(destination)}.${randomUUID()}.pending`));
  let created = false;
  try {
    const file = await open(confinedLocalPath(temporary), "wx", mode);
    created = true;
    try {
      // Apply the exact policy to the opened inode, independent of either service's umask.
      await file.chmod(mode);
      await file.writeFile(contents);
    } finally {
      await file.close();
    }
    await rename(confinedLocalPath(temporary), confinedLocalPath(destination));
    created = false;
  } finally {
    if (created) await unlink(confinedLocalPath(temporary)).catch(() => {});
  }
}
