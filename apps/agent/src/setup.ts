// Setting up a new copy (docs/phase-4.md, docs/DEPLOY.md).

/** Your fork's reader address from its GitHub remote: github.com/<owner>/<repo> → https://<owner>.github.io/<repo>/
 *  (GitHub Pages lowercases the owner; the repository name is kept as it is). */
export function readerUrlFromRemote(remote: string): string | null {
  const m = remote.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `https://${m[1]!.toLowerCase()}.github.io/${m[2]}/` : null;
}
