namespace MEditService.Queries;

internal static class IndexRowMapping
{
    public static PagedResult<RecordSummary> ToQuery(this Index.PagedResult<Index.RecordSummary> page) =>
        new([.. page.Items.Select(ToQuery)], page.Total);

    public static RecordSummary ToQuery(this Index.RecordSummary row) =>
        new(row.FormKey, row.Plugin, row.LoadOrderIndex, row.IsWinner, row.EditorId, row.Origin,
            row.WorkingTreeState.ToQuery(), row.HasContainerChildren, row.ParseDiagnosis, row.HasParseFailure,
            row.FullName);

    public static WorkingTreeState ToQuery(this Index.WorkingTreeState state) => state switch
    {
        Index.WorkingTreeState.None => WorkingTreeState.None,
        Index.WorkingTreeState.Modified => WorkingTreeState.Modified,
        Index.WorkingTreeState.Added => WorkingTreeState.Added,
        _ => throw new ArgumentOutOfRangeException(nameof(state), state, "No Queries counterpart."),
    };

    public static FieldValue ToQuery(this Index.FieldValue field) =>
        new(field.Metadata, field.Value, field.CheckError);

    public static CellChildRecords ToQuery(this Index.CellChildRecords children) =>
        new([.. children.Persistent.Select(ToQuery)], [.. children.Temporary.Select(ToQuery)]);

    private static ChildRecordSummary ToQuery(Index.ChildRecordSummary row) =>
        new(row.FormKey, row.EditorId, row.BaseFormKey, row.RecordType, row.HasParseFailure, row.FullName,
            row.BaseEditorId, row.ParseDiagnosis, row.WorkingTreeState.ToQuery());
}
