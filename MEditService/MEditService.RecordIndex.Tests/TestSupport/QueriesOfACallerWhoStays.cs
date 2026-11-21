using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RepositoriesLib;

namespace MEditService.RecordIndex.Tests;

/// <summary>Each read of <see cref="IQueries"/> for a test whose caller never leaves.</summary>
internal static class QueriesOfACallerWhoStays
{
    internal static Answer<IReadOnlyList<PluginResponse>, IndexRefused> GetPlugins(this IQueries queries, IReadOnlyCollection<PluginAddress>? plugins = null) =>
        queries.GetPlugins(plugins, CancellationToken.None);

    internal static Answer<PagedResult<RecordSummary>, IndexRefused> GetRecords(this IQueries queries, IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset) =>
        queries.GetRecords(types, plugin, search, limit, offset, CancellationToken.None);

    internal static Answer<IReadOnlyDictionary<string, IReadOnlyList<PluginAddress>>, IndexRefused> GetRecordOwners(
        this IQueries queries, IReadOnlyCollection<string> formKeys) =>
        queries.GetRecordOwners(formKeys, CancellationToken.None);

    internal static Answer<IReadOnlyDictionary<string, IReadOnlyList<PluginAddress>>, IndexRefused> GetRecordOwnersForAWrite(
        this IQueries queries, long version, IReadOnlyCollection<string> formKeys) =>
        queries.GetRecordOwnersForAWrite(version, formKeys, CancellationToken.None);

    internal static Answer<CompareResult?, IndexRefused> GetCompare(this IQueries queries, string formKey, CopyText? text) =>
        queries.GetCompare(formKey, text, CancellationToken.None);

    internal static Answer<CompareRecordsAnswer, IndexRefused> GetCompareRecords(this IQueries queries, IReadOnlyList<RecordCopy> copies) =>
        queries.GetCompareRecords(copies, CancellationToken.None);

    internal static Answer<IReadOnlyList<RecordCopyStates>, IndexRefused> GetCopyStates(this IQueries queries, IReadOnlyList<string> formKeys, PluginAddress? plugin) =>
        queries.GetCopyStates(formKeys, plugin, CancellationToken.None);

    internal static Answer<IReadOnlyList<PluginRecordTypeCount>, IndexRefused> GetPluginRecordTypes(this IQueries queries, PluginAddress plugin) =>
        queries.GetPluginRecordTypes(plugin, CancellationToken.None);

    internal static Answer<WorkingTreeStatesBeneath, IndexRefused> GetWorkingTreeStatesBeneath(this IQueries queries, PluginAddress plugin) =>
        queries.GetWorkingTreeStatesBeneath(plugin, CancellationToken.None);

    internal static Answer<IReadOnlyList<RecordTypeChoice>?, IndexRefused> GetChildRecordTypes(this IQueries queries, PluginAddress plugin, string formKey) =>
        queries.GetChildRecordTypes(plugin, formKey, CancellationToken.None);

    internal static Answer<IReadOnlyList<ReferenceResult>, IndexRefused> GetReferencesInActiveOrCompiledPlugins(this IQueries queries, string targetFormKey) =>
        queries.GetReferencesInActiveOrCompiledPlugins(targetFormKey, CancellationToken.None);

    internal static Answer<PlacedReferences, IndexRefused> GetPlacedReferences(this IQueries queries, string targetFormKey) =>
        queries.GetPlacedReferences(targetFormKey, CancellationToken.None);

    internal static Answer<IReadOnlyList<CopyNaming>, IndexRefused> GetPluginNameReferences(this IQueries queries, string name) =>
        queries.GetPluginNameReferences(name, CancellationToken.None);

    internal static Answer<IReadOnlyList<RecordAt>, IndexRefused> GetCopiesWithNoPluginSourceNaming(this IQueries queries, PluginAddress plugin, string formKey) =>
        queries.GetCopiesWithNoPluginSourceNaming(plugin, formKey, CancellationToken.None);

    internal static Answer<MemberReferences, IndexRefused> GetScriptReferences(this IQueries queries, string name) =>
        queries.GetScriptReferences(name, CancellationToken.None);

    internal static Answer<PlacedReferences, IndexRefused> GetPlacedPluginNameReferences(this IQueries queries, string name) =>
        queries.GetPlacedPluginNameReferences(name, CancellationToken.None);

    internal static Answer<PlacedReferences, IndexRefused> GetPlacedScriptReferences(this IQueries queries, string name) =>
        queries.GetPlacedScriptReferences(name, CancellationToken.None);

    internal static Answer<PlacedReferences, IndexRefused> GetPlacedFileReferences(this IQueries queries, string dataPath) =>
        queries.GetPlacedFileReferences(dataPath, CancellationToken.None);

    internal static Answer<RenderedDocument?, IndexRefused> GetRenderedDocument(this IQueries queries, PluginAddress plugin, string formKey) =>
        queries.GetRenderedDocument(plugin, formKey, CancellationToken.None);

    internal static Answer<CopyDocument?, IndexRefused> GetCopyDocument(this IQueries queries, PluginAddress plugin, string formKey) =>
        queries.GetCopyDocument(plugin, formKey, CancellationToken.None);

    internal static Answer<CopyDocument?, IndexRefused> GetCopyDocument(this IQueries queries, PluginAddress plugin, RecordIdentity identity) =>
        queries.GetCopyDocument(plugin, identity, CancellationToken.None);

    internal static Answer<IReadOnlyList<DocumentName>, IndexRefused> GetPluginSourceNames(this IQueries queries, string? path, string text, int? at) =>
        queries.GetPluginSourceNames(path, text, at, CancellationToken.None);

    internal static Answer<IReadOnlyList<WorldspaceSummary>, IndexRefused> GetWorldspaces(this IQueries queries, PluginAddress plugin) =>
        queries.GetWorldspaces(plugin, CancellationToken.None);

    internal static Answer<WorldspaceBlocks, IndexRefused> GetWorldspaceBlocks(this IQueries queries, PluginAddress plugin, string worldspaceFormKey) =>
        queries.GetWorldspaceBlocks(plugin, worldspaceFormKey, CancellationToken.None);

    internal static Answer<CellChildRecords, IndexRefused> GetCellChildRecords(this IQueries queries, PluginAddress plugin, string cellFormKey) =>
        queries.GetCellChildRecords(plugin, cellFormKey, CancellationToken.None);

    internal static Answer<IReadOnlyList<InteriorCellBlock>, IndexRefused> GetInteriorCells(this IQueries queries, PluginAddress plugin) =>
        queries.GetInteriorCells(plugin, CancellationToken.None);

    internal static Answer<IReadOnlyList<ContainerChildSummary>, IndexRefused> GetContainerChildren(this IQueries queries, PluginAddress plugin, string parentFormKey) =>
        queries.GetContainerChildren(plugin, parentFormKey, CancellationToken.None);

    internal static Answer<IReadOnlyList<PluginDiagnosisReport>, IndexRefused> GetLoadOrderDiagnoses(this IQueries queries) =>
        queries.GetLoadOrderDiagnoses(CancellationToken.None);

    internal static Answer<PluginDependants, IndexRefused> GetDependants(this IQueries queries, PluginAddress plugin) =>
        queries.GetDependants(plugin, CancellationToken.None);

    internal static Answer<IReadOnlyList<PluginProblems>, IndexRefused> GetProblems(this IQueries queries, PluginAddress? plugin, RecordsAsked? asked = null) =>
        queries.GetProblems(plugin, asked, CancellationToken.None);

    internal static Answer<IReadOnlyList<PluginFilePaths>, IndexRefused> GetFilePaths(this IQueries queries, PluginAddress? plugin, RecordsAsked? asked = null) =>
        queries.GetFilePaths(plugin, asked, CancellationToken.None);

    internal static Answer<SelectedRows, IndexRefused> SelectRows(this IQueries queries, string sql) =>
        queries.SelectRows(sql, CancellationToken.None);

    internal static Answer<IReadOnlyList<NamedObject>, IndexRefused> ResolveNames(this IQueries queries, IReadOnlyList<NameQuery> names) =>
        queries.ResolveNames(names, CancellationToken.None);

    internal static Answer<RecordFilter?, IndexRefused> GetFilter(this IQueries queries) =>
        queries.GetFilter(CancellationToken.None);
}
