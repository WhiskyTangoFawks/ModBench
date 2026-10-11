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
    public IEnumerable<string> Folders =>
        PluginFolder is { } own && own != DataFolderPath ? [own, DataFolderPath] : [DataFolderPath];
}

/// <summary>Passing no <see cref="BinaryReadParameters"/> is not "no localization": Mutagen still
/// resolves a plugin-listings path that only a real game install has, and throws otherwise.
/// Handing it a strings folder directly stops that implicit lookup.</summary>
internal static class LocalizedStrings
{
    private static readonly StringsSource[] Sources = [StringsSource.Normal, StringsSource.IL, StringsSource.DL];

    /// <summary>Mutagen's listings resolution reads the <c>LocalAppData</c> environment variable with no
    /// injectable seam; the env var is the only lever. Never overwrites a real value, and the
    /// placeholder is never read for content.</summary>
    internal static void EnsureLocalAppDataDefault()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("LocalAppData")))
            Environment.SetEnvironmentVariable("LocalAppData", Path.GetTempPath());
    }

    internal static BinaryReadParameters ForRead(PluginStrings strings, ModKey plugin, GameRelease gameRelease) =>
        ForFolder(ReadFolder(strings, plugin, gameRelease));

    /// <summary>A missing strings file is refused by name: <c>TranslatedString.TryLookup</c> returns false
    /// silently for one. Asked of the lookup the read uses, which finds a file loose or in an archive.</summary>
    internal static string? FindMissingStringsFile(
        IModGetter mod, string pluginName, PluginStrings strings, GameRelease gameRelease)
    {
        if (!mod.UsingLocalization) return null;

        var languageFormat = GameConstants.Get(gameRelease).StringsLanguageFormat
            ?? throw new ArgumentException($"Tried to check localization strings for an unsupported game: {gameRelease}", nameof(gameRelease));
        var plugin = ModKey.FromFileName(pluginName);
        var lookup = LookupIn(ReadFolder(strings, plugin, gameRelease), plugin, gameRelease);

        // English only; multi-language is deliberately out of scope.
        return Sources
            .Where(source => !lookup.AvailableLanguages(source).Contains(Language.English))
            .Select(source => StringsUtility.GetFileName(languageFormat, plugin, Language.English, source))
            .FirstOrDefault();
    }

    // Mutagen's read takes its strings from one folder: the first holding every source in some language.
    private static string ReadFolder(PluginStrings strings, ModKey plugin, GameRelease gameRelease) =>
        strings.Folders.FirstOrDefault(folder =>
        {
            var lookup = LookupIn(folder, plugin, gameRelease);
            return Sources.All(source => lookup.AvailableLanguages(source).Count > 0);
        }) ?? strings.Folders.First();

    private static StringsFolderLookupOverlay LookupIn(string folder, ModKey plugin, GameRelease gameRelease) =>
        StringsFolderLookupOverlay.TypicalFactory(gameRelease, plugin, folder, ForFolder(folder).StringsParam);

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
