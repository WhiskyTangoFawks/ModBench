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

/// <summary>The folder that holds the plugin, where its own strings sit, loose or in an archive named for it.
/// Every other place the game finds strings, the load order names (ADR-0013).</summary>
public readonly record struct PluginStrings(string? PluginFolder);

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

    // Mutagen's default target, and the one language Track checks for until the strings language setting chooses another.
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

    /// <summary>Mutagen reads strings from a scratch folder holding only the files found. In a folder
    /// holding an archive, Mutagen reads this machine's game INI for the archives it lists.</summary>
    internal static StringsRead ForRead(PluginStrings strings, LoadOrderSnapshot? loadOrder, ModPath plugin, GameRelease gameRelease)
    {
        if (!IsLocalized(plugin, gameRelease)) return new StringsRead(new BinaryReadParameters(), scratch: null);

        var found = Find(strings, loadOrder, plugin.ModKey, gameRelease);
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
        IModGetter mod, string pluginName, PluginStrings strings, LoadOrderSnapshot loadOrder, GameRelease gameRelease)
    {
        if (!mod.UsingLocalization) return null;

        var languageFormat = LanguageFormat(gameRelease);
        var plugin = ModKey.FromFileName(pluginName);
        var found = Find(strings, loadOrder, plugin, gameRelease);
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
        PluginStrings strings, LoadOrderSnapshot? loadOrder, ModKey plugin, GameRelease gameRelease)
    {
        var found = new Dictionary<(StringsSource, Language), StringsFile>();
        foreach (var place in Places(strings, loadOrder, plugin, gameRelease))
        {
            foreach (var file in place) found.TryAdd((file.Source, file.Language), file);
            if (Sources.All(source => found.ContainsKey((source, Target)))) break;
        }
        return found;
    }

    // A copy's own files first, so one the game does not load reads as its mod gives it. Loose files beat
    // every archive, and a later archive's file replaces an earlier one's.
    private static IEnumerable<IReadOnlyList<StringsFile>> Places(
        PluginStrings strings, LoadOrderSnapshot? loadOrder, ModKey plugin, GameRelease gameRelease)
    {
        var languageFormat = LanguageFormat(gameRelease);
        if (strings.PluginFolder is { } own) yield return [.. Loose(own, plugin, languageFormat)];
        yield return
        [
            .. (loadOrder?.StringsFiles ?? [])
                .Select(path => StringsFile.Named(Path.GetFileName(path), plugin, languageFormat, () => File.ReadAllBytes(path)))
                .OfType<StringsFile>(),
        ];
        if (strings.PluginFolder is { } folder && Directory.Exists(folder))
        {
            var named = Directory.EnumerateFiles(folder, $"*{Archive.GetExtension(gameRelease)}")
                .Where(archive => Archive.IsApplicable(gameRelease, plugin, Path.GetFileName(archive)))
                .Order(StringComparer.OrdinalIgnoreCase);
            foreach (var archive in named) yield return [.. InArchive(archive, plugin, gameRelease, languageFormat)];
        }

        foreach (var archive in (loadOrder?.Archives ?? []).Reverse()) yield return [.. InArchive(archive, plugin, gameRelease, languageFormat)];
    }

    // The pattern Mutagen's own lookup enumerates a strings folder with.
    private static IEnumerable<StringsFile> Loose(string folder, ModKey plugin, StringsLanguageFormat languageFormat)
    {
        var stringsFolder = Path.Combine(folder, "Strings");
        return Directory.Exists(stringsFolder)
            ? Directory.EnumerateFiles(stringsFolder, $"{plugin.Name}*{StringsUtility.StringsFileExtension}")
                .Select(path => StringsFile.Named(Path.GetFileName(path), plugin, languageFormat, () => File.ReadAllBytes(path)))
                .OfType<StringsFile>()
            : [];
    }

    private static IEnumerable<StringsFile> InArchive(string archive, ModKey plugin, GameRelease gameRelease, StringsLanguageFormat languageFormat)
    {
        var paths = Reading(archive, () => StringsPathsIn.Of(archive, () => [.. StringsIn(archive, gameRelease).Select(entry => entry.Path)])) ?? [];
        return paths
            .Select(path => StringsFile.Named(
                Path.GetFileName(path.Replace('\\', '/')), plugin, languageFormat,
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

    private sealed record StringsFile(StringsSource Source, Language Language, Func<byte[]> Bytes)
    {
        public static StringsFile? Named(string fileName, ModKey plugin, StringsLanguageFormat languageFormat, Func<byte[]> bytes) =>
            StringsUtility.TryRetrieveInfoFromString(languageFormat, fileName, out var source, out var language, out var modName)
            && modName.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)
                ? new StringsFile(source, language, bytes)
                : null;
    }
}
