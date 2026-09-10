using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Meta;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.Core.PluginAdapter;

/// <summary>Where a plugin's localized strings are: its own mod folder, falling back to the game
/// Data folder for a plugin with no mod folder (a vanilla/DLC master).</summary>
public readonly record struct PluginStrings(string? ModFolder, string DataFolderPath)
{
    /// <summary>For callers that only ever run against a tracked plugin, which always has a mod
    /// folder.</summary>
    public static PluginStrings In(string modFolder) => new(modFolder, modFolder);

    /// <summary>The folder a refusal names, so a caller can say where it looked.</summary>
    public string Folder => Path.Combine(ModFolder ?? DataFolderPath, "Strings");
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
                BsaFolderOverride = strings.ModFolder ?? strings.DataFolderPath,
            },
        };
    }

    /// <summary>A missing strings file is refused by name: <c>TranslatedString.TryLookup</c> returns false
    /// silently for one. Mutagen's writer always emits all three files for a language, so a missing one
    /// is lost data.</summary>
    internal static string? FindMissingStringsFile(
        IModGetter mod, string pluginName, PluginStrings strings, GameRelease gameRelease)
    {
        if (!mod.UsingLocalization) return null;

        var languageFormat = GameConstants.Get(gameRelease).StringsLanguageFormat
            ?? throw new ArgumentException($"Tried to check localization strings for an unsupported game: {gameRelease}", nameof(gameRelease));
        var modKey = ModKey.FromFileName(pluginName);

        foreach (var source in new[] { StringsSource.Normal, StringsSource.IL, StringsSource.DL })
        {
            // English only; multi-language is deliberately out of scope.
            var fileName = StringsUtility.GetFileName(languageFormat, modKey, Language.English, source);
            if (!File.Exists(Path.Combine(strings.Folder, fileName)))
                return fileName;
        }

        return null;
    }
}
