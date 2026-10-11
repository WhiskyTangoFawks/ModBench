using Mutagen.Bethesda;
using Mutagen.Bethesda.Archives;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Headers;
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

/// <summary>The parameters a read takes its strings by, and the scratch folder they name until disposed.</summary>
internal sealed class StringsRead(BinaryReadParameters parameters, string? scratch) : IDisposable
{
    public BinaryReadParameters Parameters => parameters;

    public void Dispose()
    {
        if (scratch is not null) Directory.Delete(scratch, recursive: true);
    }
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

    /// <summary>Mutagen reads strings from one folder: the folder where the game finds them all, else a
    /// scratch folder each file is copied into from where the game finds it.</summary>
    internal static StringsRead ForRead(PluginStrings strings, IReadOnlyList<string> archives, ModPath plugin, GameRelease gameRelease)
    {
        if (!IsLocalized(plugin, gameRelease)) return new StringsRead(new BinaryReadParameters(), scratch: null);

        var found = Find(strings, archives, plugin.ModKey, gameRelease);
        if (found.Values.Select(place => place.Folder).Distinct().ToList() is [{ } folder])
            return new StringsRead(ForFolder(folder), scratch: null);
        if (found.Count == 0)
            return new StringsRead(ForFolder(strings.Folders.First()), scratch: null);

        var scratch = Directory.CreateTempSubdirectory("medit-strings-").FullName;
        try
        {
            var languageFormat = LanguageFormat(gameRelease);
            var stringsFolder = Directory.CreateDirectory(Path.Combine(scratch, "Strings")).FullName;
            foreach (var (source, place) in found)
                foreach (var file in place.Of(source))
                    File.WriteAllBytes(
                        Path.Combine(stringsFolder, StringsUtility.GetFileName(languageFormat, plugin.ModKey, file.Language, source)),
                        file.Bytes());
            return new StringsRead(ForFolder(scratch), scratch);
        }
        catch
        {
            Directory.Delete(scratch, recursive: true);
            throw;
        }
    }

    /// <summary>A missing strings file is refused by name: <c>TranslatedString.TryLookup</c> returns false
    /// silently for one. Asked of the lookup the read uses.</summary>
    internal static string? FindMissingStringsFile(
        IModGetter mod, string pluginName, PluginStrings strings, IReadOnlyList<string> archives, GameRelease gameRelease)
    {
        if (!mod.UsingLocalization) return null;

        var languageFormat = LanguageFormat(gameRelease);
        var plugin = ModKey.FromFileName(pluginName);
        var found = Find(strings, archives, plugin, gameRelease);

        // English only; multi-language is deliberately out of scope.
        return Sources
            .Where(source => !found.TryGetValue(source, out var place) || place.Of(source).All(file => file.Language != Language.English))
            .Select(source => StringsUtility.GetFileName(languageFormat, plugin, Language.English, source))
            .FirstOrDefault();
    }

    private static bool IsLocalized(ModPath plugin, GameRelease gameRelease) =>
        GameConstants.Get(gameRelease).StringsLanguageFormat is not null
        && gameRelease.ToCategory().GetLocalizedFlagIndex() is { } localized
        && (ModHeaderFrame.FromPath(plugin, gameRelease).Flags & localized) != 0;

    private static StringsLanguageFormat LanguageFormat(GameRelease gameRelease) =>
        GameConstants.Get(gameRelease).StringsLanguageFormat
        ?? throw new ArgumentException($"Tried to check localization strings for an unsupported game: {gameRelease}", nameof(gameRelease));

    // Each source is read from the first place that holds it in any language, as the game reads each file.
    private static Dictionary<StringsSource, Place> Find(
        PluginStrings strings, IReadOnlyList<string> archives, ModKey plugin, GameRelease gameRelease)
    {
        var found = new Dictionary<StringsSource, Place>();
        foreach (var place in Places(strings, archives, plugin, gameRelease))
        {
            foreach (var source in Sources.Where(source => !found.ContainsKey(source) && place.Of(source).Any()))
                found[source] = place;
            if (found.Count == Sources.Length) break;
        }
        return found;
    }

    // Loose files beat archives, and a later archive's file replaces an earlier one's: the game loads an
    // archive named for a plugin with the plugin, after those its INI lists.
    private static IEnumerable<Place> Places(
        PluginStrings strings, IReadOnlyList<string> archives, ModKey plugin, GameRelease gameRelease)
    {
        var languageFormat = LanguageFormat(gameRelease);
        foreach (var folder in strings.Folders)
        {
            string[] named = Directory.Exists(folder)
                ? [.. Directory.EnumerateFiles(folder, $"*{Archive.GetExtension(gameRelease)}")
                    .Where(archive => Archive.IsApplicable(gameRelease, plugin, Path.GetFileName(archive)))
                    .Order(StringComparer.OrdinalIgnoreCase)]
                : [];
            yield return new Place(folder, [
                .. Loose(Path.Combine(folder, "Strings"), plugin, languageFormat),
                .. named.SelectMany(archive => InArchive(archive, plugin, gameRelease, languageFormat))]);
        }

        yield return new Place(Folder: null, [.. archives.Reverse().SelectMany(archive => InArchive(archive, plugin, gameRelease, languageFormat))]);
    }

    // The pattern Mutagen's own lookup enumerates a strings folder with, so a file found here is one it reads.
    private static IEnumerable<StringsFile> Loose(string stringsFolder, ModKey plugin, StringsLanguageFormat languageFormat) =>
        Directory.Exists(stringsFolder)
            ? Directory.EnumerateFiles(stringsFolder, $"{plugin.Name}*{StringsUtility.StringsFileExtension}")
                .Select(path => StringsFile.Named(Path.GetFileName(path), plugin, languageFormat, () => File.ReadAllBytes(path)))
                .OfType<StringsFile>()
            : [];

    private static IEnumerable<StringsFile> InArchive(string archive, ModKey plugin, GameRelease gameRelease, StringsLanguageFormat languageFormat)
    {
        var files = Reading(archive, () =>
            Archive.CreateReader(gameRelease, archive).TryGetFolder("strings", out var folder) ? folder.Files : []);
        return files
            .Select(file => StringsFile.Named(Path.GetFileName(file.Path.Replace('\\', '/')), plugin, languageFormat, () => Reading(archive, file.GetBytes)))
            .OfType<StringsFile>();
    }

    private static T Reading<T>(string archive, Func<T> read)
    {
        try
        {
            return read();
        }
        catch (Exception ex) when (PluginFailure.StandsFor(ex))
        {
            throw new InvalidDataException($"its strings archive '{archive}' could not be read: {ex.Message}");
        }
    }

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

    // A folder's loose strings and the archives named for the plugin in it, or, with no folder, the archives the game loads.
    private sealed record Place(string? Folder, IReadOnlyList<StringsFile> Files)
    {
        // The first file of a language wins, as the places' own order has it.
        public IEnumerable<StringsFile> Of(StringsSource source) =>
            Files.Where(file => file.Source == source).DistinctBy(file => file.Language);
    }

    private sealed record StringsFile(StringsSource Source, Language Language, Func<byte[]> Bytes)
    {
        public static StringsFile? Named(string fileName, ModKey plugin, StringsLanguageFormat languageFormat, Func<byte[]> bytes) =>
            StringsUtility.TryRetrieveInfoFromString(languageFormat, fileName, out var source, out var language, out var modName)
            && modName.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)
                ? new StringsFile(source, language, bytes)
                : null;
    }
}
