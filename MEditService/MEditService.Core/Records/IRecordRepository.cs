using MEditService.Core.Queries;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

public interface IRecordRepository : IDisposable
{
    void Initialize(GameRelease release);
    void Index(IModGetter mod, int loadOrderIndex);
    void UpdateWinners();
    PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset);
    RecordDetail? GetRecord(string tableName, RecordTableSchema schema, string formKey, string? plugin, bool winnerOnly);
    IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, RecordTableSchema schema, string formKey);
    int CountRecordsForPlugin(string tableName, string plugin);
    string? FindRecordType(string formKey);
}
