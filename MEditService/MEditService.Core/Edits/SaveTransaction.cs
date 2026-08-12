namespace MEditService.Core.Edits;

// Sequences the file-move half of a group save so it can be rolled back as a unit if the
// caller's other commit point (the DB transaction) fails after files are already moved.
// #272 / ADR-0036: Column is the compound column identity (ColumnKey.Of), not a bare plugin name —
// PluginSaver.Save resolves the real plugin filename to write from the group's own PendingChange
// data before constructing each item, so this field is safe to be a compound key end to end.
public sealed class SaveTransaction(IReadOnlyList<(string Column, PreparedPluginSave Prepared)> items) : IDisposable
{
    public IReadOnlyDictionary<string, SaveResult> CommitFiles()
    {
        foreach (var (_, prepared) in items)
            prepared.Commit();
        return items.ToDictionary(i => i.Column, i => i.Prepared.Result);
    }

    // Restores every item to its pre-save content. Safe to call whether CommitFiles()
    // threw partway through a single item's own two-step Commit() (backup moved, tmp-swap
    // failed), threw between items, or fully succeeded and a later step (e.g. DB commit)
    // failed — each PreparedPluginSave.Rollback() is a no-op if it was never committed.
    public void Rollback()
    {
        foreach (var (_, prepared) in items)
            prepared.Rollback();
    }

    public void Dispose()
    {
        foreach (var (_, prepared) in items)
            prepared.Dispose();
    }
}
