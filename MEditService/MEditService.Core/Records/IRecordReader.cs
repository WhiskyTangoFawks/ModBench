using MEditService.Core.Queries;
using MEditService.Core.Schema;

namespace MEditService.Core.Records;

public interface IRecordReader
{
    PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset);
    RecordDetail? GetRecord(string tableName, RecordTableSchema schema, string formKey, string? plugin, bool winnerOnly);
    IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, RecordTableSchema schema, string formKey);
    int CountRecordsForPlugin(string tableName, string plugin);
    string? FindRecordType(string formKey);
}
