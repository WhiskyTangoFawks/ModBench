using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Schema;

public static class CreatablePluginExtensions
{
    public static IReadOnlyList<string> Of(GameRelease release) =>
        [.. Enum.GetValues<ModType>()
            .Where(type => type != ModType.Light || LightPluginSupport.Of(release))
            .Select(type => "." + type.GetFileExtension())];
}
