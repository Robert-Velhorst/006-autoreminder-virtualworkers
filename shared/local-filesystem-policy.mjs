import { lstatSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
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
  const destination = confinedLocalPath(value);
  const temporary = confinedLocalPath(resolve(dirname(destination), `.${basename(destination)}.${randomUUID()}.pending`));
  let created = false;
  try {
    await writeFile(confinedLocalPath(temporary), contents, { flag: "wx", mode: 0o600 });
    created = true;
    await rename(confinedLocalPath(temporary), confinedLocalPath(destination));
    created = false;
  } finally {
    if (created) await unlink(confinedLocalPath(temporary)).catch(() => {});
  }
}
