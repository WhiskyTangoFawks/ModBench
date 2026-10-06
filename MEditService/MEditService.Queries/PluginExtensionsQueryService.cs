using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Queries;

/// <summary>The file extensions a new plugin may take in the held release: one per Mutagen mod type
/// the release's format carries.</summary>
public sealed class PluginExtensionsQueryService(LoadOrderHolder loadOrder)
{
    private const string Stem = "x";

    public IReadOnlyList<string> GetCreatable()
    {
        var release = loadOrder.Require().GameRelease;
        return [.. Enum.GetValues<ModType>()
            .Where(type => type != ModType.Light || LightPluginSupport.Of(release))
            .Select(type => new ModKey(Stem, type).FileName.String[Stem.Length..])];
    }
}
