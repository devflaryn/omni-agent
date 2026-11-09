/* A file's full path from its root and its path under it, in the root's own style of separator. Shared by the tree and the file pane,
   so the tree need not load the pane to copy a path. */
const sep = (root) => (/\\/.test(root) && !/\//.test(root) ? "\\" : "/");
export const absPath = (root, rel) => (rel ? `${String(root).replace(/[\\/]+$/, "")}${sep(root)}${sep(root) === "\\" ? rel.replace(/\//g, "\\") : rel}` : root);
