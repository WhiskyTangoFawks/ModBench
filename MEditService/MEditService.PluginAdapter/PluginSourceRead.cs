using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter;

/// <summary>What <see cref="IPluginAdapter.ReadSourceOfAsync"/> made of a plugin's binary.</summary>
public abstract record PluginSourceRead
{
    private PluginSourceRead()
    {
    }

    /// <summary>The source tree the binary reads as, and the hash of the bytes it was read from, as
    /// the commit trailers spell it (ADR-0003).</summary>
    public sealed record Read(IReadOnlyList<TreeFile> Files, string BinarySha256) : PluginSourceRead;

    /// <summary>The localization file the plugin declares and the disk has not.</summary>
    public sealed record MissingStrings(string File) : PluginSourceRead;

    /// <summary>A read Mutagen could not make. <c>Error</c> is for the log.</summary>
    public sealed record Unparsed(PluginDiagnosis Diagnosis, Exception Error) : PluginSourceRead;
}
