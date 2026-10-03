using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>A plugin's whole source as the carrier Track hands in — relative path and bytes — at the
/// working tree or at a named ref. What compile takes instead of a directory.</summary>
public sealed class SourceRepositoryFilesOfTests : IDisposable
{
    private const string PluginName = "FilesOf.esp";
    private const string NpcFormKey = "000800:FilesOf.esp";
    private const string NpcEditorId = "FixtureNpc";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:FilesOf.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";

    private static readonly PluginAddress Plugin = new(PluginName, "FilesOfMod");
    private static readonly RecordIdentity Npc = new(NpcFormKey, "npc_", NpcEditorId);

    private readonly ScratchDirectory _modFolder = new("medit-filesof-");

    // Tracked with the header alone, then the NPC written through the repository's own door so its
    // file lands where the tree's placement puts it, and committed: both refs then hold the tree.
    public SourceRepositoryFilesOfTests()
    {
        PluginBaselines.Track(
            _modFolder,
            SourcePreset.Edits,
            [new TreeFile(SourceRepository.HeaderDocumentFor(PluginName), "{\"MasterReferences\": []}"u8.ToArray())]);
        Repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody));
        Git("add", "-A");
        Git("commit", "-q", "-m", "the fixture's npc");
    }

    public void Dispose() => _modFolder.Dispose();

    private string Git(params string[] args) =>
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private SourceRepository Repository =>
        SourceRepository.Open(_modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private string NpcRelativePath =>
        Repository.RelativePathOf(Plugin, Npc)
            ?? throw new InvalidOperationException($"Expected the tree to hold {NpcFormKey}.");

    private string NpcFullPath => Path.Combine(_modFolder, NpcRelativePath);

    private List<string> PathsOnDisk() =>
        [.. Directory.EnumerateFiles(
                Path.Combine(_modFolder, SourceRepository.RootFor(PluginName)), "*", SearchOption.AllDirectories)
            .Select(file => Path.GetRelativePath(_modFolder, file))
            .Order(StringComparer.Ordinal)];

    [Fact]
    public void FilesOf_AnswersEveryFileUnderThePluginsSourceRoot_WithItsOwnBytes()
    {
        var files = Repository.FilesOf(Plugin).Files;

        Assert.Equal(PathsOnDisk(), [.. files.Select(f => f.RelativePath).Order(StringComparer.Ordinal)]);
        var npc = files.Single(f => f.RelativePath == NpcRelativePath);
        Assert.Equal(File.ReadAllBytes(NpcFullPath), npc.Content);
    }

    // One repository spans a write and the reads around it, so the file memo a write leaves behind
    // would answer about the tree as it stood.
    [Fact]
    public void FilesOf_AfterAPutThroughTheSameRepository_AnswersTheTreeAsItNowStands()
    {
        var repository = Repository;
        var before = repository.FilesOf(Plugin).Files.Count;

        repository.Put(
            Plugin,
            new SourceDocument(
                "000950:FilesOf.esp", "npc_", "MemoNpc",
                "{\n  \"FormKey\": \"000950:FilesOf.esp\",\n  \"EditorID\": \"MemoNpc\"\n}"));

        Assert.Equal(before + 1, repository.FilesOf(Plugin).Files.Count);
    }

    // Half a tree is the one answer that must not escape: a caller cannot tell it from a smaller tree,
    // and compiling it writes a binary missing records.
    [Fact]
    public void FilesOf_WhenAFileCannotBeRead_NamesThatFile_AndAnswersNoFiles()
    {
        var npcRelativePath = NpcRelativePath;
        using var held = new FileStream(NpcFullPath, FileMode.Open, FileAccess.Read, FileShare.None);

        var files = Repository.FilesOf(Plugin);

        Assert.Equal(npcRelativePath, files.Unreadable);
        Assert.Empty(files.Files);
    }

    [Fact]
    public void FilesOf_ForAPluginTheTreeHoldsNoSourceFor_IsEmpty()
    {
        var stranger = new PluginAddress("Stranger.esp", Plugin.Origin);

        Assert.Empty(Repository.FilesOf(stranger).Files);
    }
}
