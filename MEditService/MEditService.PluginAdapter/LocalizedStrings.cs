using System.Collections.Concurrent;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Archives;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Headers;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Meta;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.PluginAdapter;

/// <summary>The parameters a read takes its strings by, and the scratch folder they name until disposed.</summary>
internal sealed class StringsRead(BinaryReadParameters parameters, string? scratch) : IDisposable
{
    public BinaryReadParameters Parameters => parameters;

    public void Dispose()
    {
        if (scratch is not null) ScratchFolder.DeleteAsCourtesy(scratch);
    }
}

/// <summary>Passing no <see cref="BinaryReadParameters"/> is not "no localization": Mutagen still
/// resolves a plugin-listings path that only a real game install has, and throws otherwise.
/// Handing it a strings folder directly stops that implicit lookup.</summary>
internal static class LocalizedStrings
{
    private static readonly StringsSource[] Sources = [StringsSource.Normal, StringsSource.IL, StringsSource.DL];

    // Each archive's strings files by the stamp Mod Management handed with it (ADR-0013): a listed archive is opened
    // once, not on every read, and listed again once its stamp changes (ADR-0003).
    private static readonly ConcurrentDictionary<string, (string Stamp, string[] Paths)> StringsPathsIn = new(StringComparer.Ordinal);

    /// <summary>Mutagen's listings resolution reads the <c>LocalAppData</c> environment variable with no
    /// injectable seam; the env var is the only lever. Never overwrites a real value, and the
    /// placeholder is never read for content.</summary>
    internal static void EnsureLocalAppDataDefault()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("LocalAppData")))
            Environment.SetEnvironmentVariable("LocalAppData", Path.GetTempPath());
    }

    /// <summary>Mutagen reads strings from a scratch folder holding only the files found. In a folder
    /// holding an archive, Mutagen reads this machine's game INI for the archives it lists.</summary>
    internal static StringsRead ForRead(
        PluginStrings strings, LoadOrderSnapshot? loadOrder, ModPath plugin, GameRelease gameRelease, Language language)
    {
        if (!IsLocalized(plugin, gameRelease)) return new StringsRead(new BinaryReadParameters(), scratch: null);

        var found = Find(strings, loadOrder, plugin, gameRelease, language);
        var scratch = Directory.CreateTempSubdirectory("medit-strings-").FullName;
        try
        {
            var languageFormat = LanguageFormat(gameRelease);
            var stringsFolder = Directory.CreateDirectory(Path.Combine(scratch, "Strings")).FullName;
            foreach (var ((source, fileLanguage), file) in found)
                File.WriteAllBytes(Path.Combine(stringsFolder, StringsUtility.GetFileName(languageFormat, plugin.ModKey, fileLanguage, source)), file.Bytes());
            return new StringsRead(ForFolder(scratch, language), scratch);
        }
        catch
        {
            ScratchFolder.DeleteAsCourtesy(scratch);
            throw;
        }
    }

    /// <summary>A missing strings file is refused by name: <c>TranslatedString.TryLookup</c> returns false
    /// silently for one. Asked of the lookup the read uses.</summary>
    internal static string? FindMissingStringsFile(
        IModGetter mod, ModPath plugin, PluginStrings strings, LoadOrderSnapshot loadOrder, GameRelease gameRelease, Language language) =>
        FindMissingStringsFiles(mod, plugin, strings, loadOrder, gameRelease, language) is [var first, ..] ? first : null;

    /// <summary>Every strings file the lookup did not find. A translated text's own file is among them
    /// whenever it reads no text for want of its file.</summary>
    internal static IReadOnlyList<string> FindMissingStringsFiles(
        IModGetter mod, ModPath plugin, PluginStrings strings, LoadOrderSnapshot loadOrder, GameRelease gameRelease, Language language)
    {
        if (!mod.UsingLocalization) return [];

        var languageFormat = LanguageFormat(gameRelease);
        var found = Find(strings, loadOrder, plugin, gameRelease, language);
        return
        [
            .. Sources
                .Where(source => !found.ContainsKey((source, language)))
                .Select(source => StringsUtility.GetFileName(languageFormat, plugin.ModKey, language, source)),
        ];
    }

    /// <summary>The loose strings files and archives a read of localized <paramref name="plugin"/> under
    /// <paramref name="loadOrder"/> takes its strings from.</summary>
    internal static IReadOnlyList<string> PlacesOf(
        PluginStrings strings, LoadOrderSnapshot loadOrder, ModPath plugin, GameRelease gameRelease, Language language) =>
        [.. Find(strings, loadOrder, plugin, gameRelease, language).Values.Select(file => file.Holder).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)];

    /// <summary>Whether a path, forward-slash and relative to the plugin's folder, is one of the strings files compile
    /// writes for <paramref name="plugin"/>: none unless it is localized.</summary>
    internal static Func<string, bool> StringsFilesOf(ModPath plugin, GameRelease gameRelease)
    {
        const string folder = "Strings/";
        if (!IsLocalized(plugin, gameRelease)) return _ => false;
        var languageFormat = LanguageFormat(gameRelease);
        return path => path.StartsWith(folder, StringComparison.OrdinalIgnoreCase)
            && path.IndexOf('/', folder.Length) < 0
            && StringsFile.Named(path[folder.Length..], plugin.ModKey, languageFormat, path, () => []) is not null;
    }

    private static bool IsLocalized(ModPath plugin, GameRelease gameRelease) =>
        GameConstants.Get(gameRelease).StringsLanguageFormat is not null
        && gameRelease.ToCategory().GetLocalizedFlagIndex() is { } localized
        && (ModHeaderFrame.FromPath(plugin, gameRelease).Flags & localized) != 0;

    private static StringsLanguageFormat LanguageFormat(GameRelease gameRelease) =>
        GameConstants.Get(gameRelease).StringsLanguageFormat
        ?? throw new ArgumentException($"Tried to check localization strings for an unsupported game: {gameRelease}", nameof(gameRelease));

    // Each file from the first handed place holding it (ADR-0013), as the game reads it, none past the one completing
    // its language. The game's lists are the resolved copy's alone: another copy's IDs may differ.
    private static Dictionary<(StringsSource Source, Language Language), StringsFile> Find(
        PluginStrings strings, LoadOrderSnapshot? loadOrder, ModPath plugin, GameRelease gameRelease, Language language)
    {
        var languageFormat = LanguageFormat(gameRelease);
        var found = loadOrder is not null && loadOrder.ReadsTheGamesStrings(plugin.Path)
            ? FirstHolding(TheGamesPlaces(loadOrder, plugin.ModKey, gameRelease, languageFormat), language)
            : [];
        return found.Count > 0 ? found : FirstHolding(OwnPlaces(strings, plugin.ModKey, gameRelease, languageFormat), language);
    }

    private static Dictionary<(StringsSource Source, Language Language), StringsFile> FirstHolding(IEnumerable<IReadOnlyList<StringsFile>> places, Language language)
    {
        var found = new Dictionary<(StringsSource, Language), StringsFile>();
        foreach (var place in places)
        {
            foreach (var file in place) found.TryAdd((file.Source, file.Language), file);
            if (Sources.All(source => found.ContainsKey((source, language)))) break;
        }
        return found;
    }

    // Loose files beat every archive, and a later archive's file replaces an earlier one's.
    private static IEnumerable<IReadOnlyList<StringsFile>> TheGamesPlaces(
        LoadOrderSnapshot loadOrder, ModKey plugin, GameRelease gameRelease, StringsLanguageFormat languageFormat)
    {
        yield return [.. Loose(loadOrder.StringsFiles.Select(file => file.Path), plugin, languageFormat)];
        foreach (var archive in loadOrder.Archives.Reverse()) yield return [.. InArchive(archive, plugin, gameRelease, languageFormat)];
    }

    // Never mixed with the game's places, whose string IDs may differ.
    private static IEnumerable<IReadOnlyList<StringsFile>> OwnPlaces(
        PluginStrings strings, ModKey plugin, GameRelease gameRelease, StringsLanguageFormat languageFormat)
    {
        yield return [.. Loose(strings.StringsFiles.Select(file => file.Path), plugin, languageFormat)];
        foreach (var archive in strings.Archives) yield return [.. InArchive(archive, plugin, gameRelease, languageFormat)];
    }

    private static IEnumerable<StringsFile> Loose(IEnumerable<string> paths, ModKey plugin, StringsLanguageFormat languageFormat) =>
        paths.Select(path => StringsFile.Named(Path.GetFileName(path), plugin, languageFormat, path, () => File.ReadAllBytes(path))).OfType<StringsFile>();

    private static IEnumerable<StringsFile> InArchive(StampedFile handed, ModKey plugin, GameRelease gameRelease, StringsLanguageFormat languageFormat)
    {
        var archive = handed.Path;
        return StringsPathsOf(handed, gameRelease)
            .Select(path => StringsFile.Named(
                Path.GetFileName(path.Replace('\\', '/')), plugin, languageFormat, archive,
                () => Reading(archive, () => StringsIn(archive, gameRelease).First(entry => entry.Path == path).GetBytes())))
            .OfType<StringsFile>();
    }

    private static string[] StringsPathsOf(StampedFile archive, GameRelease gameRelease)
    {
        if (StringsPathsIn.TryGetValue(archive.Path, out var known) && known.Stamp == archive.Stamp) return known.Paths;
        var paths = Reading(archive.Path, () => StringsIn(archive.Path, gameRelease).Select(entry => entry.Path).ToArray());
        StringsPathsIn[archive.Path] = (archive.Stamp, paths);
        return paths;
    }

    private static IEnumerable<IArchiveFile> StringsIn(string archive, GameRelease gameRelease) =>
        Archive.CreateReader(gameRelease, archive).TryGetFolder("strings", out var strings) ? strings.Files : [];

    private static T Reading<T>(string archive, Func<T> read)
    {
        try
        {
            return read();
        }
        catch (Exception ex) when (OutOfMemoryOrCancellation.In(ex) is null)
        {
            throw new PluginFailureException(new PluginFailure.UnreadableStrings(archive, ex));
        }
    }

    private static BinaryReadParameters ForFolder(string folder, Language language)
    {
        EnsureLocalAppDataDefault();
        return new BinaryReadParameters
        {
            StringsParam = new StringsReadParameters
            {
                StringsFolderOverride = Path.Combine(folder, "Strings"),
                BsaFolderOverride = folder,
                TargetLanguage = language,
            },
        };
    }

    private sealed record StringsFile(StringsSource Source, Language Language, string Holder, Func<byte[]> Bytes)
    {
        public static StringsFile? Named(string fileName, ModKey plugin, StringsLanguageFormat languageFormat, string place, Func<byte[]> bytes) =>
            StringsUtility.TryRetrieveInfoFromString(languageFormat, fileName, out var source, out var language, out var modName)
            && modName.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)
                ? new StringsFile(source, language, place, bytes)
                : null;
    }
}
