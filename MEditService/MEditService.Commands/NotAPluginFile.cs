using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Commands;

internal static class NotAPluginFile
{
    public static string Message(string name, PluginFileNameFault fault, GameRelease release)
    {
        var extensions = CreatablePluginExtensions.Of(release);
        return fault switch
        {
            PluginFileNameFault.InvalidCharacter => $"{name} is not a plugin file name: it holds a folder, or a character a plugin's name cannot.",
            PluginFileNameFault.NoName => $"{name} is not a plugin file name: it holds no name before its extension.",
            PluginFileNameFault.NoPluginExtension =>
                $"{name} is not a plugin file: its extension must be {string.Join(", ", extensions.SkipLast(1))} or {extensions[^1]}.",
            _ => throw new ArgumentOutOfRangeException(nameof(fault), fault, "Expected a fault: a plugin file name has no message."),
        };
    }
}
