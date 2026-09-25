using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>The hand mEdit does not own: MO2, xEdit, the game or the user, writing the same files
/// from outside the process. Every method here writes; none of them asks the service anything.</summary>
internal static class OtherTool
{
    internal static string ModFolderOf(ScatteredFixtureData fx, string origin) =>
        Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == origin).Path).Require();

    internal static void WritesThePlugin(string path, Action<Fallout4Mod> contents)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(Path.GetFileName(path)), Fallout4Release.Fallout4);
        contents(mod);
        mod.WriteToBinary(path);
    }

    internal static void DeletesTheFile(string path) => File.Delete(path);

    internal static void DeletesTheDirectory(string path) => Directory.Delete(path, recursive: true);

    /// <summary>A folder holding one file, written outside the mod folder and moved in whole.</summary>
    internal static void MovesInAFolderHolding(string folder, string fileName, string contents)
    {
        var aside = Path.Combine(Path.GetTempPath(), $"medit-aside-{Guid.NewGuid():n}");
        WritesTheFile(Path.Combine(aside, fileName), contents);
        Directory.Move(aside, folder);
    }

    internal static void WritesTheFile(string path, string contents)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path).Require());
        File.WriteAllText(path, contents);
    }

    /// <summary>A hand edit to a document under the tracked source tree, found by the text it
    /// carries so no test has to know the layout the repository chose for it.</summary>
    internal static void EditsASourceDocument(string modFolder, string plugin, string find, string replacement)
    {
        var document = SourceDocumentCarrying(modFolder, plugin, find);
        File.WriteAllText(
            document, File.ReadAllText(document).Replace(find, replacement, StringComparison.Ordinal));
    }

    /// <summary>Process-shelled because File.SetUnixFileMode is flagged platform-unsafe (CA1416)
    /// even on a Linux-only runtime, and recursive because a handler writes into subdirectories
    /// Track left writable.</summary>
    internal static void SetsThePermissions(string path, string mode)
    {
        using var chmod = System.Diagnostics.Process.Start(
            new System.Diagnostics.ProcessStartInfo("chmod", ["-R", mode, path]) { RedirectStandardError = true })
            ?? throw new InvalidOperationException($"Expected 'chmod {mode} {path}' to start a process.");
        chmod.WaitForExit();
        if (chmod.ExitCode != 0)
            throw new InvalidOperationException($"chmod {mode} {path} failed: {chmod.StandardError.ReadToEnd()}");
    }

    /// <summary>A document moved by hand to <paramref name="renamedTo"/>, a path relative to its own
    /// folder in which <c>{0}</c> stands for its current file name.</summary>
    internal static void RenamesASourceDocument(string modFolder, string plugin, string textItCarries, string renamedTo)
    {
        var document = SourceDocumentCarrying(modFolder, plugin, textItCarries);
        File.Move(document, Beside(document, renamedTo));
    }

    /// <summary>The first half of a move that copies, then deletes: <paramref name="document"/> copied
    /// to <paramref name="copiedTo"/>, relative to its folder, <c>{0}</c> standing for its file
    /// name.</summary>
    internal static void CopiesASourceDocument(string document, string copiedTo) =>
        File.Copy(document, Beside(document, copiedTo));

    /// <summary><see cref="CopiesASourceDocument"/> for a container, whose document is a directory:
    /// every file under <paramref name="directory"/>, at the same depth under the copy.</summary>
    internal static void CopiesASourceDirectory(string directory, string copiedTo)
    {
        var target = Beside(directory, copiedTo);
        foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
        {
            var copy = Path.Combine(target, Path.GetRelativePath(directory, file));
            Directory.CreateDirectory(Path.GetDirectoryName(copy).Require());
            File.Copy(file, copy);
        }
    }

    /// <summary>A path relative to <paramref name="document"/>'s folder, <c>{0}</c> standing for its
    /// file name, with the folders it needs made.</summary>
    internal static string Beside(string document, string relativeTarget)
    {
        var target = Path.Combine(
            Path.GetDirectoryName(document).Require(),
            string.Format(System.Globalization.CultureInfo.InvariantCulture, relativeTarget, Path.GetFileName(document)));
        Directory.CreateDirectory(Path.GetDirectoryName(target).Require());
        return target;
    }

    /// <summary>The user reverting one document to what the repository last saw: a write under the
    /// source tree that git makes rather than Modbench.</summary>
    internal static void RevertsASourceDocument(string modFolder, string plugin, string textItCarries)
    {
        var document = SourceDocumentCarrying(modFolder, plugin, textItCarries);
        GitProbe.Run(
            Path.Combine(modFolder, ".git"), modFolder,
            "restore", "--", Path.GetRelativePath(modFolder, document).Replace('\\', '/'));
    }

    internal static string SourceDocumentCarrying(string modFolder, string plugin, string text) =>
        Directory
            .EnumerateFiles(SourceRepository.RootIn(modFolder, plugin), "*.json", SearchOption.AllDirectories)
            .Single(file => File.ReadAllText(file).Contains(text, StringComparison.Ordinal));
}
