using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// ADR-0041: Track generates <c>.gitignore</c> from the chosen preset. Edits (default for
/// downloaded mods) ignores everything except the source; Everything additionally tracks assets.
/// Plugin binaries are ignored in both presets — they are
/// compiled artifacts, never written by this module. <c>meta.ini</c> is excluded in both, too
/// (ADR-0041 amendment: "never track a file that changes for non-content reasons") — asserted
/// against the committed tree itself, not just the generated text, with a sibling source file as
/// the positive control through the identical query path.
/// </summary>
public sealed class SourceRepositoryTrackGitignoreTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-track-gitignore-").FullName;

    private static PristineFile SourceFile() =>
        new(Path.Combine("source", "Test.esp", "npc_", "Test.esp", "000001.json"), "{}"u8.ToArray());

    private static void WriteMetaIniBesideTheSource(string modFolder) =>
        File.WriteAllText(Path.Combine(modFolder, "meta.ini"), "[General]\nversion=1.0\n");

    private static void WritePluginBinaryBesideTheSource(string modFolder) =>
        File.WriteAllBytes(Path.Combine(modFolder, "Test.esp"), [0x01, 0x02]);

    [Theory]
    [InlineData(SourcePreset.Edits)]
    [InlineData(SourcePreset.Everything)]
    public void Track_ExcludesMetaIniAndPluginBinaryFromTheCommit_RegardlessOfPreset(SourcePreset preset)
    {
        var modFolder = NewModFolder();
        try
        {
            WriteMetaIniBesideTheSource(modFolder);
            WritePluginBinaryBesideTheSource(modFolder);

            SourceRepository.Track(modFolder, preset, [SourceFile()], new TrackProvenance(null, null, new Dictionary<string, string>()));

            var gitDir = Path.Combine(modFolder, ".git");
            var committedPaths = GitCli.Run(gitDir, modFolder, "ls-tree", "-r", "--name-only", "main");

            // Positive control: the sibling source file the same commit really carries, checked
            // through the identical `ls-tree` query — proves absence below means "excluded", not
            // "the commit is empty" or "the query is wrong".
            Assert.Contains("source/Test.esp/npc_/Test.esp/000001.json", committedPaths);

            Assert.DoesNotContain("meta.ini", committedPaths);
            Assert.DoesNotContain("Test.esp\n", committedPaths + "\n");

            // Belt and braces: git itself agrees these paths are ignored, not merely never staged.
            Assert.True(GitCli.TryRun(gitDir, modFolder, out _, "check-ignore", "meta.ini"));
            Assert.True(GitCli.TryRun(gitDir, modFolder, out _, "check-ignore", "Test.esp"));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Track_EditsPreset_IgnoresEverythingExceptTheSource()
    {
        var modFolder = NewModFolder();
        try
        {
            File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "not really a texture");

            SourceRepository.Track(modFolder, SourcePreset.Edits, [SourceFile()], new TrackProvenance(null, null, new Dictionary<string, string>()));

            var gitDir = Path.Combine(modFolder, ".git");
            var committedPaths = GitCli.Run(gitDir, modFolder, "ls-tree", "-r", "--name-only", "main");
            Assert.Contains("source/Test.esp/npc_/Test.esp/000001.json", committedPaths);
            Assert.DoesNotContain("texture.dds", committedPaths);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    // The Edits pattern is root-anchored to the exact literal "source", not "*source*" — an
    // ordinary top-level folder that merely happens to end with "source" must stay ignored (the
    // over-match hazard a suffix pattern would reintroduce).
    [Fact]
    public void Track_EditsPreset_DoesNotUnignoreATopLevelFolderThatMerelyEndsWithSource()
    {
        var modFolder = NewModFolder();
        try
        {
            Directory.CreateDirectory(Path.Combine(modFolder, "MySource"));
            File.WriteAllText(Path.Combine(modFolder, "MySource", "notes.txt"), "notes");

            SourceRepository.Track(modFolder, SourcePreset.Edits, [SourceFile()], new TrackProvenance(null, null, new Dictionary<string, string>()));

            var gitDir = Path.Combine(modFolder, ".git");
            var committedPaths = GitCli.Run(gitDir, modFolder, "ls-tree", "-r", "--name-only", "main");
            Assert.DoesNotContain("MySource", committedPaths);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    // The Edits preset repo tracks exactly .gitignore + source/**. Every test above
    // only probes a couple of paths with Contains/DoesNotContain — that style would pass even if
    // one unexpected extra file leaked into the commit alongside a correctly-included/-excluded
    // probe pair. This asserts the whole committed set, exactly, for a fixture that mixes every
    // kind of thing the Edits preset must reject (meta.ini, a plugin binary, an ordinary asset, a
    // top-level folder that merely ends with "source") alongside two real plugins' source trees,
    // so "exactly" is checked against a representative mix, not a single-file happy path.
    [Fact]
    public void Track_EditsPreset_TracksExactlyGitignorePlusTheWholeSourceTree_NothingElse()
    {
        var modFolder = NewModFolder();
        try
        {
            WriteMetaIniBesideTheSource(modFolder);
            WritePluginBinaryBesideTheSource(modFolder);
            File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "not really a texture");
            Directory.CreateDirectory(Path.Combine(modFolder, "MySource"));
            File.WriteAllText(Path.Combine(modFolder, "MySource", "notes.txt"), "notes");

            var otherPluginFile = new PristineFile(
                Path.Combine("source", "Other.esp", "npc_", "Other.esp", "000002.json"), "{}"u8.ToArray());

            SourceRepository.Track(
                modFolder, SourcePreset.Edits, [SourceFile(), otherPluginFile],
                new TrackProvenance(null, null, new Dictionary<string, string>()));

            var gitDir = Path.Combine(modFolder, ".git");
            var committedPaths = GitCli
                .Run(gitDir, modFolder, "ls-tree", "-r", "--name-only", "main")
                .Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .OrderBy(p => p, StringComparer.Ordinal)
                .ToArray();

            Assert.Equal(
                new[]
                {
                    ".gitignore",
                    "source/Other.esp/npc_/Other.esp/000002.json",
                    "source/Test.esp/npc_/Test.esp/000001.json",
                }.OrderBy(p => p, StringComparer.Ordinal),
                committedPaths);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Track_EverythingPreset_TracksAssetsButStillIgnoresThePluginBinary()
    {
        var modFolder = NewModFolder();
        try
        {
            File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "not really a texture");
            WritePluginBinaryBesideTheSource(modFolder);

            SourceRepository.Track(modFolder, SourcePreset.Everything, [SourceFile()], new TrackProvenance(null, null, new Dictionary<string, string>()));

            var gitDir = Path.Combine(modFolder, ".git");
            var committedPaths = GitCli.Run(gitDir, modFolder, "ls-tree", "-r", "--name-only", "main");
            Assert.Contains("texture.dds", committedPaths);
            Assert.DoesNotContain("Test.esp\n", committedPaths + "\n");
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
