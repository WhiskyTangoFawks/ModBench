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

        // A thread of its own: the read blocks its thread while it waits for the text.
        _ = Task.Factory.StartNew(
                () => InlineSerialization.Finished(game.WriteProofText(plugin, text.Writer.AsStream())),
                CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default)
            .ContinueWith(written => text.Writer.Complete(written.Exception?.InnerException), TaskScheduler.Default);
        try
        {
            return AbsentIndexes.Fill(InlineSerialization.Finished(() => game.ReadProofText(text.Reader.AsStream(), plugin.ModKey, plugin.GameRelease)));
        }
        finally
        {
            text.Reader.Complete();
        }
    }
}
