using MEditService.SourceRepo;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.TestSupport;

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

    internal static string SourceDocumentCarrying(string modFolder, string plugin, string text) =>
        Directory
            .EnumerateFiles(SourceRepository.RootIn(modFolder, plugin), "*.json", SearchOption.AllDirectories)
            .Single(file => File.ReadAllText(file).Contains(text, StringComparison.Ordinal));
}
