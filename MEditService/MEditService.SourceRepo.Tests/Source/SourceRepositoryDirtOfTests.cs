using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>The tree's dirt as DirtOf sees it: which record an unstaged edit moved, and what a git
/// path under the plugin's own tree that names no record defers to (ADR-0003).</summary>
public sealed class SourceRepositoryDirtOfTests : IDisposable
{
    private const string PluginName = "Test.esp";
    private const string NpcFormKey = "000800:Test.esp";
    private const string NpcEditorId = "FixtureNpc";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";
    private const string EditedBody = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"Edited\"\n}";

    private static readonly PluginCopyKey Plugin = new(PluginName, "TestMod");
    private static readonly GameRelease Release = GameRelease.Fallout4;

    // Spelled from the fixture's own constants rather than asked of the repository, matching
    // SourceRepositoryReadAllTests: Track needs it before any repository exists to ask.
    private static readonly string NpcRelativePath =
        Path.Combine("source", PluginName, "Npcs", $"{NpcEditorId} - 000800_{PluginName}.json");

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-dirtof-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
    }

    private SourceRepository Tracked(params TreeFile[] extraFiles)
    {
        var files = new[] { new TreeFile(NpcRelativePath, Encoding.UTF8.GetBytes(NpcBody)) }.Concat(extraFiles).ToArray();
        SourceRepository.Track(
            _modFolder, SourcePreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>()));
        return SourceRepository.Open(_modFolder, Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
    }

    [Fact]
    public void DirtOf_ReportsAnUnstagedEdit_ToAFileTrackAlreadyCommitted()
    {
        var repository = Tracked();

        // Plain unstaged edit — never `git add`ed. Put and a hand edit alike never stage, so a
        // rival that only checked the git index would report this clean.
        File.WriteAllText(Path.Combine(_modFolder, NpcRelativePath), EditedBody);

        var dirt = repository.DirtOf(Plugin);

        var only = Assert.Single(dirt.Documents);
        Assert.Equal(NpcFormKey, only.FormKey);
        Assert.True(only.InWorkingTree);
        Assert.Equal(NpcBody, only.CommittedText);
        Assert.False(dirt.NeedsStructuralPass);
    }

    [Fact]
    public void DirtOf_ReportsNothing_ForACleanRepo()
    {
        var repository = Tracked();

        var dirt = repository.DirtOf(Plugin);

        Assert.Empty(dirt.Documents);
        Assert.False(dirt.NeedsStructuralPass);
    }

    [Fact]
    public void DirtOf_AWorkingTreeDeletion_NamesTheRecordAsGoneFromTheTree()
    {
        var repository = Tracked();

        File.Delete(Path.Combine(_modFolder, NpcRelativePath));

        var dirt = repository.DirtOf(Plugin);

        var only = Assert.Single(dirt.Documents);
        Assert.Equal(NpcFormKey, only.FormKey);
        Assert.False(only.InWorkingTree);
        Assert.Equal(NpcBody, only.CommittedText);
    }

    // The ordinary shape of a create: Put never runs git add, so the file is untracked and no ref
    // holds its text yet.
    [Fact]
    public void DirtOf_ADocumentNoRefHolds_NamesItWithNoCommittedText()
    {
        var repository = Tracked();
        // The Npcs folder Track already committed NpcRelativePath under, so no directory is minted.
        var createdPath = Path.Combine("source", PluginName, "Npcs", $"Created - 000900_{PluginName}.json");
        File.WriteAllText(
            Path.Combine(_modFolder, createdPath), $"{{\"FormKey\":\"000900:{PluginName}\",\"EditorID\":\"Created\"}}");

        var dirt = repository.DirtOf(Plugin);

        var only = Assert.Single(dirt.Documents);
        Assert.Equal($"000900:{PluginName}", only.FormKey);
        Assert.True(only.InWorkingTree);
        Assert.Null(only.CommittedText);
    }

    // The rival: a container path (too many segments to be one record's own file) must defer to
    // the structural pass, never get guessed at as a record.
    [Fact]
    public void DirtOf_DefersAnUnparseablePathUnderThePluginsTree_ToTheStructuralPass_NeverAsARecord()
    {
        var containerPath = Path.Combine("source", PluginName, "Npcs", PluginName, "000900.json");
        var repository = Tracked(new TreeFile(containerPath, "{}"u8.ToArray()));

        File.WriteAllText(Path.Combine(_modFolder, containerPath), "{\"changed\":true}");

        var dirt = repository.DirtOf(Plugin);

        Assert.Empty(dirt.Documents);
        Assert.True(dirt.NeedsStructuralPass);
    }
}
