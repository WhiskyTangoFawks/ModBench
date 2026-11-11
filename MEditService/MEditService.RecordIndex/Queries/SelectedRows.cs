using MEditService.RecordIndex.Store;
using MEditService.RepositoriesLib;

namespace MEditService.RecordIndex.Queries;

/// <summary>The rows of one SELECT, each the JSON text of an object of its columns, read from one snapshot of the record
/// index as they are taken and never all held (ADR-0010). Its read stays open until it is disposed.</summary>
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

    /// <summary>The rows, once the first is read: a SELECT DuckDB refuses, or runs out of memory for, before its first
    /// row is refused whole.</summary>
    internal static Answer<SelectedRows, IndexRefused> Started(StreamedRows rows, IndexAnswer answer)
    {
        var selected = new SelectedRows(rows, answer);
        selected._first = selected.Next();
        if (selected._first.Holds(out _, out var refused)) return selected;
        selected.Dispose();
        return refused;
    }

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

    private Answer<string?, IndexRefused> Next()
    {
        var next = _answer.Flat<string?>(() =>
        {
            try
            {
                return _rows.Next();
            }
            catch (IndexFaultException ex) when (ex.Fault is IndexFault.Refused or IndexFault.RowValue)
            {
                return new IndexRefused(IndexRefusal.SelectRejected, ex.Message);
            }
        });
        if (next.Holds(out _, out var refused) || refused.Refusal != IndexRefusal.OutOfMemory) return next;
        return refused with { Message = $"{refused.Message} {BodiesByKey}" };
    }

    public void Dispose() => _rows.Dispose();
}
