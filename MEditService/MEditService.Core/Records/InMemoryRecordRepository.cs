using MEditService.Core.Queries;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

public sealed class InMemoryRecordRepository : IRecordRepository
{
    private readonly ISchemaReflector _schemaReflector;
    private readonly IFieldMetadataMapper _metadataMapper;
    private IReadOnlyDictionary<string, RecordTableSchema>? _schemas;
    private readonly Dictionary<string, List<RecordDetail>> _tables = new();

    public InMemoryRecordRepository(ISchemaReflector schemaReflector, IFieldMetadataMapper metadataMapper)
    {
        _schemaReflector = schemaReflector;
        _metadataMapper = metadataMapper;
    }

    public void Initialize(GameRelease release) =>
        _schemas = _schemaReflector.GetSchemas(release);

    public void Index(IModGetter mod, int loadOrderIndex)
    {
        var schemas = _schemas ?? throw new InvalidOperationException("Call Initialize before Index.");
        var plugin = mod.ModKey.FileName.ToString();

        foreach (var (tableName, schema) in schemas)
        {
            var records = mod.EnumerateMajorRecords(schema.RecordType, throwIfUnknown: false).ToList();
            if (!_tables.TryGetValue(tableName, out var table))
                _tables[tableName] = table = [];

            table.RemoveAll(r => r.Plugin.Equals(plugin, StringComparison.OrdinalIgnoreCase));

            foreach (var record in records)
            {
                var fields = schema.RecordColumns
                    .Select(col => new FieldValue(_metadataMapper.Map(col), col.Extract(record)))
                    .ToList();
                table.Add(new RecordDetail(
                    record.FormKey.ToString(), plugin, loadOrderIndex,
                    false, record.EditorID, fields));
            }
        }
    }

    public void UpdateWinners()
    {
        foreach (var (_, table) in _tables)
        {
            if (table.Count == 0) continue;
            var maxByFormKey = table
                .GroupBy(r => r.FormKey)
                .ToDictionary(g => g.Key, g => g.Max(r => r.LoadOrderIndex));

            for (int i = 0; i < table.Count; i++)
            {
                var row = table[i];
                var isWinner = row.LoadOrderIndex == maxByFormKey[row.FormKey];
                if (row.IsWinner != isWinner)
                    table[i] = row with { IsWinner = isWinner };
            }
        }
    }

    public PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset)
    {
        if (!_tables.TryGetValue(tableName, out var table))
            return new PagedResult<RecordSummary>([], 0);

        var filtered = table.AsEnumerable();
        if (plugin != null)
            filtered = filtered.Where(r => r.Plugin.Equals(plugin, StringComparison.OrdinalIgnoreCase));
        if (search != null)
            filtered = filtered.Where(r => r.EditorId?.Contains(search, StringComparison.OrdinalIgnoreCase) == true);

        var all = filtered.OrderBy(r => r.EditorId).ToList();
        var items = all.Skip(offset).Take(limit)
            .Select(r => new RecordSummary(r.FormKey, r.Plugin, r.LoadOrderIndex, r.IsWinner, r.EditorId))
            .ToList();

        return new PagedResult<RecordSummary>(items, all.Count);
    }

    public RecordDetail? GetRecord(string tableName, RecordTableSchema schema, string formKey, string? plugin, bool winnerOnly)
    {
        if (!_tables.TryGetValue(tableName, out var table))
            return null;

        var query = table.Where(r => r.FormKey == formKey);
        if (winnerOnly) query = query.Where(r => r.IsWinner);
        if (plugin != null) query = query.Where(r => r.Plugin.Equals(plugin, StringComparison.OrdinalIgnoreCase));

        return query.FirstOrDefault();
    }

    public IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, RecordTableSchema schema, string formKey)
    {
        if (!_tables.TryGetValue(tableName, out var table))
            return [];

        return table.Where(r => r.FormKey == formKey)
            .OrderBy(r => r.LoadOrderIndex)
            .ToList();
    }

    public int CountRecordsForPlugin(string tableName, string plugin)
    {
        if (!_tables.TryGetValue(tableName, out var table))
            return 0;

        return table.Count(r => r.Plugin.Equals(plugin, StringComparison.OrdinalIgnoreCase));
    }

    public string? FindRecordType(string formKey)
    {
        foreach (var (tableName, table) in _tables)
        {
            if (table.Any(r => r.FormKey == formKey))
                return tableName;
        }
        return null;
    }

    public void Dispose() { }
}
