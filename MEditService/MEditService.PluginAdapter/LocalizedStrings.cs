using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Meta;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.PluginAdapter;

/// <summary>Where the game finds a plugin's localized strings, loose or in an archive: the folder that
/// holds the plugin, then the game Data folder, which holds what no mod provides.</summary>
public readonly record struct PluginStrings(string? PluginFolder, string DataFolderPath)
{
    internal IEnumerable<string> Folders =>
        PluginFolder is { } own && own != DataFolderPath ? [own, DataFolderPath] : [DataFolderPath];
}

/// <summary>Passing no <see cref="BinaryReadParameters"/> is not "no localization": Mutagen still
/// resolves a plugin-listings path that only a real game install has, and throws otherwise.
/// Handing it a strings folder directly stops that implicit lookup.</summary>
internal static class LocalizedStrings
{
    /// <summary>Mutagen's listings resolution reads the <c>LocalAppData</c> environment variable with no
    /// injectable seam; the env var is the only lever. Never overwrites a real value, and the
    /// placeholder is never read for content.</summary>
    internal static void EnsureLocalAppDataDefault()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("LocalAppData")))
            Environment.SetEnvironmentVariable("LocalAppData", Path.GetTempPath());
    }

    /// <summary>Mutagen's read takes its strings from one folder: the first that holds all of them, else the
    /// plugin's own, whose missing file <see cref="FindMissingStringsFile"/> names.</summary>
    internal static BinaryReadParameters ForRead(PluginStrings strings, ModKey plugin, GameRelease gameRelease) =>
        ForFolder(HoldingFolder(strings, plugin, gameRelease) ?? strings.Folders.First());

    /// <summary>A missing strings file is refused by name: <c>TranslatedString.TryLookup</c> returns false
    /// silently for one. Asked of the lookup the read uses, which finds a file loose or in an archive.</summary>
    internal static string? FindMissingStringsFile(
        IModGetter mod, string pluginName, PluginStrings strings, GameRelease gameRelease)
    {
        if (!mod.UsingLocalization) return null;
        var plugin = ModKey.FromFileName(pluginName);
        return HoldingFolder(strings, plugin, gameRelease) is null ? MissingFrom(strings.Folders.First(), plugin, gameRelease) : null;
    }

    private static string? HoldingFolder(PluginStrings strings, ModKey plugin, GameRelease gameRelease) =>
        strings.Folders.FirstOrDefault(folder => MissingFrom(folder, plugin, gameRelease) is null);

    private static string? MissingFrom(string folder, ModKey plugin, GameRelease gameRelease)
    {
        var languageFormat = GameConstants.Get(gameRelease).StringsLanguageFormat
            ?? throw new ArgumentException($"Tried to check localization strings for an unsupported game: {gameRelease}", nameof(gameRelease));
        var lookup = StringsFolderLookupOverlay.TypicalFactory(gameRelease, plugin, folder, ForFolder(folder).StringsParam);

        // English only; multi-language is deliberately out of scope.
        return new[] { StringsSource.Normal, StringsSource.IL, StringsSource.DL }
            .Where(source => !lookup.AvailableLanguages(source).Contains(Language.English))
            .Select(source => StringsUtility.GetFileName(languageFormat, plugin, Language.English, source))
            .FirstOrDefault();
    }

    // The folder is also the archive-scan root, so strings packed in an archive still resolve.
    private static BinaryReadParameters ForFolder(string folder)
    {
        EnsureLocalAppDataDefault();
        return new BinaryReadParameters
        {
            StringsParam = new StringsReadParameters
            {
                StringsFolderOverride = Path.Combine(folder, "Strings"),
                BsaFolderOverride = folder,
            },
        };
    }
}
