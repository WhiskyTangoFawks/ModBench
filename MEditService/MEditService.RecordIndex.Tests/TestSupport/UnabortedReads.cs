using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RepositoriesLib;

namespace MEditService.RecordIndex.Tests;

/// <summary>The face's reads as a test asks them: no request stands behind a test's read to abort it.</summary>
internal static class UnabortedReads
{
    private static readonly CancellationToken Never = CancellationToken.None;

    internal static Task<Answer<IReadOnlyList<PluginResponse>, IndexRefused>> GetPlugins(this IQueries queries) => queries.GetPlugins(Never);

    internal static Task<Answer<PagedResult<RecordSummary>, IndexRefused>> GetRecords(
        this IQueries queries, IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset) =>
        queries.GetRecords(types, plugin, search, limit, offset, Never);

    internal static Task<Answer<RecordDetail?, IndexRefused>> GetRecord(this IQueries queries, string formKey) =>
        queries.GetRecord(formKey, Never);

    internal static Task<Answer<CompareResult?, IndexRefused>> GetCompare(this IQueries queries, string formKey, CopyText? text = null) =>
        queries.GetCompare(formKey, text, Never);

    internal static Task<Answer<CompareRecordsAnswer, IndexRefused>> GetCompareRecords(this IQueries queries, IReadOnlyList<RecordCopy> copies) =>
        queries.GetCompareRecords(copies, Never);

    internal static Task<Answer<IReadOnlyList<RecordCopyStates>, IndexRefused>> GetCopyStates(
        this IQueries queries, IReadOnlyList<string> formKeys, PluginAddress? plugin) => queries.GetCopyStates(formKeys, plugin, Never);

    internal static Task<Answer<IReadOnlyList<PluginRecordTypeCount>, IndexRefused>> GetPluginRecordTypes(this IQueries queries, PluginAddress plugin) =>
        queries.GetPluginRecordTypes(plugin, Never);

    internal static Task<Answer<WorkingTreeStatesBeneath, IndexRefused>> GetWorkingTreeStatesBeneath(this IQueries queries, PluginAddress plugin) =>
        queries.GetWorkingTreeStatesBeneath(plugin, Never);

    internal static Task<Answer<IReadOnlyList<RecordTypeChoice>?, IndexRefused>> GetChildRecordTypes(
        this IQueries queries, PluginAddress plugin, string formKey) => queries.GetChildRecordTypes(plugin, formKey, Never);

    internal static Task<Answer<IReadOnlyList<ReferenceResult>, IndexRefused>> GetReferences(this IQueries queries, string targetFormKey) =>
        queries.GetReferences(targetFormKey, Never);

    internal static Task<Answer<IReadOnlyList<ReferenceResult>, IndexRefused>> GetReferencesInActiveOrCompiledPlugins(
        this IQueries queries, string targetFormKey) => queries.GetReferencesInActiveOrCompiledPlugins(targetFormKey, Never);

    internal static Task<Answer<IReadOnlyList<CopyNaming>, IndexRefused>> GetPluginNameReferences(this IQueries queries, string name) =>
        queries.GetPluginNameReferences(name, Never);

    internal static Task<Answer<MemberReferences, IndexRefused>> GetScriptReferences(this IQueries queries, string name) =>
        queries.GetScriptReferences(name, Never);

    internal static Task<Answer<MemberReferences, IndexRefused>> GetFileReferences(this IQueries queries, string dataPath) =>
        queries.GetFileReferences(dataPath, Never);

    internal static Task<Answer<RenderedDocument?, IndexRefused>> GetRenderedDocument(this IQueries queries, PluginAddress plugin, string formKey) =>
        queries.GetRenderedDocument(plugin, formKey, Never);

    internal static Task<Answer<CopyDocument?, IndexRefused>> GetCopyDocument(this IQueries queries, PluginAddress plugin, string formKey) =>
        queries.GetCopyDocument(plugin, formKey, Never);

    internal static Task<Answer<IReadOnlyList<WorldspaceSummary>, IndexRefused>> GetWorldspaces(this IQueries queries, PluginAddress plugin) =>
        queries.GetWorldspaces(plugin, Never);

    internal static Task<Answer<WorldspaceBlocks, IndexRefused>> GetWorldspaceBlocks(
        this IQueries queries, PluginAddress plugin, string worldspaceFormKey) => queries.GetWorldspaceBlocks(plugin, worldspaceFormKey, Never);

    internal static Task<Answer<CellChildRecords, IndexRefused>> GetCellChildRecords(this IQueries queries, PluginAddress plugin, string cellFormKey) =>
        queries.GetCellChildRecords(plugin, cellFormKey, Never);

    internal static Task<Answer<IReadOnlyList<InteriorCellBlock>, IndexRefused>> GetInteriorCells(this IQueries queries, PluginAddress plugin) =>
        queries.GetInteriorCells(plugin, Never);

    internal static Task<Answer<IReadOnlyList<ContainerChildSummary>, IndexRefused>> GetContainerChildren(
        this IQueries queries, PluginAddress plugin, string parentFormKey) => queries.GetContainerChildren(plugin, parentFormKey, Never);

    internal static Task<Answer<IReadOnlyList<PluginDiagnosisReport>, IndexRefused>> GetLoadOrderDiagnoses(this IQueries queries) =>
        queries.GetLoadOrderDiagnoses(Never);

    internal static Task<Answer<PluginDependants, IndexRefused>> GetDependants(this IQueries queries, PluginAddress plugin) =>
        queries.GetDependants(plugin, Never);

    internal static Task<Answer<IReadOnlyList<PluginProblems>, IndexRefused>> GetProblems(this IQueries queries) => queries.GetProblems(Never);

    internal static Task<Answer<IReadOnlyList<PluginFilePaths>, IndexRefused>> GetFilePaths(this IQueries queries, PluginAddress? plugin) =>
        queries.GetFilePaths(plugin, Never);

    internal static Task<Answer<SelectedRows, IndexRefused>> SelectRows(this IQueries queries, string sql) => queries.SelectRows(sql, Never);

    internal static Task<Answer<IReadOnlyList<NamedObject>, IndexRefused>> ResolveNames(this IQueries queries, IReadOnlyList<NameQuery> names) =>
        queries.ResolveNames(names, Never);
}
