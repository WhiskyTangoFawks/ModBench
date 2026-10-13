namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A seekable stream that holds only the blocks written with a byte other than zero, so gigabytes of
/// zeros cost no memory.</summary>
internal sealed class SparseStream : Stream
{
    private const int BlockSize = 1 << 16;

    private readonly Dictionary<long, byte[]> _blocks = [];
    private long _length;

    public override bool CanRead => true;

    public override bool CanSeek => true;

    public override bool CanWrite => true;

    public override long Length => _length;

    public override long Position { get; set; }

    public override int Read(byte[] buffer, int offset, int count)
    {
        var read = (int)Math.Min(count, Math.Max(0, _length - Position));
        for (var done = 0; done < read;)
        {
            var (block, at, span) = Span(done, read);
            if (_blocks.TryGetValue(block, out var bytes)) Array.Copy(bytes, at, buffer, offset + done, span);
            else Array.Clear(buffer, offset + done, span);
            done += span;
        }
        Position += read;
        return read;
    }

    public override void Write(byte[] buffer, int offset, int count)
    {
        for (var done = 0; done < count;)
        {
            var (block, at, span) = Span(done, count);
            var source = buffer.AsSpan(offset + done, span);
            if (_blocks.TryGetValue(block, out var bytes) || source.ContainsAnyExcept((byte)0))
            {
                bytes ??= _blocks[block] = new byte[BlockSize];
                source.CopyTo(bytes.AsSpan(at));
            }
            done += span;
        }
        Position += count;
        _length = Math.Max(_length, Position);
    }

    public override long Seek(long offset, SeekOrigin origin) => Position = origin switch
    {
        SeekOrigin.Begin => offset,
        SeekOrigin.Current => Position + offset,
        _ => _length + offset,
    };

    public override void SetLength(long value) => _length = value;

    public override void Flush()
    {
    }

    private (long Block, int At, int Span) Span(int done, int count)
    {
        var position = Position + done;
        var at = (int)(position % BlockSize);
        return (position / BlockSize, at, Math.Min(count - done, BlockSize - at));
    }
}
