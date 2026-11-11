using MEditService.RecordIndex.Store;
using MEditService.RepositoriesLib;

namespace MEditService.RecordIndex.Queries;

/// <summary>The rows of one SELECT, each the JSON text of an object of its columns, read from one snapshot as they are
/// taken and never all held (ADR-0010). Its read stays open until it is disposed.</summary>
public sealed class SelectedRows : IDisposable
{
    private const string BodiesByKey =
        "A sort or a join that carries body holds all of it in memory: find the keys on narrow columns, then select body for those keys.";

    private readonly StreamedRows _rows;
    private readonly IndexAnswer _answer;
    private Answer<string?, IndexRefused>? _first;

    private SelectedRows(StreamedRows rows, IndexAnswer answer)
    {
        _rows = rows;
        _answer = answer;
    }

    /// <summary>The rows, once the first is read: a SELECT refused, or out of memory, before its first row is refused
    /// whole.</summary>
    internal static Answer<SelectedRows, IndexRefused> Selected(Indexer index, string sql, IndexAnswer answer) =>
        answer.Flat(() => RefusingTheSql<SelectedRows>(() =>
        {
            if (!SqlDoor.Select(index, sql).Holds(out var rows, out var rejection)) return new IndexRefused(IndexRefusal.SelectRejected, rejection);
            var selected = new SelectedRows(rows, answer);
            try
            {
                selected._first = selected.Next();
            }
            catch
            {
                selected.Dispose();
                throw;
            }
            if (selected._first.Holds(out _, out var refused)) return selected;
            selected.Dispose();
            return refused;
        }));

    /// <summary>Each row in turn, read once. A refusal that stops them is the last.</summary>
    public IEnumerable<Answer<string, IndexRefused>> Rows()
    {
        var next = _first ?? Next();
        _first = null;
        while (true)
        {
            if (!next.Holds(out var row, out var refused))
            {
                yield return refused;
                yield break;
            }
            if (row is null) yield break;
            yield return row;
            next = Next();
        }
    }

    // A fault in the SQL itself, its syntax, a name it uses or a value of a row, is the SELECT's refusal.
    private static Answer<T, IndexRefused> RefusingTheSql<T>(Func<Answer<T, IndexRefused>> read)
    {
        try
        {
            return read();
        }
        catch (IndexFaultException ex) when (ex.Fault is IndexFault.Refused or IndexFault.RowValue)
        {
            return new IndexRefused(IndexRefusal.SelectRejected, ex.Message);
        }
    }

    private Answer<string?, IndexRefused> Next()
    {
        var next = _answer.Flat(() => RefusingTheSql<string?>(() => _rows.Next()));
        if (next.Holds(out _, out var refused) || refused.Refusal != IndexRefusal.OutOfMemory) return next;
        return refused with { Message = $"{refused.Message} {BodiesByKey}" };
    }

    public void Dispose() => _rows.Dispose();
}
