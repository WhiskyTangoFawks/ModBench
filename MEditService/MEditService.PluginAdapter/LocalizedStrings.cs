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
        if (scratch is not null) ScratchFolder.DeleteAsCourtesy(scratch);
    }
}

/// <summary>An archive the strings lookup opened and could not read.</summary>
internal sealed class UnreadableStringsArchiveException : InvalidOperationException
{
    // RCS1194's standard constructors; the lookup throws only through Of.
    internal UnreadableStringsArchiveException()
    {
    }

    internal UnreadableStringsArchiveException(string message) : base(message)
    {
    }

    internal UnreadableStringsArchiveException(string message, Exception innerException) : base(message, innerException)
    {
    }

    internal static UnreadableStringsArchiveException Of(string archive, Exception innerException) =>
        new($"its strings archive '{archive}' could not be read: {innerException.Message}", innerException);
}

/// <summary>Passing no <see cref="BinaryReadParameters"/> is not "no localization": Mutagen still
/// resolves a plugin-listings path that only a real game install has, and throws otherwise.
/// Handing it a strings folder directly stops that implicit lookup.</summary>
internal static class LocalizedStrings
{
    private static readonly StringsSource[] Sources = [StringsSource.Normal, StringsSource.IL, StringsSource.DL];

    // Mutagen's default target, and the one language Track checks for; multi-language is deliberately out of scope.
    private const Language Target = Language.English;

    // Each archive's strings files by its stamp: a listed archive is opened once, not on every read, and a
    // changed archive is listed again (ADR-0003).
    private static readonly StampGatedMemo<string[]> StringsPathsIn = new(TimeProvider.System);

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
    internal static StringsRead ForRead(PluginStrings strings, IReadOnlyList<string> archives, ModPath plugin, GameRelease gameRelease) =>
        For(strings, archives, plugin, gameRelease, inOneOrder: false);

    /// <summary>An import lists a string's languages in the order Mutagen finds their files, an archive's
    /// order or a folder's. So an import always reads them copied into a fresh folder in name order, and the
    /// order follows the file system alone: decompiling an unchanged plugin changes nothing (plugin-source.md).</summary>
    internal static StringsRead ForImport(PluginStrings strings, IReadOnlyList<string> archives, ModPath plugin, GameRelease gameRelease) =>
        For(strings, archives, plugin, gameRelease, inOneOrder: true);

    private static StringsRead For(PluginStrings strings, IReadOnlyList<string> archives, ModPath plugin, GameRelease gameRelease, bool inOneOrder)
    {
        if (!IsLocalized(plugin, gameRelease)) return new StringsRead(new BinaryReadParameters(), scratch: null);

        var found = Find(strings, archives, plugin.ModKey, gameRelease);
        if (!inOneOrder && found.Values.Select(file => file.Folder).Distinct().ToList() is [{ } folder])
            return new StringsRead(ForFolder(folder), scratch: null);
        if (found.Count == 0)
            return new StringsRead(ForFolder(strings.Folders.First()), scratch: null);

        var scratch = Directory.CreateTempSubdirectory("medit-strings-").FullName;
        try
        {
            var languageFormat = LanguageFormat(gameRelease);
            var stringsFolder = Directory.CreateDirectory(Path.Combine(scratch, "Strings")).FullName;
            foreach (var (name, file) in found
                .Select(each => (Name: StringsUtility.GetFileName(languageFormat, plugin.ModKey, each.Key.Language, each.Key.Source), File: each.Value))
                .OrderBy(each => each.Name, StringComparer.Ordinal))
                File.WriteAllBytes(Path.Combine(stringsFolder, name), file.Bytes());
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
        IModGetter mod, string pluginName, PluginStrings strings, IReadOnlyList<string> archives, GameRelease gameRelease)
    {
        if (!mod.UsingLocalization) return null;

        var languageFormat = LanguageFormat(gameRelease);
        var plugin = ModKey.FromFileName(pluginName);
        var found = Find(strings, archives, plugin, gameRelease);
        return Sources
            .Where(source => !found.ContainsKey((source, Target)))
            .Select(source => StringsUtility.GetFileName(languageFormat, plugin, Target, source))
            .FirstOrDefault();
    }

    private static bool IsLocalized(ModPath plugin, GameRelease gameRelease) =>
        GameConstants.Get(gameRelease).StringsLanguageFormat is not null
        && gameRelease.ToCategory().GetLocalizedFlagIndex() is { } localized
        && (ModHeaderFrame.FromPath(plugin, gameRelease).Flags & localized) != 0;

    private static StringsLanguageFormat LanguageFormat(GameRelease gameRelease) =>
        GameConstants.Get(gameRelease).StringsLanguageFormat
        ?? throw new ArgumentException($"Tried to check localization strings for an unsupported game: {gameRelease}", nameof(gameRelease));

    // Each file is read from the first place that holds it, as the game reads it. The game reads only its
    // own language, so no place past the one that completes the target language is opened.
    private static Dictionary<(StringsSource Source, Language Language), StringsFile> Find(
        PluginStrings strings, IReadOnlyList<string> archives, ModKey plugin, GameRelease gameRelease)
    {
        var found = new Dictionary<(StringsSource, Language), StringsFile>();
        foreach (var place in Places(strings, archives, plugin, gameRelease))
        {
            foreach (var file in place) found.TryAdd((file.Source, file.Language), file);
            if (Sources.All(source => found.ContainsKey((source, Target)))) break;
        }
        return found;
    }

    // Each folder's loose files, then each archive named for the plugin in it; then the archives the game
    // loads, the latest first, since a later archive's file replaces an earlier one's.
    private static IEnumerable<IReadOnlyList<StringsFile>> Places(
        PluginStrings strings, IReadOnlyList<string> archives, ModKey plugin, GameRelease gameRelease)
    {
        var languageFormat = LanguageFormat(gameRelease);
        foreach (var folder in strings.Folders)
        {
            yield return [.. Loose(folder, plugin, languageFormat)];
            var named = Directory.Exists(folder)
                ? Directory.EnumerateFiles(folder, $"*{Archive.GetExtension(gameRelease)}")
                    .Where(archive => Archive.IsApplicable(gameRelease, plugin, Path.GetFileName(archive)))
                    .Order(StringComparer.OrdinalIgnoreCase)
                : Enumerable.Empty<string>();
            foreach (var archive in named) yield return [.. InArchive(archive, folder, plugin, gameRelease, languageFormat)];
        }

        foreach (var archive in archives.Reverse()) yield return [.. InArchive(archive, folder: null, plugin, gameRelease, languageFormat)];
    }

    // The pattern Mutagen's own lookup enumerates a strings folder with, so a file found here is one it reads.
    private static IEnumerable<StringsFile> Loose(string folder, ModKey plugin, StringsLanguageFormat languageFormat)
    {
        var stringsFolder = Path.Combine(folder, "Strings");
        return Directory.Exists(stringsFolder)
            ? Directory.EnumerateFiles(stringsFolder, $"{plugin.Name}*{StringsUtility.StringsFileExtension}")
                .Select(path => StringsFile.Named(Path.GetFileName(path), plugin, languageFormat, folder, () => File.ReadAllBytes(path)))
                .OfType<StringsFile>()
            : [];
    }

    private static IEnumerable<StringsFile> InArchive(
        string archive, string? folder, ModKey plugin, GameRelease gameRelease, StringsLanguageFormat languageFormat)
    {
        var paths = Reading(archive, () => StringsPathsIn.Of(archive, () => [.. StringsIn(archive, gameRelease).Select(entry => entry.Path)])) ?? [];
        return paths
            .Select(path => StringsFile.Named(
                Path.GetFileName(path.Replace('\\', '/')), plugin, languageFormat, folder,
                () => Reading(archive, () => StringsIn(archive, gameRelease).First(entry => entry.Path == path).GetBytes())))
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
        catch (Exception ex) when (PluginFailure.StandsFor(ex))
        {
            throw UnreadableStringsArchiveException.Of(archive, ex);
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

    // Folder: where Mutagen finds the file itself, loose or in an archive named for the plugin; null for an
    // archive the game loads, which Mutagen never searches.
    private sealed record StringsFile(StringsSource Source, Language Language, string? Folder, Func<byte[]> Bytes)
    {
        public static StringsFile? Named(string fileName, ModKey plugin, StringsLanguageFormat languageFormat, string? folder, Func<byte[]> bytes) =>
            StringsUtility.TryRetrieveInfoFromString(languageFormat, fileName, out var source, out var language, out var modName)
            && modName.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)
                ? new StringsFile(source, language, folder, bytes)
                : null;
    }
}
