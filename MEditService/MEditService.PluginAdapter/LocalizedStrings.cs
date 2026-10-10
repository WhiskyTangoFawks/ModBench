using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Meta;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.PluginAdapter;

/// <summary>Where a plugin's localized strings are: beside the plugin's file, in whatever folder
/// holds it, and in the game Data folder when that folder is unknown.</summary>
public readonly record struct PluginStrings(string? PluginFolder, string DataFolderPath)
{
    /// <summary>The folder a refusal names, so a caller can say where it looked.</summary>
    public string Folder => Path.Combine(PluginFolder ?? DataFolderPath, "Strings");
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

    /// <summary>An explicit strings folder so Mutagen never falls through to its implicit resolution, and
    /// the same folder as the BSA-scan root so archive-packed strings still resolve.</summary>
    internal static BinaryReadParameters ForRead(PluginStrings strings)
    {
        EnsureLocalAppDataDefault();
        return new BinaryReadParameters
        {
            StringsParam = new StringsReadParameters
            {
                StringsFolderOverride = strings.Folder,
                BsaFolderOverride = strings.PluginFolder ?? strings.DataFolderPath,
            },
        };
    }

    /// <summary>A missing strings file is refused by name: <c>TranslatedString.TryLookup</c> returns false
    /// silently for one. Mutagen's writer always emits all three files for a language, so a missing one
    /// is lost data. Asked of the lookup the read uses, which finds a file loose or in an archive.</summary>
    internal static string? FindMissingStringsFile(
        IModGetter mod, string pluginName, PluginStrings strings, GameRelease gameRelease)
    {
        if (!mod.UsingLocalization) return null;

        var languageFormat = GameConstants.Get(gameRelease).StringsLanguageFormat
            ?? throw new ArgumentException($"Tried to check localization strings for an unsupported game: {gameRelease}", nameof(gameRelease));
        var modKey = ModKey.FromFileName(pluginName);
        var lookup = StringsFolderLookupOverlay.TypicalFactory(
            gameRelease, modKey, strings.PluginFolder ?? strings.DataFolderPath, ForRead(strings).StringsParam);

        // English only; multi-language is deliberately out of scope.
        return new[] { StringsSource.Normal, StringsSource.IL, StringsSource.DL }
            .Where(source => !lookup.AvailableLanguages(source).Contains(Language.English))
            .Select(source => StringsUtility.GetFileName(languageFormat, modKey, Language.English, source))
            .FirstOrDefault();
    }
}
