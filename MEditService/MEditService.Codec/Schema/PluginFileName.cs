using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Schema;

/// <summary>Why a name is no plugin file name.</summary>
public enum PluginFileNameFault
{
    None,

    /// <summary>A folder, or another character a ModKey cannot hold.</summary>
    InvalidCharacter,

    /// <summary>Nothing but whitespace before the extension.</summary>
    NoName,

    NoPluginExtension,
}

public static class PluginFileName
{
    // Mutagen's parse throws where it should refuse: ModKey.TryFromFileName on a name holding a folder, and
    // TryFromNameAndExtension on a character ModKey cannot hold past the name's 41st.
    public static PluginFileNameFault FaultOf(string name, out ModKey modKey)
    {
        modKey = default;
        if (ModKey.HasInvalidCharacters(name)) return PluginFileNameFault.InvalidCharacter;
        if (!ModKey.TryFromNameAndExtension(name, out modKey, out _)) return PluginFileNameFault.NoPluginExtension;
        if (!modKey.IsNull) return PluginFileNameFault.None;
        // ModKey's null stand-in parses from the bare word Null, which has no extension.
        return name.Contains('.', StringComparison.Ordinal) ? PluginFileNameFault.NoName : PluginFileNameFault.NoPluginExtension;
    }
}
