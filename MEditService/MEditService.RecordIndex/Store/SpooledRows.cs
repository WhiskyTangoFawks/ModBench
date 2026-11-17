using System.Diagnostics;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using DuckDB.NET.Data;

namespace MEditService.RecordIndex.Store;

/// <summary>A column of a streamed query: text, which is encoded as a JSON string here, or the JSON text DuckDB made.</summary>
internal sealed record StreamedColumn(string Name, bool IsText);

/// <summary>The rows of one query as JSON objects, spooled to a file as DuckDB produces them. The query's read ends
/// with the query, so a slow consumer holds no snapshot open (ADR-0029).</summary>
internal sealed class SpooledRows : IDisposable
{
    private const int FlushRows = 256;
    private const int LengthBytes = sizeof(int);
    private static readonly TimeSpan FlushAfter = TimeSpan.FromMilliseconds(5);
    private static readonly TimeSpan InterruptEvery = TimeSpan.FromMilliseconds(50);

    private readonly object _gate = new();
    private readonly CancellationToken _cancel;
    private readonly Action _interrupt;
    private readonly SpoolFile _spool;
    private readonly Thread _producer;
    private readonly string[] _names;
    private readonly IReadOnlyList<StreamedColumn> _columns;
    private long _pending;
    private long _published;
    private long _taken;
    private bool _finished;
    private bool _readEnded;
    private volatile bool _abandoned;
    private ExceptionDispatchInfo? _fault;

    /// <summary>Takes <paramref name="read"/>, <paramref name="command"/> and the writer of <paramref name="spool"/>,
    /// which the producer ends with the query.</summary>
    internal SpooledRows(ReadContext read, DuckDBCommand command, IReadOnlyList<StreamedColumn> columns, SpoolFile spool)
    {
        _cancel = read.Cancel;
        _interrupt = read.Interrupt;
        _spool = spool;
        _columns = columns;
        _names = [.. columns.Select(column => Encoded(column.Name))];
        _producer = new Thread(() => Produce(read, command)) { IsBackground = true, Name = "SELECT rows" };
        _producer.Start();
    }

    /// <summary>The next row's JSON object, or null after the last row. A fault of the query is thrown after the rows
    /// before it.</summary>
    public string? Next()
    {
        _cancel.ThrowIfCancellationRequested();
        lock (_gate)
        {
            while (_taken == _published && !_finished) Monitor.Wait(_gate);
            if (_taken == _published)
            {
                _fault?.Throw();
                return null;
            }
            _taken++;
        }
        Span<byte> length = stackalloc byte[LengthBytes];
        _spool.Reader.ReadExactly(length);
        var bytes = new byte[BitConverter.ToInt32(length)];
        _spool.Reader.ReadExactly(bytes);
        return Encoding.UTF8.GetString(bytes);
    }

    // An exception out of this thread ends the process.
    private void Produce(ReadContext read, DuckDBCommand command)
    {
        DuckDBDataReader? reader = null;
        var sinceFlush = Stopwatch.StartNew();
        try
        {
            reader = read.Observed(() => StoreFaults.Translating(command.ExecuteReader));
            while (!_abandoned && Row(read, reader) is { } row)
            {
                var bytes = Encoding.UTF8.GetBytes(row);
                _spool.Writer.Write(BitConverter.GetBytes(bytes.Length));
                _spool.Writer.Write(bytes);
                _pending++;
                if (_pending < FlushRows && sinceFlush.Elapsed < FlushAfter) continue;
                Publish();
                sinceFlush.Restart();
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            Failed(ex);
        }
        finally
        {
            Ending(Publish);
            Ending(() => reader?.Dispose());
            Ending(command.Dispose);
            lock (_gate) _readEnded = true;
            Ending(read.Dispose);
            Ending(_spool.Writer.Dispose);
            lock (_gate)
            {
                _finished = true;
                Monitor.PulseAll(_gate);
            }
        }
    }

    private void Ending(Action step)
    {
        try
        {
            step();
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            Failed(ex);
        }
    }

    private void Failed(Exception ex)
    {
        Exception reported = ex is IndexFaultException or OperationCanceledException
            ? ex
            : new IndexFaultException($"mEdit could not spool this SELECT's rows: {ex.Message}", ex) { Fault = IndexFault.Refused };
        lock (_gate) _fault ??= ExceptionDispatchInfo.Capture(reported);
    }

    private void Publish()
    {
        _spool.Writer.Flush();
        lock (_gate)
        {
            _published += _pending;
            Monitor.PulseAll(_gate);
        }
        _pending = 0;
    }

    private string? Row(ReadContext read, DuckDBDataReader reader)
    {
        if (!read.Observed(() => StoreFaults.Translating(() => Read(reader)))) return null;
        var row = new StringBuilder("{");
        for (var i = 0; i < _columns.Count; i++)
        {
            if (i > 0) row.Append(',');
            row.Append(_names[i]).Append(':');
            if (reader.IsDBNull(i)) row.Append("null");
            else row.Append(_columns[i].IsText ? Encoded(reader.GetString(i)) : reader.GetString(i));
        }
        return row.Append('}').ToString();
    }

    // DuckDB.NET throws an interrupt that reaches the stream in place of the failure as a bare OperationCanceledException.
    private static bool Read(DuckDBDataReader reader)
    {
        try
        {
            return reader.Read();
        }
        catch (OperationCanceledException ex)
        {
            throw new IndexFaultException("DuckDB interrupted the SELECT partway, and gave no reason.", ex) { Fault = IndexFault.Refused };
        }
    }

    private static string Encoded(string text) => $"\"{JsonEncodedText.Encode(text, JavaScriptEncoder.UnsafeRelaxedJsonEscaping)}\"";

    public void Dispose()
    {
        _abandoned = true;
        while (!_producer.Join(InterruptEvery))
        {
            lock (_gate)
            {
                if (!_readEnded) _interrupt();
            }
        }
        _spool.Dispose();
    }
}
