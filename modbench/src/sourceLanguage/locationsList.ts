import * as vscode from 'vscode';
import type { ReferencesViewList } from '../drivingLib/referencesView';

class PlaceRow extends vscode.TreeItem {
  constructor(location: vscode.Location, line: string) {
    const preview = line.trimStart();
    const cut = line.length - preview.length;
    const { start, end } = location.range;
    const highlight: [number, number] = [start.character - cut, (end.line === start.line ? end.character : line.length) - cut];
    super({ label: preview, highlights: [highlight] }, vscode.TreeItemCollapsibleState.None);
    this.command = { command: 'vscode.open', title: 'Open', arguments: [location.uri, { selection: location.range }] };
  }
}

class FileRow extends vscode.TreeItem {
  constructor(uri: vscode.Uri, readonly places: readonly PlaceRow[]) {
    super(uri, vscode.TreeItemCollapsibleState.Expanded);
    this.description = String(places.length);
  }
}

/** `locations` as the References view lists them: by file, each place under its line's text, below `message`. */
export async function locationsList(locations: readonly vscode.Location[], message: string | undefined): Promise<ReferencesViewList> {
  const byFile = new Map<string, vscode.Location[]>();
  for (const location of locations) byFile.set(location.uri.toString(), [...byFile.get(location.uri.toString()) ?? [], location]);
  const files = await Promise.all([...byFile.values()].map(async (inFile) => {
    const [first] = inFile;
    if (first === undefined) return [];
    const document = await vscode.workspace.openTextDocument(first.uri);
    return [new FileRow(first.uri, inFile.map((location) => new PlaceRow(location, document.lineAt(location.range.start.line).text)))];
  }));
  const rows = files.flat();
  const provider: vscode.TreeDataProvider<FileRow | PlaceRow> = {
    getTreeItem: (row) => row,
    getChildren: (row) => (row === undefined ? rows : row instanceof FileRow ? [...row.places] : []),
  };
  return { provider, message };
}
