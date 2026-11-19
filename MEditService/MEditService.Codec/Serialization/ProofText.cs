using System.IO.Pipelines;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>ADR-0006's proof: a plugin through the text of its game's serializer with no customization,
/// so tolerating the format's normalization never hides what the text loses.</summary>
public static class ProofText
{
    /// <summary><paramref name="plugin"/> written to the proof's text in memory and read back as the
    /// source's read reads it.</summary>
    public static IModGetter ReadBack(IModGetter plugin)
    {
        var game = GameCodecs.For(plugin.GameRelease);

        // A pipe that never pauses holds the whole text in segments: a master's text outgrows a MemoryStream's 2 GB.
        var text = new Pipe(new PipeOptions(pauseWriterThreshold: 0));
        InlineSerialization.Finished(game.WriteProofText(plugin, text.Writer.AsStream()));
        text.Writer.Complete();
        return AbsentIndexes.Fill(InlineSerialization.Finished(() => game.ReadProofText(text.Reader.AsStream(), plugin.ModKey, plugin.GameRelease)));
    }
}
