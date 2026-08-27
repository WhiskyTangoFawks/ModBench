using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Meta;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.Core.Source;

/// <summary>
/// #515: every deep parse (Track, compile round-trip verification, session ingest's binary path,
/// external-change absorption) needs to tell Mutagen where a Localized plugin's own
/// <c>.STRINGS</c>/<c>.DLSTRINGS</c>/<c>.ILSTRINGS</c> files live. Passing no
/// <see cref="BinaryReadParameters"/> at all does not mean "no localization support" — Mutagen still
/// tries to resolve one, via a plugin-listings path that only exists in a genuine game install
/// (<c>%LocalAppData%\&lt;Game&gt;\Plugins.txt</c> on Windows) and throws outright when it can't be
/// determined, which is always on a non-Windows host with no such folder. Modbench's sessions are
/// always explicit (ADR-0022) and never consult that file, so the fix is not "give it a real one" —
/// it's "stop the implicit lookup from ever running", by handing Mutagen a strings folder directly.
/// </summary>
public static class LocalizedStrings
{
    /// <summary>
    /// Mutagen's own plugin-listings resolution (<c>PluginListingsPathProvider.Get</c>) reads the
    /// <c>LocalAppData</c> environment variable directly, with no injectable seam to substitute — the
    /// only lever the pinned Mutagen version exposes is the env var itself. Called from
    /// <see cref="ForRead(string?, string)"/> — every deep-parse call site already goes through it to
    /// get its <see cref="BinaryReadParameters"/>, so this always runs before the first parse that
    /// could need it, with no separate wiring and no dependence on which caller happens to run first.
    /// Idempotent and permanent, the same shape <c>MEditService.Api/Program.cs</c> used for this exact
    /// reason before this became the one shared place it lives: never overwrites a real value, and the
    /// placeholder is never read for content (Modbench never lists plugins from it).
    /// </summary>
    internal static void EnsureLocalAppDataDefault()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("LocalAppData")))
            Environment.SetEnvironmentVariable("LocalAppData", Path.GetTempPath());
    }

    /// <summary>
    /// The folder a plugin's own loose strings files would live in: its mod folder's own
    /// <c>Strings/</c> first, falling back to the game Data folder's <c>Strings/</c> for a plugin with
    /// no mod folder at all (a vanilla/DLC master, per <see cref="ModFolders.Of(string, string)"/>).
    /// </summary>
    public static string FolderFor(string? modFolder, string dataFolderPath) =>
        Path.Combine(modFolder ?? dataFolderPath, "Strings");

    /// <summary>
    /// Read parameters for every deep-parse call site: an explicit strings folder (see
    /// <see cref="FolderFor"/>) so Mutagen never falls through to its own implicit, listings-path-
    /// dependent resolution, and the same folder as the BSA-scan root so a mod that also ships its
    /// strings packed in an archive still resolves (safe now that <see cref="EnsureLocalAppDataDefault"/>
    /// has already run).
    /// </summary>
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

    /// <summary>
    /// <see cref="ForRead(string?, string)"/> for a caller that only ever has a mod folder in scope —
    /// external-change absorption and landing, both of which only ever run against an already-tracked
    /// (and therefore mod-folder-having) plugin, so there is no Data-folder case to fall back to.
    /// </summary>
    public static BinaryReadParameters ForRead(string modFolder) => ForRead(modFolder, modFolder);

    /// <summary>
    /// AC2 (#515): a Localized plugin whose strings files are missing must be refused by name, never
    /// with Mutagen's own listings-path exception (which <see cref="EnsureLocalAppDataDefault"/> now
    /// prevents) and never silently — <see cref="Mutagen.Bethesda.Strings.TranslatedString.TryLookup"/>
    /// returns <see langword="false"/> for a missing file with no exception at all, so nothing else
    /// would ever notice. Mutagen's own writer (<c>StringsWriter.Dispose</c>) always emits all three
    /// source files for a language the moment any string in that language is registered — even an
    /// otherwise-empty one — so a real Localized plugin missing any one of the three has lost data,
    /// not merely omitted an unused source. Checked for English only: the one language Modbench reads
    /// and writes today (translation/multi-language UX is explicitly out of #515's scope).
    /// </summary>
    /// <returns>The missing file's own name, or null when every expected file is present (or the
    /// plugin is not Localized at all, in which case there is nothing to check).</returns>
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
