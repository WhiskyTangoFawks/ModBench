using System.Diagnostics;
using System.Runtime.ExceptionServices;
using System.Text;

namespace MEditService.RecordIndex.Store;

/// <summary>The rows of one streamed query, spooled to a file as the query produces them and served at the consumer's
/// pace, so the query's read ends with the query (ADR-0029).</summary>
internal sealed class SpooledRows : IDisposable
{
    private const int FlushRows = 256;
    private const int LengthBytes = sizeof(int);
    private static readonly TimeSpan FlushAfter = TimeSpan.FromMilliseconds(5);

    private readonly object _gate = new();
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"medit-select-{Guid.NewGuid():N}.rows");
    private readonly StreamedRows _source;
    private readonly FileStream _writer;
    private readonly FileStream _reader;
    private readonly Thread _producer;
    private long _published;
    private long _taken;
    private bool _finished;
    private volatile bool _abandoned;
    private ExceptionDispatchInfo? _fault;

    internal SpooledRows(StreamedRows source)
    {
        _source = source;
        _writer = new FileStream(_path, FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        _reader = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        _producer = new Thread(() => Produce()) { IsBackground = true, Name = "SELECT rows" };
        _producer.Start();
    }

    /// <summary>The next row's JSON object, or null after the last row. A fault of the query is thrown after the rows
    /// before it.</summary>
    public string? Next() => _source.Observed(NextRow);

    private string? NextRow()
    {
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
        _reader.ReadExactly(length);
        var bytes = new byte[BitConverter.ToInt32(length)];
        _reader.ReadExactly(bytes);
        return Encoding.UTF8.GetString(bytes);
    }

    private void Produce()
    {
        long pending = 0;
        var sinceFlush = Stopwatch.StartNew();
        try
        {
            while (!_abandoned && _source.Next() is { } row)
            {
                var bytes = Encoding.UTF8.GetBytes(row);
                _writer.Write(BitConverter.GetBytes(bytes.Length));
                _writer.Write(bytes);
                pending++;
                if (pending < FlushRows && sinceFlush.Elapsed < FlushAfter) continue;
                Publish(ref pending);
                sinceFlush.Restart();
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            _fault = ExceptionDispatchInfo.Capture(ex);
        }
        finally
        {
            Publish(ref pending);
            _writer.Dispose();
            _source.Dispose();
            lock (_gate)
            {
                _finished = true;
                Monitor.PulseAll(_gate);
            }
        }
    }

    private void Publish(ref long pending)
    {
        _writer.Flush();
        lock (_gate)
        {
            _published += pending;
            Monitor.PulseAll(_gate);
        }
        pending = 0;
    }

    public void Dispose()
    {
        _abandoned = true;
        _producer.Join();
        _writer.Dispose();
        _source.Dispose();
        _reader.Dispose();
        File.Delete(_path);
    }
}
