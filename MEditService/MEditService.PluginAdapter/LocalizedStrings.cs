using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
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

    // Mutagen's default target, and the one language init checks for until the strings language setting chooses another.
    private const Language Target = Language.English;

    // Each archive's strings files by its stamp: a listed archive is opened once, not on every read, and a
    // changed archive is listed again (ADR-0003).
    private static readonly StampGatedMemo<string[]> StringsPathsIn = new(TimeProvider.System);

    // A strings file's hash by its stamp, and each archive's strings entries' hashes by the archive's.
    private static readonly StampGatedMemo<string> LooseHashes = new(TimeProvider.System);
    private static readonly StampGatedMemo<Dictionary<string, string>> StringsHashesIn = new(TimeProvider.System);

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
    internal static StringsRead ForRead(PluginStrings strings, LoadOrderSnapshot? loadOrder, ModPath plugin, GameRelease gameRelease)
    {
        if (!IsLocalized(plugin, gameRelease)) return new StringsRead(new BinaryReadParameters(), scratch: null);

        var found = Find(strings, loadOrder, plugin, gameRelease);
        var scratch = Directory.CreateTempSubdirectory("medit-strings-").FullName;
        try
        {
            var languageFormat = LanguageFormat(gameRelease);
            var stringsFolder = Directory.CreateDirectory(Path.Combine(scratch, "Strings")).FullName;
            foreach (var ((source, language), file) in found)
                File.WriteAllBytes(Path.Combine(stringsFolder, StringsUtility.GetFileName(languageFormat, plugin.ModKey, language, source)), file.Bytes());
            return new StringsRead(ForFolder(scratch), scratch);
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
        IModGetter mod, ModPath plugin, PluginStrings strings, LoadOrderSnapshot loadOrder, GameRelease gameRelease) =>
        FindMissingStringsFiles(mod, plugin, strings, loadOrder, gameRelease) is [var first, ..] ? first : null;

    /// <summary>Every strings file the lookup did not find. A translated text's own file is among them
    /// whenever it reads no text for want of its file.</summary>
    internal static IReadOnlyList<string> FindMissingStringsFiles(
        IModGetter mod, ModPath plugin, PluginStrings strings, LoadOrderSnapshot loadOrder, GameRelease gameRelease)
    {
        if (!mod.UsingLocalization) return [];

        var languageFormat = LanguageFormat(gameRelease);
        var found = Find(strings, loadOrder, plugin, gameRelease);
        return
        [
            .. Sources
                .Where(source => !found.ContainsKey((source, Target)))
                .Select(source => StringsUtility.GetFileName(languageFormat, plugin.ModKey, Target, source)),
        ];
    }

    /// <summary>What a read of <paramref name="plugin"/> under <paramref name="loadOrder"/> takes its strings from: each
    /// file it finds, where, and its bytes, hashed. Null for a plugin that is not localized.</summary>
    internal static string? ClaimOf(PluginStrings strings, LoadOrderSnapshot loadOrder, ModPath plugin, GameRelease gameRelease)
    {
        if (!IsLocalized(plugin, gameRelease)) return null;
        var found = Find(strings, loadOrder, plugin, gameRelease)
            .OrderBy(file => file.Key.Source).ThenBy(file => file.Key.Language)
            .Select(file => $"{file.Key.Source}|{file.Key.Language}|{file.Value.Where}|{file.Value.Hash()}");
        return PluginBinaryHash.OfBytes(Encoding.UTF8.GetBytes(string.Join('\n', found)));
    }

    /// <summary>Whether a path, forward-slash and relative to the plugin's folder, is one of the strings files compile
    /// writes for <paramref name="plugin"/>: none unless it is localized.</summary>
    internal static Func<string, bool> StringsFilesOf(ModPath plugin, GameRelease gameRelease)
    {
        const string folder = "Strings/";
        if (!IsLocalized(plugin, gameRelease)) return _ => false;
        var languageFormat = LanguageFormat(gameRelease);
        return path => path.StartsWith(folder, StringComparison.OrdinalIgnoreCase)
            && path.IndexOf('/', folder.Length) < 0
            && StringsFile.Named(path[folder.Length..], plugin.ModKey, languageFormat, path, () => [], () => "") is not null;
    }

    private static bool IsLocalized(ModPath plugin, GameRelease gameRelease) =>
        GameConstants.Get(gameRelease).StringsLanguageFormat is not null
        && gameRelease.ToCategory().GetLocalizedFlagIndex() is { } localized
        && (ModHeaderFrame.FromPath(plugin, gameRelease).Flags & localized) != 0;

    private static StringsLanguageFormat LanguageFormat(GameRelease gameRelease) =>
        GameConstants.Get(gameRelease).StringsLanguageFormat
        ?? throw new ArgumentException($"Tried to check localization strings for an unsupported game: {gameRelease}", nameof(gameRelease));

    // Each file from the first handed place holding it (ADR-0024), as the game reads it, none past the one completing
    // its language. The game's lists are the resolved copy's alone: another copy's IDs may differ.
    private static Dictionary<(StringsSource Source, Language Language), StringsFile> Find(
        PluginStrings strings, LoadOrderSnapshot? loadOrder, ModPath plugin, GameRelease gameRelease)
    {
        var languageFormat = LanguageFormat(gameRelease);
        var found = loadOrder is not null && loadOrder.ReadsTheGamesStrings(plugin.Path)
            ? FirstHolding(TheGamesPlaces(loadOrder, plugin.ModKey, gameRelease, languageFormat))
            : [];
        return found.Count > 0 ? found : FirstHolding(OwnPlaces(strings, plugin.ModKey, gameRelease, languageFormat));
    }

    private static Dictionary<(StringsSource Source, Language Language), StringsFile> FirstHolding(IEnumerable<IReadOnlyList<StringsFile>> places)
    {
        var found = new Dictionary<(StringsSource, Language), StringsFile>();
        foreach (var place in places)
        {
            foreach (var file in place) found.TryAdd((file.Source, file.Language), file);
            if (Sources.All(source => found.ContainsKey((source, Target)))) break;
        }
        return found;
    }

    // Loose files beat every archive, and a later archive's file replaces an earlier one's.
    private static IEnumerable<IReadOnlyList<StringsFile>> TheGamesPlaces(
        LoadOrderSnapshot loadOrder, ModKey plugin, GameRelease gameRelease, StringsLanguageFormat languageFormat)
    {
        yield return [.. Loose(loadOrder.StringsFiles, plugin, languageFormat)];
        foreach (var archive in loadOrder.Archives.Reverse()) yield return [.. InArchive(archive, plugin, gameRelease, languageFormat)];
    }

    // Never mixed with the game's places, whose string IDs may differ.
    private static IEnumerable<IReadOnlyList<StringsFile>> OwnPlaces(
        PluginStrings strings, ModKey plugin, GameRelease gameRelease, StringsLanguageFormat languageFormat)
    {
        yield return [.. Loose(strings.StringsFiles, plugin, languageFormat)];
        foreach (var archive in strings.Archives) yield return [.. InArchive(archive, plugin, gameRelease, languageFormat)];
    }

    private static IEnumerable<StringsFile> Loose(IEnumerable<string> paths, ModKey plugin, StringsLanguageFormat languageFormat) =>
        paths.Select(path => StringsFile.Named(
                Path.GetFileName(path), plugin, languageFormat, path, () => File.ReadAllBytes(path),
                () => LooseHashes.Of(path, () => PluginBinaryHash.OfBytes(File.ReadAllBytes(path)))
                    ?? throw new InvalidOperationException($"Expected a hash of '{path}'.")))
            .OfType<StringsFile>();

    private static IEnumerable<StringsFile> InArchive(string archive, ModKey plugin, GameRelease gameRelease, StringsLanguageFormat languageFormat)
    {
        var paths = Reading(archive, () => StringsPathsIn.Of(archive, () => [.. StringsIn(archive, gameRelease).Select(entry => entry.Path)])) ?? [];
        return paths
            .Select(path => StringsFile.Named(
                Path.GetFileName(path.Replace('\\', '/')), plugin, languageFormat, $"{archive}|{path}",
                () => Reading(archive, () => StringsIn(archive, gameRelease).First(entry => entry.Path == path).GetBytes()),
                () => Reading(archive, () => StringsHashesIn.Of(
                    archive, () => StringsIn(archive, gameRelease).ToDictionary(entry => entry.Path, entry => PluginBinaryHash.OfBytes(entry.GetBytes()))))
                    ?.GetValueOrDefault(path) ?? throw new InvalidOperationException($"Expected '{path}' in '{archive}'.")))
            .OfType<StringsFile>();
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

    private sealed record StringsFile(StringsSource Source, Language Language, string Where, Func<byte[]> Bytes, Func<string> Hash)
    {
        public static StringsFile? Named(
            string fileName, ModKey plugin, StringsLanguageFormat languageFormat, string where, Func<byte[]> bytes, Func<string> hash) =>
            StringsUtility.TryRetrieveInfoFromString(languageFormat, fileName, out var source, out var language, out var modName)
            && modName.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)
                ? new StringsFile(source, language, where, bytes, hash)
                : null;
    }
}
