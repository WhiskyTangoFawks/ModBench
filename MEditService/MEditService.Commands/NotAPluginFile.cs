using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Commands;

internal static class NotAPluginFile
{
    public static string Message(string name, GameRelease release)
    {
        var extensions = CreatablePluginExtensions.Of(release);
        return $"{name} is not a plugin file: its extension must be {string.Join(", ", extensions.SkipLast(1))} or {extensions[^1]}.";
    }
}
