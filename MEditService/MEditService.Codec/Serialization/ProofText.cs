using System.IO.Pipelines;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>ADR-0006's proof text.</summary>
public static class ProofText
{
    /// <summary><paramref name="plugin"/> written to the proof's text and read back as the source's read reads it.
    /// The text streams through a pipe as it is read, so memory holds only the pipe's window.</summary>
    public static IModGetter ReadBack(IModGetter plugin)
    {
        var game = GameCodecs.For(plugin.GameRelease);
        var text = new Pipe();
        using var reading = new CancellationTokenSource();
        var readEnded = reading.Token;

        // A thread of its own: the read blocks its thread while it waits for the text.
        _ = Task.Factory.StartNew(
                async () =>
                {
                    await using var writing = new UntilTheReadEnds(text.Writer.AsStream(), readEnded);
                    await game.WriteProofText(plugin, writing);
                },
                CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default)
            .Unwrap()
            .ContinueWith(written => text.Writer.Complete(written.Exception?.InnerException), TaskScheduler.Default);
        try
        {
            return AbsentIndexes.Fill(InlineSerialization.Finished(() => game.ReadProofText(text.Reader.AsStream(), plugin.ModKey, plugin.GameRelease)));
        }
        finally
        {
            reading.Cancel();
            text.Reader.Complete();
        }
    }

    // A pipe whose reader is done takes every write and discards it, so the writer is stopped here.
    private sealed class UntilTheReadEnds(Stream text, CancellationToken readEnded) : Stream
    {
        public override bool CanRead => false;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            readEnded.ThrowIfCancellationRequested();
            text.Write(buffer, offset, count);
        }

        public override void Flush() => text.Flush();

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
