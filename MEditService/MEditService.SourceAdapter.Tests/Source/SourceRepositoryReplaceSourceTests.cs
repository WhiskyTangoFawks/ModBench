using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Decompile's write: one plugin's source in the working tree replaced whole, or left as it
/// was (commands.md, A failed gesture writes nothing).</summary>
public sealed class SourceRepositoryReplaceSourceTests : IDisposable
{
    private const string Plugin = "A.esp";
    private const string Sha = "ABCDEF0123";
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-replace-source-").FullName;

    public SourceRepositoryReplaceSourceTests() =>
        PluginBaselines.Track(_modFolder, SourcePreset.Edits, [File("npc_/A.esp/000001.json", "{\"was\":1}")]);

    public void Dispose() => Directory.Delete(_modFolder, recursive: true);

    [Fact]
    public void ReplaceSourceFrom_LeavesExactlyTheNewFiles_AndParksTheBinaryAlone()
    {
        Repository.ReplaceSourceFrom(Plugin, [File("npc_/A.esp/000002.json", "{\"now\":2}")], Sha);

        Assert.Equal(["npc_/A.esp/000002.json"], FilesUnderRoot());
        Assert.Equal([Sha], SourceRepository.ParkedCompileBinarySha256s(_modFolder, Plugin));
        Assert.Equal(" D plugin-source/A.esp/npc_/A.esp/000001.json", Git("status", "--porcelain", "--untracked-files=no").TrimEnd('\n'));
    }

    [Fact]
    public void ReplaceSourceFrom_AFileThatCannotBeWritten_LeavesTheSourceAndTheRefAsTheyWere()
    {
        var refBefore = Git("rev-parse", SourceRepository.LastCompileRef(Plugin));

        // The first file lands where the second needs a directory.
        Assert.ThrowsAny<IOException>(() => Repository.ReplaceSourceFrom(
            Plugin, [File("npc_", "{}"), File("npc_/A.esp/000002.json", "{}")], Sha));

        Assert.Equal(["npc_/A.esp/000001.json"], FilesUnderRoot());
        Assert.Equal("{\"was\":1}", System.IO.File.ReadAllText(Path.Combine(Root, "npc_", "A.esp", "000001.json")));
        Assert.Equal(refBefore, Git("rev-parse", SourceRepository.LastCompileRef(Plugin)));
    }

    private SourceRepository Repository =>
        SourceRepository.Open(_modFolder, GameRelease.Fallout4) ?? throw new InvalidOperationException("Expected the fixture tracked.");

    private string Root => SourceRepository.RootIn(_modFolder, Plugin);

    private static TreeFile File(string underRoot, string text) =>
        new($"plugin-source/{Plugin}/{underRoot}", System.Text.Encoding.UTF8.GetBytes(text));

    private string[] FilesUnderRoot() =>
        [.. Directory.EnumerateFiles(Root, "*", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(Root, path).Replace('\\', '/'))
            .Order(StringComparer.Ordinal)];

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
