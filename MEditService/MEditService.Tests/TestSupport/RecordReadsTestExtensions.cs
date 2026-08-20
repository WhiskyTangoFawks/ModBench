using MEditService.Core.Queries;
using MEditService.Core.Records;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests;

/// <summary>
/// #421: compatibility shims so the many existing test call sites built against the deleted
/// <c>IRecordReader</c>/<c>IRecordIndexer</c> shape don't each have to be hand-rewritten — same call
/// syntax, same values, backed by the new seam. Legitimate here specifically because every one of
/// these is a pure reshape of an already-covered call (rename, param repack, or PluginKey-wrap) —
/// nothing here adds behaviour the new seam didn't already have. VMAD/condition reconstitution is
/// deliberately NOT shimmed this way: that capability actually moved (Records/ to Queries/,
/// RecordDocumentCodecs), so its tests are re-pointed for real rather than papered over.
/// </summary>
internal static class RecordReadsTestExtensions
{
    // --- ingest (IRecordIndex) ---

    internal static void Index(this IRecordIndex repository, IModGetter plugin, int loadOrderIndex, bool participates, string origin) =>
        repository.Index(plugin, loadOrderIndex, participates, new PluginKey(plugin.ModKey.FileName.ToString(), origin));

    internal static void Unindex(this IRecordIndex repository, string plugin, string origin) =>
        repository.Unindex(new PluginKey(plugin, origin));

    internal static void SetPluginParticipation(this IRecordIndex repository, string plugin, bool participates, string origin) =>
        repository.SetPluginParticipation(new PluginKey(plugin, origin), participates);

    // --- reads (IRecordReads) ---

    /// <summary>Mirrors the deleted <c>IRecordReader.CountRecordsForPlugin(tableName, plugin,
    /// origin)</c> — a single-type slice of <see cref="IRecordReads.GetRecordTypeCounts"/>.</summary>
    internal static int CountRecordsForPlugin(this IRecordReads repository, string tableName, string plugin, string origin) =>
        repository.GetRecordTypeCounts(new PluginKey(plugin, origin))
            .FirstOrDefault(c => string.Equals(c.Type, tableName, StringComparison.OrdinalIgnoreCase))?.Count ?? 0;

    /// <summary>Mirrors the deleted <c>IRecordReader.GetRecord(tableName, formKey, plugin, origin,
    /// winnerOnly)</c> — <c>tableName</c> is checked rather than used for dispatch
    /// (<see cref="IRecordReads.GetDocument(string)"/> resolves the type internally now); a
    /// mismatch means the shimmed call site's assumption about the FormKey's type is stale. A null
    /// <paramref name="plugin"/> always answers the winner (every real call site pairing
    /// <c>plugin: null</c> with <c>winnerOnly: false</c> does so only in a single-row fixture where
    /// the two answer identically); a stated plugin with <paramref name="winnerOnly"/> true has no
    /// real call site and isn't supported.</summary>
    internal static RecordDetail? GetRecord(
        this IRecordReads repository, string tableName, string formKey, string? plugin, string? origin, bool winnerOnly)
    {
        if (plugin != null && winnerOnly)
            throw new ArgumentException("GetRecord shim: a stated plugin with winnerOnly true has no real call site and isn't supported.");
        var document = plugin == null ? repository.GetDocument(formKey) : repository.GetDocument(formKey, ToPluginKey(plugin, origin));
        if (document != null && !string.Equals(document.RecordType, tableName, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException($"GetRecord shim: {formKey} is a '{document.RecordType}', not '{tableName}'.");
        return document == null ? null : ToRecordDetail(document);
    }

    /// <summary>Mirrors the deleted <c>IRecordReader.GetAllOverrides(tableName, formKey)</c> —
    /// <c>tableName</c> is checked the same way <see cref="GetRecord"/>'s is.</summary>
    internal static IReadOnlyList<RecordDetail> GetAllOverrides(this IRecordReads repository, string tableName, string formKey)
    {
        var stack = repository.GetOverrideStack(formKey);
        if (stack == null) return [];
        if (!string.Equals(stack.RecordType, tableName, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException($"GetAllOverrides shim: {formKey} is a '{stack.RecordType}', not '{tableName}'.");
        return [.. stack.Entries.Select(e => ToRecordDetail(e.Effective))];
    }

    /// <summary>Mirrors the deleted <c>IRecordReader.GetRecords(tableName, ...)</c> — one record
    /// type, the single-element case of <see cref="RecordQuery.RecordTypes"/>.</summary>
    internal static PagedResult<RecordSummary> GetRecords(
        this IRecordReads repository, string tableName, string? plugin, string? search, int limit, int offset, string? origin = null) =>
        repository.Search(new RecordQuery(
            RecordTypes: [tableName], Plugin: ToPluginKeyOrNull(plugin, origin), Search: search, Limit: limit, Offset: offset));

    /// <summary>Mirrors the deleted <c>IRecordReader.SearchRecords(tableNames, ...)</c>.</summary>
    internal static PagedResult<RecordSummary> SearchRecords(
        this IRecordReads repository, IReadOnlyList<string> tableNames, string? plugin, string? search, int limit, int offset, string? origin = null) =>
        repository.Search(new RecordQuery(
            RecordTypes: tableNames, Plugin: ToPluginKeyOrNull(plugin, origin), Search: search, Limit: limit, Offset: offset));

    // Written as ordinary methods rather than `plugin == null ? null : new PluginKey(plugin,
    // origin)` inline: PluginKey's implicit string conversion makes that ternary's common-type
    // inference reach for the null literal via `string`, tripping CS8625 on PluginKey.Name.
    private static PluginKey ToPluginKey(string plugin, string? origin) => new(plugin, origin);

    private static PluginKey? ToPluginKeyOrNull(string? plugin, string? origin)
    {
        if (plugin == null) return null;
        return new PluginKey(plugin, origin);
    }

    internal static RecordLookupEntry? ResolveFormKey(this IRecordReads repository, string formKey) => repository.Resolve(formKey);

    internal static IReadOnlyList<ReferenceResult> GetReferences(this IRecordReads repository, string targetFormKey) =>
        repository.GetReferencedBy(targetFormKey);

    internal static IReadOnlyList<string> GetNativeFormKeys(this IRecordReads repository, string plugin, string origin) =>
        repository.GetNativeFormKeys(new PluginKey(plugin, origin));

    internal static IReadOnlyList<CellLocationSummary> GetWorldspaceCells(
        this IRecordReads repository, string plugin, string worldspaceFormKey, string origin) =>
        repository.GetWorldspaceCells(new PluginKey(plugin, origin), worldspaceFormKey);

    internal static PagedResult<CellSummary> GetInteriorCells(this IRecordReads repository, string plugin, int limit, int offset, string origin) =>
        repository.GetInteriorCells(new PluginKey(plugin, origin), limit, offset);

    internal static CellReferences GetCellReferences(this IRecordReads repository, string plugin, string cellFormKey, string origin) =>
        repository.GetCellReferences(new PluginKey(plugin, origin), cellFormKey);

    internal static PlacementRow? GetPlacement(this IRecordReads repository, string formKey, string plugin, string origin) =>
        repository.GetPlacement(formKey, new PluginKey(plugin, origin));

    private static RecordDetail ToRecordDetail(RecordDocument document) =>
        new(document.FormKey, document.Plugin.Name, document.LoadOrderIndex, document.IsWinner, document.EditorId,
            document.Fields, Origin: document.Plugin.Origin ?? "", RecordType: document.RecordType);
}
