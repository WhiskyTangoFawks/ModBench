using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Meta;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.Core.Source;

/// <summary>Passing no <see cref="BinaryReadParameters"/> is not "no localization": Mutagen still
/// resolves a plugin-listings path that only a real game install has, and throws otherwise.
/// Handing it a strings folder directly stops that implicit lookup.</summary>
public static class LocalizedStrings
{
    /// <summary>Mutagen's listings resolution reads the <c>LocalAppData</c> environment variable with no
    /// injectable seam; the env var is the only lever. Never overwrites a real value, and the
    /// placeholder is never read for content.</summary>
    internal static void EnsureLocalAppDataDefault()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("LocalAppData")))
            Environment.SetEnvironmentVariable("LocalAppData", Path.GetTempPath());
    }

    /// <summary>The mod folder's own <c>Strings/</c>, falling back to the game Data folder's for a plugin
    /// with no mod folder (a vanilla/DLC master).</summary>
    public static string FolderFor(string? modFolder, string dataFolderPath) =>
        Path.Combine(modFolder ?? dataFolderPath, "Strings");

    /// <summary>An explicit strings folder so Mutagen never falls through to its implicit resolution, and
    /// the same folder as the BSA-scan root so archive-packed strings still resolve.</summary>
    public static BinaryReadParameters ForRead(string? modFolder, string dataFolderPath)
    {
        EnsureLocalAppDataDefault();
        return new BinaryReadParameters
        {
            StringsParam = new StringsReadParameters
            {
                StringsFolderOverride = FolderFor(modFolder, dataFolderPath),
                BsaFolderOverride = modFolder ?? dataFolderPath,
            },
        };
    }

    /// <summary>For callers that only ever run against a tracked plugin, which always has a mod folder.</summary>
    public static BinaryReadParameters ForRead(string modFolder) => ForRead(modFolder, modFolder);

    /// <summary>A missing strings file is refused by name: <c>TranslatedString.TryLookup</c> returns false
    /// silently for one. Mutagen's writer always emits all three files for a language, so a missing one
    /// is lost data.</summary>
    public static string? FindMissingStringsFile(
        IModGetter mod, string pluginName, string? modFolder, string dataFolderPath, GameRelease gameRelease)
    {
        if (!mod.UsingLocalization) return null;

        var stringsFolder = FolderFor(modFolder, dataFolderPath);
        var languageFormat = GameConstants.Get(gameRelease).StringsLanguageFormat
            ?? throw new ArgumentException($"Tried to check localization strings for an unsupported game: {gameRelease}", nameof(gameRelease));
        var modKey = ModKey.FromFileName(pluginName);

        foreach (var source in new[] { StringsSource.Normal, StringsSource.IL, StringsSource.DL })
        {
            var fileName = StringsUtility.GetFileName(languageFormat, modKey, Language.English, source);
            if (!File.Exists(Path.Combine(stringsFolder, fileName)))
                return fileName;
        }

        return null;
    }
}
