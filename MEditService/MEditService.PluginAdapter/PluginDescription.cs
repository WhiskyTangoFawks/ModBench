using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Headers;
using Mutagen.Bethesda.Plugins.Binary.Translations;
using Mutagen.Bethesda.Strings;
using Mutagen.Bethesda.Strings.DI;

namespace MEditService.PluginAdapter;

internal static class PluginDescription
{
    private static readonly RecordType DescriptionSubrecord = new("SNAM");

    /// <summary>The description in the plugin's header, or null for a header with none.</summary>
    internal static string? Of(ModPath modPath, GameRelease release)
    {
        var encoding = MutagenEncoding.Default.GetEncoding(release, Language.English);
        foreach (var frame in ModHeaderFrame.FromPath(modPath, release).Select(pin => pin.Frame))
        {
            if (frame.RecordType != DescriptionSubrecord) continue;
            var text = BinaryStringUtility.ProcessWholeToZString(frame.Content, encoding);
            return text.Length == 0 ? null : text;
        }
        return null;
    }
}
